import { mkdir } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { z } from "zod";

import type {
  CompletedResponseMetadata,
  ErrorRecord,
  HookEvent,
  HookEventName,
  HookPublisher,
  LoggerConfig,
  LoggerPlugin,
  LoggerStorage,
  PluginContext,
  RunRef,
  WebSocketFrameRecord,
} from "./types";

const HOOK_EVENT_NAMES = new Set<HookEventName>([
  "run.started",
  "run.stopping",
  "run.stopped",
  "response.completed",
  "websocket.frame.received",
  "capture.error",
]);

const DEFAULT_QUEUE_SIZE = 1000;
const DEFAULT_TIMEOUT_MS = 5000;

const PluginConfigSchema = z.object({
  enabled: z.boolean().optional(),
  module: z.string().min(1),
  options: z.unknown().optional(),
  queueSize: z.int().positive().optional(),
  timeoutMs: z.int().positive().optional(),
});

const LoggerConfigSchema: z.ZodType<LoggerConfig> = z.object({
  plugins: z.array(PluginConfigSchema).optional(),
});

type LoadedPlugin = {
  configDirectory: string;
  modulePath: string;
  options: unknown;
  plugin: LoggerPlugin;
  queueSize: number;
  timeoutMs: number;
};

type CreatePluginHostOptions = {
  configPath?: string | undefined;
  disabled: boolean;
  storage: LoggerStorage;
  verbose: boolean;
};

const nowIso = (): string => new Date().toISOString();

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const pluginIdRegex = /^[a-z0-9][a-z0-9._-]*$/u;
const semverLikeRegex = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u;

const toImportUrl = (path: string): string => pathToFileURL(path).href;

const resolveFromDirectory = (baseDirectory: string, path: string): string =>
  isAbsolute(path) ? path : resolve(baseDirectory, path);

const assertValidPlugin = (plugin: unknown, modulePath: string): LoggerPlugin => {
  if (!plugin || typeof plugin !== "object") {
    throw new Error(`Plugin ${modulePath} must export a default object.`);
  }

  const candidate = plugin as Partial<LoggerPlugin>;
  if (!candidate.id || !pluginIdRegex.test(candidate.id)) {
    throw new Error(`Plugin ${modulePath} must declare a stable id.`);
  }

  if (!candidate.version || !semverLikeRegex.test(candidate.version)) {
    throw new Error(`Plugin ${candidate.id} must declare a semver-like version.`);
  }

  if (!Array.isArray(candidate.events) || candidate.events.length === 0) {
    throw new Error(`Plugin ${candidate.id} must declare at least one event.`);
  }

  for (const eventName of candidate.events) {
    if (!HOOK_EVENT_NAMES.has(eventName)) {
      throw new Error(`Plugin ${candidate.id} declares unsupported event: ${eventName}`);
    }
  }

  if (typeof candidate.onEvent !== "function") {
    throw new Error(`Plugin ${candidate.id} must declare onEvent().`);
  }

  if (candidate.setup !== undefined && typeof candidate.setup !== "function") {
    throw new Error(`Plugin ${candidate.id} setup must be a function.`);
  }

  if (candidate.close !== undefined && typeof candidate.close !== "function") {
    throw new Error(`Plugin ${candidate.id} close must be a function.`);
  }

  return candidate as LoggerPlugin;
};

const loadConfig = async (configPath: string): Promise<{ config: LoggerConfig; path: string }> => {
  const absolutePath = resolve(process.cwd(), configPath);
  const imported = (await import(toImportUrl(absolutePath))) as { default?: unknown };
  const config = LoggerConfigSchema.parse(imported.default ?? {});

  return { config, path: absolutePath };
};

