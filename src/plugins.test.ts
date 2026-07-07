import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { createPluginHost } from "./plugins";
import type {
  BodySaveResult,
  ErrorRecord,
  HookEvent,
  LoggerStorage,
  RequestBodySaveResult,
  RequestState,
  WebSocketFrameRecord,
} from "./types";

const createResponseEvent = (runDirectory: string): HookEvent => ({
  event: "response.completed",
  request: {
    method: "GET",
    requestId: "request-1",
    sessionId: "session-1",
    url: "https://example.test/api",
  },
  response: {
    bodyFile: "bodies/response.json",
    bodyLength: 11,
    bodySaved: true,
    bodySha256: "hash",
    mimeType: "application/json",
    status: 200,
  },
  run: {
    runDirectory,
    runTimestamp: "2026-07-06T12:34:56Z",
  },
  target: {
    targetId: "target-1",
    targetType: "page",
    targetUrl: "https://example.test",
  },
  timestamp: "2026-07-06T12:34:57Z",
  version: 1,
});

const createStorage = (runDirectory: string): LoggerStorage & { errors: ErrorRecord[] } => {
  const errors: ErrorRecord[] = [];

  return {
    close: vi.fn(() => Promise.resolve()),
    errors,
    recordBody: vi.fn(
      (): Promise<BodySaveResult & { base64Encoded: boolean }> =>
        Promise.resolve({ base64Encoded: false, bodySaved: true }),
    ),
    recordCompletedResponse: vi.fn(() => Promise.resolve()),
    recordError: vi.fn((error) => {
      errors.push(error);
      return Promise.resolve();
    }),
    recordRequestBody: vi.fn(
      (_state: RequestState): Promise<RequestBodySaveResult> =>
        Promise.resolve({ bodySaved: true, source: "requestWillBeSent" }),
    ),
    recordWebSocketFrame: vi.fn((_frame: WebSocketFrameRecord) => Promise.resolve()),
    runDirectory,
    runTimestamp: "2026-07-06T12:34:56Z",
  };
};

describe("createPluginHost", () => {
  it("loads a TS plugin and publishes path-based response events", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cdp-response-logger-plugin-"));
    const runDirectory = join(dir, "run");
    await writeFile(
      join(dir, "config.ts"),
      `export default {
      plugins: [{ module: "./json-api-mirror.ts" }]
    };`,
    );
    await writeFile(
      join(dir, "json-api-mirror.ts"),
      `
      import { mkdir, readFile, writeFile } from "node:fs/promises";
      import { dirname } from "node:path";
      import type { LoggerPlugin } from "chrome-network-logger";

      export default {
        id: "json-api-mirror",
        name: "JSON API Mirror",
        version: "0.1.0",
        events: ["response.completed"],
        async onEvent(event, ctx) {
          if (event.event !== "response.completed") return;
          const source = ctx.resolveRunPath(event.response.bodyFile);
          const output = ctx.resolvePluginPath("last.json");
          await mkdir(dirname(output), { recursive: true });
          await writeFile(output, await readFile(source, "utf8"));
        },
      } satisfies LoggerPlugin;
    `,
    );
    await mkdir(join(runDirectory, "bodies"), { recursive: true });
    await writeFile(join(runDirectory, "bodies", "response.json"), `{"ok":true}`);

    const storage = createStorage(runDirectory);
    const host = await createPluginHost({
      configPath: join(dir, "config.ts"),
      disabled: false,
      storage,
      verbose: false,
    });

    await host.publish(createResponseEvent(runDirectory));
    await host.close();

    await expect(
      readFile(join(runDirectory, "plugins", "json-api-mirror", "last.json"), "utf8"),
    ).resolves.toBe(`{"ok":true}`);
    expect(storage.errors).toEqual([]);
  });

  it("fails startup on duplicate plugin IDs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cdp-response-logger-plugin-"));
    await writeFile(
      join(dir, "config.ts"),
      `export default {
      plugins: [
        { module: "./one.ts" },
        { module: "./two.ts" },
      ],
    };`,
    );
    const plugin = `export default {
      id: "duplicate-plugin",
      version: "0.1.0",
      events: ["response.completed"],
      onEvent() {},
    };`;
    await writeFile(join(dir, "one.ts"), plugin);
    await writeFile(join(dir, "two.ts"), plugin);

    await expect(
      createPluginHost({
        configPath: join(dir, "config.ts"),
        disabled: false,
        storage: createStorage(join(dir, "run")),
        verbose: false,
      }),
    ).rejects.toThrow("Duplicate plugin id: duplicate-plugin");
  });

  it("rejects zero timeout plugin config", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cdp-response-logger-plugin-"));
    await writeFile(
      join(dir, "config.ts"),
      `export default {
      plugins: [{ module: "./plugin.ts", timeoutMs: 0 }],
    };`,
    );
    await writeFile(
      join(dir, "plugin.ts"),
      `export default {
      id: "timeout-plugin",
      version: "0.1.0",
      events: ["response.completed"],
      onEvent() {},
    };`,
    );

    await expect(
      createPluginHost({
        configPath: join(dir, "config.ts"),
        disabled: false,
        storage: createStorage(join(dir, "run")),
        verbose: false,
      }),
    ).rejects.toThrow();
  });

  it("records plugin queue overflow and timeout errors without throwing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cdp-response-logger-plugin-"));
    const runDirectory = join(dir, "run");
    await writeFile(
      join(dir, "config.ts"),
      `export default {
      plugins: [{ module: "./slow.ts", queueSize: 1, timeoutMs: 1 }]
    };`,
    );
    await writeFile(
      join(dir, "slow.ts"),
      `export default {
      id: "slow-plugin",
      version: "0.1.0",
      events: ["response.completed"],
      onEvent() {
        return new Promise(() => {});
      },
    };`,
    );
    const storage = createStorage(runDirectory);
    const host = await createPluginHost({
      configPath: join(dir, "config.ts"),
      disabled: false,
      storage,
      verbose: false,
    });
    const event = createResponseEvent(runDirectory);

    await host.publish(event);
    await host.publish(event);
    await host.publish(event);
    await host.close();

    expect(storage.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event: "Plugin.queueOverflow", pluginId: "slow-plugin" }),
        expect.objectContaining({ event: "Plugin.onEvent", pluginId: "slow-plugin" }),
      ]),
    );
  });
});
