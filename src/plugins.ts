import { mkdir } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type { Protocol } from "devtools-protocol";

import { parseLoggerConfig } from "./config";
import type { LoggerConfig } from "./config";
import type {
	CompletedResponseMetadata,
	DownloadRecord,
	ErrorRecord,
	EventSourceMessageRecord,
	LoggerStorage,
	RequestBodySource,
	RunRef,
	StorageSnapshotCounts,
	WebSocketFrameRecord,
} from "./types";

// The plugin-authoring surface lives with the runtime that loads and calls it.
type MaybePromise<T> = T | Promise<T>;

type HookEventBase = {
	run: RunRef;
	timestamp: string;
	version: 1;
};

// Derived from the events so no plugin can subscribe to a name never published.
type HookEventName = HookEvent["event"];

type RunHookEvent = HookEventBase & { event: "run.started" | "run.stopping" | "run.stopped" };

type ResponseCompletedHookEvent = HookEventBase & {
	event: "response.completed";
	request: {
		bodyFile?: string | undefined;
		bodyLength?: number | undefined;
		bodySaved?: boolean | undefined;
		bodySha256?: string | undefined;
		bodySource?: RequestBodySource | undefined;
		headers?: Protocol.Network.Headers | undefined;
		method?: string | undefined;
		requestId: string;
		sessionId: string;
		url?: string | undefined;
	};
	response: {
		base64Encoded?: boolean | undefined;
		bodyFile?: string | undefined;
		bodyLength?: number | undefined;
		bodySaved: boolean;
		bodySha256?: string | undefined;
		encodedDataLength?: number | undefined;
		headers?: Protocol.Network.Headers | undefined;
		mimeType?: string | undefined;
		redirect?: boolean | undefined;
		redirectIndex?: number | undefined;
		status?: number | undefined;
		statusText?: string | undefined;
	};
	// Written out, not derived from SessionInfo, so no internal field widens it.
	target: {
		targetId?: string | undefined;
		targetType?: string | undefined;
		targetUrl?: string | undefined;
	};
};

type WebSocketFrameHookEvent = HookEventBase & {
	event: `websocket.frame.${WebSocketFrameRecord["direction"]}`;
	frame: WebSocketFrameRecord;
};

type EventSourceMessageHookEvent = HookEventBase & {
	event: "eventsource.message";
	message: EventSourceMessageRecord;
};

// Published for a saved download only: a canceled one has no file to hand a plugin.
type DownloadCompletedHookEvent = HookEventBase & {
	download: DownloadRecord;
	event: "download.completed";
};

// Path-based like every other event: the snapshot file is named and counted only.
// Its contents are session cookies and web storage, so they never go inline.
type StorageSnapshotHookEvent = HookEventBase & {
	counts: StorageSnapshotCounts;
	event: "storage.snapshot";
	file: string;
	truncated: boolean;
};

type CaptureErrorHookEvent = HookEventBase & { error: ErrorRecord; event: "capture.error" };

type HookEvent =
	| CaptureErrorHookEvent
	| DownloadCompletedHookEvent
	| EventSourceMessageHookEvent
	| ResponseCompletedHookEvent
	| RunHookEvent
	| StorageSnapshotHookEvent
	| WebSocketFrameHookEvent;

type HookPublisher = {
	close: () => Promise<void>;
	publish: (event: HookEvent) => Promise<void>;
};

type PluginContext = {
	configDirectory: string;
	error: (error: unknown) => void;
	log: (message: string) => void;
	options: unknown;
	pluginDirectory: string;
	resolvePluginPath: (relativePath: string) => string;
	resolveRunPath: (relativePath: string) => string;
	runDirectory: string;
	warn: (message: string) => void;
};

type LoggerPlugin = {
	close?: (context: PluginContext) => MaybePromise<void>;
	events: HookEventName[];
	id: string;
	name?: string | undefined;
	onEvent: (event: HookEvent, context: PluginContext) => MaybePromise<void>;
	setup?: (context: PluginContext) => MaybePromise<void>;
	version: string;
};

const HOOK_EVENT_NAMES = new Set<HookEventName>([
	"run.started",
	"run.stopping",
	"run.stopped",
	"response.completed",
	"websocket.frame.received",
	"websocket.frame.sent",
	"eventsource.message",
	"download.completed",
	"storage.snapshot",
	"capture.error",
]);

const DEFAULT_QUEUE_SIZE = 1000;
const DEFAULT_TIMEOUT_MS = 5000;

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