const loadPlugins = async (configPath: string): Promise<LoadedPlugin[]> => {
  const { config, path } = await loadConfig(configPath);
  const configDirectory = dirname(path);
  const plugins: LoadedPlugin[] = [];
  const pluginIds = new Set<string>();

  for (const pluginConfig of config.plugins ?? []) {
    const enabled = pluginConfig.enabled ?? true;
    if (!enabled) {
      continue;
    }

    const modulePath = resolveFromDirectory(configDirectory, pluginConfig.module);
    const imported = (await import(toImportUrl(modulePath))) as { default?: unknown };
    const plugin = assertValidPlugin(imported.default, modulePath);

    if (pluginIds.has(plugin.id)) {
      throw new Error(`Duplicate plugin id: ${plugin.id}`);
    }
    pluginIds.add(plugin.id);

    plugins.push({
      configDirectory,
      modulePath,
      options: pluginConfig.options,
      plugin,
      queueSize: pluginConfig.queueSize ?? DEFAULT_QUEUE_SIZE,
      timeoutMs: pluginConfig.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
  }

  return plugins;
};

const deepFreeze = <T>(value: T): T => {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }

  for (const propertyValue of Object.values(value)) {
    deepFreeze(propertyValue);
  }

  return Object.freeze(value);
};

const cloneEvent = (event: HookEvent): HookEvent => deepFreeze(structuredClone(event));

const callWithTimeout = async (
  callback: () => unknown | Promise<unknown>,
  timeoutMs: number,
): Promise<void> => {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve().then(callback),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(`Plugin hook timed out after ${timeoutMs}ms.`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
};

class PluginRuntime {
  readonly #context: PluginContext;
  readonly #events: Set<HookEventName>;
  readonly #plugin: LoggerPlugin;
  readonly #queueSize: number;
  readonly #recordError: (record: ErrorRecord) => Promise<void>;
  readonly #timeoutMs: number;
  #closed = false;
  #drainPromise: Promise<void> | undefined;
  #queue: HookEvent[] = [];

  constructor(
    loaded: LoadedPlugin,
    storage: LoggerStorage,
    recordError: (record: ErrorRecord) => Promise<void>,
    verbose: boolean,
  ) {
    const pluginDirectory = join(storage.runDirectory, "plugins", loaded.plugin.id);
    this.#context = {
      configDirectory: loaded.configDirectory,
      error: (error: unknown) => {
        process.stderr.write(`plugin ${loaded.plugin.id}: ${errorMessage(error)}\n`);
      },
      log: (message: string) => {
        process.stdout.write(`plugin ${loaded.plugin.id}: ${message}\n`);
      },
      options: loaded.options,
      pluginDirectory,
      resolvePluginPath: (relativePath: string) => join(pluginDirectory, relativePath),
      resolveRunPath: (relativePath: string) => join(storage.runDirectory, relativePath),
      runDirectory: storage.runDirectory,
      warn: (message: string) => {
        const line = `plugin ${loaded.plugin.id}: ${message}\n`;
        if (verbose) {
          process.stderr.write(line);
        }
      },
    };
    this.#events = new Set(loaded.plugin.events);
    this.#plugin = loaded.plugin;
    this.#queueSize = loaded.queueSize;
    this.#recordError = recordError;
    this.#timeoutMs = loaded.timeoutMs;
  }

  get id(): string {
    return this.#plugin.id;
  }

  async setup(): Promise<void> {
    await mkdir(this.#context.pluginDirectory, { recursive: true });
    if (this.#plugin.setup) {
      await this.#callPlugin("Plugin.setup", () => this.#plugin.setup?.(this.#context));
    }
  }

  async publish(event: HookEvent): Promise<void> {
    if (this.#closed || !this.#events.has(event.event)) {
      return;
    }

    if (this.#queue.length >= this.#queueSize) {
      await this.#recordError({
        error: `Plugin queue overflow; dropped ${event.event}.`,
        event: "Plugin.queueOverflow",
        pluginId: this.#plugin.id,
        timestamp: nowIso(),
      });
      return;
    }

    this.#queue.push(cloneEvent(event));
    this.#drainPromise ??= this.#drain();
  }

  async close(): Promise<void> {
    this.#closed = true;
    await this.#drainPromise;
    if (this.#plugin.close) {
      await this.#callPlugin("Plugin.close", () => this.#plugin.close?.(this.#context));
    }
  }

  async #drain(): Promise<void> {
    try {
      while (this.#queue.length > 0) {
        const event = this.#queue.shift();
        if (!event) {
          continue;
        }

        await this.#callPlugin("Plugin.onEvent", () => this.#plugin.onEvent(event, this.#context));
      }
    } finally {
      this.#drainPromise = undefined;
      if (this.#queue.length > 0 && !this.#closed) {
        this.#drainPromise = this.#drain();
      }
    }
  }

  async #callPlugin(event: string, callback: () => unknown | Promise<unknown>): Promise<void> {
    try {
      await callWithTimeout(callback, this.#timeoutMs);
    } catch (error) {
      await this.#recordError({
        error: errorMessage(error),
        event,
        pluginId: this.#plugin.id,
        timestamp: nowIso(),
      });
    }
  }
}

