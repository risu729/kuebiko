import { describe, expect, it, mock } from "bun:test";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

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

const packageEntryUrl = pathToFileURL(join(process.cwd(), "src/index.ts")).href;

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
		close: mock(() => Promise.resolve()),
		errors,
		recordBody: mock(
			(): Promise<BodySaveResult & { base64Encoded: boolean }> =>
				Promise.resolve({ base64Encoded: false, bodySaved: true }),
		),
		recordCompletedResponse: mock(() => Promise.resolve()),
		recordError: mock((error) => {
			errors.push(error);
			return Promise.resolve();
		}),
		recordRequestBody: mock(
			(_state: RequestState): Promise<RequestBodySaveResult> =>
				Promise.resolve({ bodySaved: true, source: "requestWillBeSent" }),
		),
		recordWebSocketFrame: mock((_frame: WebSocketFrameRecord) => Promise.resolve()),
		runDirectory,
		runTimestamp: "2026-07-06T12:34:56Z",
	};
};

describe("createPluginHost", () => {
	it("loads a TS plugin and publishes path-based response events", async () => {
		const dir = await mkdtemp(join(tmpdir(), "kuebiko-plugin-"));
		const runDirectory = join(dir, "run");
		await Bun.write(
			join(dir, "config.ts"),
			`import { defineConfig } from ${JSON.stringify(packageEntryUrl)};

export default defineConfig({
      plugins: [{ module: "./json-api-mirror.ts" }]
    });`,
		);
		await Bun.write(
			join(dir, "json-api-mirror.ts"),
			`
      import { mkdir } from "node:fs/promises";
      import { dirname } from "node:path";
      import type { LoggerPlugin } from "kuebiko";

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
          await Bun.write(output, Bun.file(source));
        },
      } satisfies LoggerPlugin;
    `,
		);
		await mkdir(join(runDirectory, "bodies"), { recursive: true });
		await Bun.write(join(runDirectory, "bodies", "response.json"), `{"ok":true}`);

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
			Bun.file(join(runDirectory, "plugins", "json-api-mirror", "last.json")).text(),
		).resolves.toBe(`{"ok":true}`);
		expect(storage.errors).toEqual([]);
	});

	it("fails startup on duplicate plugin IDs", async () => {
		const dir = await mkdtemp(join(tmpdir(), "kuebiko-plugin-"));
		await Bun.write(
			join(dir, "config.ts"),
			`import { defineConfig } from ${JSON.stringify(packageEntryUrl)};

export default defineConfig({
      plugins: [
        { module: "./one.ts" },
        { module: "./two.ts" },
      ],
    });`,
		);
		const plugin = `export default {
      id: "duplicate-plugin",
      version: "0.1.0",
      events: ["response.completed"],
      onEvent() {},
    };`;
		await Bun.write(join(dir, "one.ts"), plugin);
		await Bun.write(join(dir, "two.ts"), plugin);

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
		const dir = await mkdtemp(join(tmpdir(), "kuebiko-plugin-"));
		await Bun.write(
			join(dir, "config.ts"),
			`import { defineConfig } from ${JSON.stringify(packageEntryUrl)};

export default defineConfig({
      plugins: [{ module: "./plugin.ts", timeoutMs: 0 }],
    });`,
		);
		await Bun.write(
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
		const dir = await mkdtemp(join(tmpdir(), "kuebiko-plugin-"));
		const runDirectory = join(dir, "run");
		await Bun.write(
			join(dir, "config.ts"),
			`import { defineConfig } from ${JSON.stringify(packageEntryUrl)};

export default defineConfig({
      plugins: [{ module: "./slow.ts", queueSize: 1, timeoutMs: 1 }]
    });`,
		);
		await Bun.write(
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