// Every hook event carries the same three fields, and one builder had already drifted.
// Building them in one place is what keeps a version bump or a new field from missing one.
const hookEventBase = (storage: RunRef): HookEventBase => ({
	run: { runDirectory: storage.runDirectory, runTimestamp: storage.runTimestamp },
	timestamp: nowIso(),
	version: 1,
});

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
	const config = parseLoggerConfig(imported.default);

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
	// Set by close() only: the moment the whole shutdown drain stops taking new events.
	#deadline: number | undefined;
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
		this.#drainPromise ??= this.#startDrain();
	}

	// One call is bounded by callWithTimeout, and nothing bounded the backlog behind it.
	// A full queue of slow calls held shutdown for queueSize times timeoutMs.
	// That is minutes at the defaults, with the writers open and the summary unprinted.
	// The whole drain therefore gets one budget, the same one a single call gets.
	async close(): Promise<void> {
		this.#closed = true;
		this.#deadline = Date.now() + this.#timeoutMs;
		// A drain that restarted for the events still queued has to finish here too.
		while (this.#drainPromise !== undefined) {
			await this.#drainPromise;
		}
		await this.#recordDroppedQueue();
		if (this.#plugin.close) {
			await this.#callPlugin("Plugin.close", () => this.#plugin.close?.(this.#context));
		}
	}

	// Only close() sets a deadline, so nothing bounds the drain during capture.
	#expired(): boolean {
		return this.#deadline !== undefined && Date.now() >= this.#deadline;
	}

	// A drained event only has the deadline checked before it starts.
	// One starting just before it would otherwise hold close() for a whole timeout more.
	// The shutdown budget therefore caps the call itself, down to nothing left at all.
	#drainTimeout(): number {
		if (this.#deadline === undefined) {
			return this.#timeoutMs;
		}

		return Math.max(this.#deadline - Date.now(), 0);
	}

	// What the budget left behind is dropped here, while errors.ndjson is still open.
	// The loss is then visible rather than silent.
	async #recordDroppedQueue(): Promise<void> {
		const dropped = this.#queue.length;
		if (dropped === 0) {
			return;
		}

		this.#queue = [];
		try {
			await this.#recordError({
				error: `Plugin shutdown exceeded ${this.#timeoutMs}ms; dropped ${dropped} queued event(s).`,
				event: "Plugin.shutdownTimeout",
				pluginId: this.#plugin.id,
				timestamp: nowIso(),
			});
		} catch {
			// A failed error record must not skip the plugin's own close() as well.
		}
	}

	// Nothing awaits the stored promise until close(), so a rejection would be unhandled.
	// It would take the whole process down, skipping the run's own shutdown and summary.
	// The only way #drain rejects is a failed errors.ndjson write, which must not do that.
	#startDrain(): Promise<void> {
		return this.#drain().catch(() => undefined);
	}

	async #drain(): Promise<void> {
		try {
			while (this.#queue.length > 0 && !this.#expired()) {
				const event = this.#queue.shift();
				if (!event) {
					continue;
				}

				await this.#callPlugin(
					"Plugin.onEvent",
					() => this.#plugin.onEvent(event, this.#context),
					this.#drainTimeout(),
				);
			}
		} finally {
			this.#drainPromise = undefined;
			// The drain restarts even while closing.
			// One that stopped on a failed error record would drop the rest without recording it.
			// The shutdown budget is what ends the restarts, not the close() call itself.
			if (this.#queue.length > 0 && !this.#expired()) {
				this.#drainPromise = this.#startDrain();
			}
		}
	}

	async #callPlugin(
		event: string,
		callback: () => unknown | Promise<unknown>,
		timeoutMs: number = this.#timeoutMs,
	): Promise<void> {
		try {
			await callWithTimeout(callback, timeoutMs);
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
	...hookEventBase(run),
	event,
});

const createResponseCompletedHookEvent = (
	metadata: CompletedResponseMetadata,
	storage: LoggerStorage,
): HookEvent => ({
	...hookEventBase(storage),
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
		redirect: metadata.redirect,
		redirectIndex: metadata.redirectIndex,
		status: metadata.status,
		statusText: metadata.statusText,
	},
	target: {
		targetId: metadata.tabTargetId,
		targetType: metadata.targetType,
		targetUrl: metadata.targetUrl,
	},
});

const createWebSocketFrameHookEvent = (
	frame: WebSocketFrameRecord,
	storage: LoggerStorage,
): HookEvent => ({
	...hookEventBase(storage),
	event: frame.direction === "sent" ? "websocket.frame.sent" : "websocket.frame.received",
	frame,
});

const createEventSourceMessageHookEvent = (
	message: EventSourceMessageRecord,
	storage: LoggerStorage,
): HookEvent => ({
	...hookEventBase(storage),
	event: "eventsource.message",
	message,
});

// Path-based like every other hook event: the record names the saved file, never its bytes.
const createDownloadCompletedHookEvent = (
	download: DownloadRecord,
	storage: LoggerStorage,
): HookEvent => ({
	...hookEventBase(storage),
	download,
	event: "download.completed",
});

// The snapshot holds live credentials, so only its path and its totals travel here.
const createStorageSnapshotHookEvent = (
	file: string,
	counts: StorageSnapshotCounts,
	truncated: boolean,
	storage: LoggerStorage,
): HookEvent => ({
	...hookEventBase(storage),
	counts,
	event: "storage.snapshot",
	file,
	truncated,
});

const createCaptureErrorHookEvent = (error: ErrorRecord, storage: LoggerStorage): HookEvent => ({
	...hookEventBase(storage),
	error,
	event: "capture.error",
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
	createDownloadCompletedHookEvent,
	createEventSourceMessageHookEvent,
	createPluginHost,
	createResponseCompletedHookEvent,
	createStorageSnapshotHookEvent,
	createWebSocketFrameHookEvent,
	loadConfig,
	loadPlugins,
};
export type {
	CaptureErrorHookEvent,
	DownloadCompletedHookEvent,
	EventSourceMessageHookEvent,
	HookEvent,
	HookEventName,
	HookPublisher,
	LoggerPlugin,
	MaybePromise,
	PluginContext,
	ResponseCompletedHookEvent,
	RunHookEvent,
	StorageSnapshotHookEvent,
	WebSocketFrameHookEvent,
};