class PluginHost implements HookPublisher {
  readonly #runtimes: PluginRuntime[];
  readonly #run: RunRef;

  constructor(runtimes: PluginRuntime[], storage: LoggerStorage) {
    this.#runtimes = runtimes;
    this.#run = {
      runDirectory: storage.runDirectory,
      runTimestamp: storage.runTimestamp,
    };
  }

  async start(): Promise<void> {
    for (const runtime of this.#runtimes) {
      await runtime.setup();
      process.stdout.write(`plugin loaded id=${runtime.id}\n`);
    }

    await this.publish(createRunHookEvent("run.started", this.#run));
  }

  async publish(event: HookEvent): Promise<void> {
    await Promise.all(this.#runtimes.map((runtime) => runtime.publish(event)));
  }

  async close(): Promise<void> {
    await this.publish(createRunHookEvent("run.stopped", this.#run));
    await Promise.all(this.#runtimes.map((runtime) => runtime.close()));
  }

  async stopping(): Promise<void> {
    await this.publish(createRunHookEvent("run.stopping", this.#run));
  }
}

const createRunHookEvent = (
  event: "run.started" | "run.stopping" | "run.stopped",
  run: RunRef,
): HookEvent => ({
  event,
  run,
  timestamp: nowIso(),
  version: 1,
});

const createResponseCompletedHookEvent = (
  metadata: CompletedResponseMetadata,
  runDirectory: string,
): HookEvent => ({
  event: "response.completed",
  request: {
    bodyFile: metadata.requestBodyFile,
    bodyLength: metadata.requestBodyLength,
    bodySaved: metadata.requestBodySaved,
    bodySha256: metadata.requestBodySha256,
    bodySource: metadata.requestBodySource,
    headers: metadata.requestHeaders,
    method: metadata.requestMethod,
    requestId: metadata.requestId,
    sessionId: metadata.sessionId,
    url: metadata.url,
  },
  response: {
    base64Encoded: metadata.base64Encoded,
    bodyFile: metadata.bodyFile,
    bodyLength: metadata.bodyLength,
    bodySaved: metadata.bodySaved,
    bodySha256: metadata.bodySha256,
    encodedDataLength: metadata.encodedDataLength,
    headers: metadata.responseHeaders,
    mimeType: metadata.mimeType,
    status: metadata.status,
    statusText: metadata.statusText,
  },
  run: {
    runDirectory,
    runTimestamp: metadata.runTimestamp,
  },
  target: {
    targetId: metadata.tabTargetId,
    targetType: metadata.targetType,
    targetUrl: metadata.targetUrl,
  },
  timestamp: nowIso(),
  version: 1,
});

const createWebSocketFrameHookEvent = (
  frame: WebSocketFrameRecord,
  storage: LoggerStorage,
): HookEvent => ({
  event: "websocket.frame.received",
  frame,
  run: {
    runDirectory: storage.runDirectory,
    runTimestamp: storage.runTimestamp,
  },
  timestamp: nowIso(),
  version: 1,
});

const createCaptureErrorHookEvent = (error: ErrorRecord, storage: LoggerStorage): HookEvent => ({
  error,
  event: "capture.error",
  run: {
    runDirectory: storage.runDirectory,
    runTimestamp: storage.runTimestamp,
  },
  timestamp: nowIso(),
  version: 1,
});

const createPluginHost = async (options: CreatePluginHostOptions): Promise<PluginHost> => {
  const loadedPlugins =
    !options.disabled && options.configPath ? await loadPlugins(options.configPath) : [];

  const recordPluginError = async (record: ErrorRecord): Promise<void> => {
    await options.storage.recordError(record);
  };

  const runtimes = loadedPlugins.map(
    (loadedPlugin) =>
      new PluginRuntime(loadedPlugin, options.storage, recordPluginError, options.verbose),
  );

  const host = new PluginHost(runtimes, options.storage);
  await host.start();

  return host;
};

export {
  DEFAULT_QUEUE_SIZE,
  DEFAULT_TIMEOUT_MS,
  createCaptureErrorHookEvent,
  createPluginHost,
  createResponseCompletedHookEvent,
  createWebSocketFrameHookEvent,
  loadConfig,
  loadPlugins,
};
