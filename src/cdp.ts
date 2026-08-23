import { resolve as resolvePath } from "node:path";

import CDP from "chrome-remote-interface";
import type { Protocol } from "devtools-protocol";

import { DOWNLOADS_DIRECTORY } from "./constants";
import {
	createCaptureErrorHookEvent,
	createDownloadCompletedHookEvent,
	createEventSourceMessageHookEvent,
	createResponseCompletedHookEvent,
	createStorageSnapshotHookEvent,
	createWebSocketFrameHookEvent,
} from "./plugins";
import type { HookPublisher } from "./plugins";
import { matchesFilters } from "./sanitize";
import { countStorageSnapshot } from "./summary";
import type {
	BodySaveResult,
	CompletedResponseMetadata,
	DownloadRecord,
	ErrorRecord,
	EventSourceMessageRecord,
	ExtraInfoState,
	IndexedDbDatabaseSnapshot,
	IndexedDbEntrySnapshot,
	IndexedDbObjectStoreSnapshot,
	LoggerStorage,
	OriginStorageSnapshot,
	RequestState,
	RequestBodySaveResult,
	RequestBodySource,
	SessionInfo,
	StorageSnapshot,
	StorageSnapshotValue,
	WebSocketFrameRecord,
} from "./types";

// Only the logger reads these, so they stay next to the class they configure.
type StartLoggerOptions = {
	// Subscribes the ExtraInfo events, which is the only way raw cookies are recorded.
	captureCookies?: boolean | undefined;
	// Points browser downloads at the run directory and subscribes the Browser events.
	captureDownloads?: boolean | undefined;
	cdp: string;
	exclude?: RegExp | undefined;
	hooks?: HookPublisher | undefined;
	include?: RegExp | undefined;
	maxBodyBytes?: number | undefined;
	// Reads the storage domains once at the end of the run; nothing is enabled before.
	snapshotStorage?: boolean | undefined;
	// Overrides the snapshot deadline; only tests need anything but the default.
	snapshotTimeoutMs?: number | undefined;
	streamBodies?: boolean | undefined;
	storage: LoggerStorage;
	verbose: boolean;
};

type CdpClient = CDP.Client;
type TerminableSocket = { terminate?: () => void };
type TargetAttachedEvent = Protocol.Target.AttachedToTargetEvent;
type TargetDetachedEvent = Protocol.Target.DetachedFromTargetEvent;
type RequestWillBeSentEvent = Protocol.Network.RequestWillBeSentEvent;
type RequestWillBeSentExtraInfoEvent = Protocol.Network.RequestWillBeSentExtraInfoEvent;
type ResponseReceivedEvent = Protocol.Network.ResponseReceivedEvent;
type ResponseReceivedExtraInfoEvent = Protocol.Network.ResponseReceivedExtraInfoEvent;
type LoadingFinishedEvent = Protocol.Network.LoadingFinishedEvent;
type LoadingFailedEvent = Protocol.Network.LoadingFailedEvent;
type DataReceivedEvent = Protocol.Network.DataReceivedEvent;
// The chrome-remote-interface types bundle an older devtools-protocol without this method.
// The pinned devtools-protocol types it, so the call is widened onto the Network domain.
type StreamResourceContent = (
	params: Protocol.Network.StreamResourceContentRequest,
	sessionId?: string,
) => Promise<Protocol.Network.StreamResourceContentResponse>;
type WebSocketCreatedEvent = Protocol.Network.WebSocketCreatedEvent;
type WebSocketClosedEvent = Protocol.Network.WebSocketClosedEvent;
type WebSocketFrameErrorEvent = Protocol.Network.WebSocketFrameErrorEvent;
type EventSourceMessageReceivedEvent = Protocol.Network.EventSourceMessageReceivedEvent;
// The Page download events are deprecated in favor of these browser-wide ones.
// Browser.setDownloadBehavior with eventsEnabled is what turns them on.
type DownloadWillBeginEvent = Protocol.Browser.DownloadWillBeginEvent;
type DownloadProgressEvent = Protocol.Browser.DownloadProgressEvent;
// What downloadWillBegin knew about a download, keyed by its GUID.
// Only that event carries the URL and suggested filename; progress events carry neither.
// A download the logger only ever saw finish gets an entry too, so its repeats are seen.
type PendingDownload = {
	frameId?: string | undefined;
	// The terminal state already recorded, undefined while the download is still running.
	settledState?: DownloadRecord["state"] | undefined;
	startedAt?: string | undefined;
	suggestedFilename?: string | undefined;
	url?: string | undefined;
};
// CDP reports whether the saved bytes were base64 encoded alongside the save result.
type ResponseBodyResult = BodySaveResult & { base64Encoded?: boolean | undefined };
// The skip flag drives an error record instead of reaching metadata.
type CompletedBodyResult = Omit<ResponseBodyResult, "skipped">;
// Both frame events carry the same requestId and response payload.
type WebSocketFrameEvent =
	| Protocol.Network.WebSocketFrameReceivedEvent
	| Protocol.Network.WebSocketFrameSentEvent;
// Raw headers waiting for the base event they belong to.
// The counts track ExtraInfo events owed to redirect hops already recorded.
// A late one is then dropped, not landed on the next hop under the shared requestId.
type PendingExtraInfo = ExtraInfoState & {
	orphanedRequests: number;
	orphanedResponses: number;
};

// Response bytes assembled from Network.streamResourceContent, only with --stream-bodies.
// The bufferedData prefix holds everything the stream had before streaming was enabled.
// The dataReceived events carrying `data` are the bytes streamed after that point.
// Chrome only sets `data` once streaming is on, so a chunk without it sits in the prefix.
// Such a chunk is ignored, and every data-carrying chunk is strictly after the prefix.
// The assembled body is therefore the buffered prefix followed by the chunks in order.
type StreamAccumulator = {
	// Streaming ran past the byte limit; the partial buffer is freed and the body skipped.
	aborted: boolean;
	// Streamed dataReceived payloads after the prefix, decoded and in arrival order.
	chunks: Buffer[];
	// Wire bytes reported by every dataReceived event of the request, prefix included.
	// The buffer path guards on the loadingFinished total, which counts the same bytes.
	// Both paths therefore compare --max-body-bytes against the encoded size.
	encodedBytes: number;
	// Resolves once streamResourceContent settled: its prefix stored here, or failed set.
	enabling: Promise<void>;
	// A rejected or unsupported streamResourceContent makes loadingFinished refetch instead.
	failed: boolean;
	// The buffered prefix from streamResourceContent, decoded; undefined until it resolves.
	prefix?: Buffer | undefined;
};

const TARGET_TYPES = new Set(["page", "iframe", "worker", "shared_worker", "service_worker"]);

const NETWORK_BUFFER_OPTIONS = {
	maxResourceBufferSize: 100 * 1024 * 1024,
	maxTotalBufferSize: 500 * 1024 * 1024,
};

const CDP_CLOSE_TIMEOUT_MS = 5_000;
const CDP_DRAIN_TIMEOUT_MS = 1_000;
// A download record is only written once its saved file has been hashed.
// Hashing a large file takes far longer than the in-memory handlers need to drain.
// The writers close right after the drain, so a late append would be dropped.
// The budget is therefore extended while a download is still being hashed.
const CDP_DOWNLOAD_DRAIN_TIMEOUT_MS = 30_000;

// A WebSocket handshake gets ExtraInfo events but never a requestWillBeSent.
// Those entries are only cleaned up by the socket closing or the target detaching.
// The cap keeps a long capture bounded even when neither happens.
const MAX_PENDING_EXTRA_INFO = 1_000;

// Download events are browser-wide, so no target detaching ever sweeps this map.
// A download whose progress events stop is never finalized.
// A finished one is kept so a repeated terminal event writes no second record.
// The cap bounds the map like the one above, dropping the oldest entry it holds.
const MAX_PENDING_DOWNLOADS = 1_000;

// Bounds for one end-of-run storage snapshot, so shutdown cannot hang on a big store.
// Every cap that drops something sets `truncated` on the snapshot it cut.
// A short read is therefore visible in the file, not left looking like empty storage.
const MAX_SNAPSHOT_ORIGINS = 20;
const MAX_DATABASES_PER_ORIGIN = 20;
const MAX_OBJECT_STORES_PER_DATABASE = 20;
const MAX_ENTRIES_PER_OBJECT_STORE = 500;
const MAX_SNAPSHOT_ENTRIES = 5_000;
const SNAPSHOT_TIMEOUT_MS = 15_000;

// Web storage belongs to a browsing context, so only page-like targets are asked.
// A worker session answers neither DOMStorage nor a frame-scoped IndexedDB read.
const SNAPSHOT_TARGET_TYPES = new Set(["page", "iframe"]);

// The client types send() to the command names its bundled protocol copy knows.
// The snapshot builds its method names from a domain, so it uses a widened view.
type RawSend = (method: string, params?: object, sessionId?: string) => Promise<unknown>;

// One origin to snapshot, together with the attached session it is read on.
type SnapshotOrigin = {
	securityOrigin: string;
	sessionId: string;
	targetId?: string | undefined;
};

// Only a terminal state produces a record; progress is reported for every chunk.
// A state added to the protocol later is passed through instead of being labelled.
// It also stops compiling here, so a new state gets a deliberate answer.
const terminalDownloadState = (
	state: DownloadProgressEvent["state"],
): DownloadRecord["state"] | undefined => {
	switch (state) {
		case "inProgress":
			return undefined;
		case "completed":
			return "completed";
		case "canceled":
			return "canceled";
		default:
			return state;
	}
};

// An EventSource connection normally never reaches loadingFinished.
// Its bytes would be held for the life of the page, duplicating eventsource.ndjson.
const isEventStream = (event: ResponseReceivedEvent): boolean =>
	event.type === "EventSource" || event.response.mimeType === "text/event-stream";

// Decoded size of everything assembled so far, which an empty assembly reports as 0.
const streamedByteLength = (stream: StreamAccumulator): number =>
	stream.chunks.reduce((total, chunk) => total + chunk.byteLength, stream.prefix?.byteLength ?? 0);

const HOP_POST_DATA_ERROR =
	"Redirect hop post data was not inlined; Network.getRequestPostData answers for the request now in flight.";

const errorMessage = (error: unknown): string =>
	error instanceof Error ? error.message : String(error);

const nowIso = (): string => new Date().toISOString();

const settles = async (promise: Promise<unknown>): Promise<boolean> => {
	try {
		await promise;
	} catch {
		// Rejection also means the operation has settled.
	}
	return true;
};

const settlesWithin = async (promise: Promise<unknown>, timeout: number): Promise<boolean> =>
	await Promise.race([settles(promise), Bun.sleep(timeout).then(() => false)]);

const terminateClientSocket = (client: CdpClient): void => {
	const socket = Reflect.get(client, "_ws") as TerminableSocket | undefined;
	socket?.terminate?.();
};

// Sequential mapping without a loop, so a snapshot never fans out over every store.
const mapSequential = async <Item, Result>(
	items: readonly Item[],
	map: (item: Item) => Promise<Result>,
): Promise<Result[]> =>
	await items.reduce<Promise<Result[]>>(
		async (previous, item) => [...(await previous), await map(item)],
		Promise.resolve([]),
	);

// A pending Bun.sleep would keep the process alive past the work it bounded.
// The deadline therefore runs on a timer, cleared as soon as the race is decided.
const finishesWithin = async (work: Promise<void>, timeout: number): Promise<boolean> => {
	const { promise, resolve } = Promise.withResolvers<boolean>();
	const timer = setTimeout(() => {
		resolve(false);
	}, timeout);
	try {
		return await Promise.race([work.then(() => true), promise]);
	} finally {
		clearTimeout(timer);
	}
};

// The same bound for work that answers with a value instead of only finishing.
// A timeout answers with the fallback; the abandoned work is left to settle unused.
const resolvesWithin = async <Value>(
	work: Promise<Value>,
	timeout: number,
	fallback: Value,
): Promise<Value> => {
	const { promise, resolve } = Promise.withResolvers<Value>();
	const timer = setTimeout(() => {
		resolve(fallback);
	}, timeout);
	try {
		return await Promise.race([work, promise]);
	} finally {
		clearTimeout(timer);
	}
};

// Web storage is keyed by origin, so only an http(s) target has any to read.
// Targets on about:, chrome:, devtools:, and extension schemes are left out.
const snapshotOriginOf = (url: string | undefined): string | undefined => {
	const parsed = url === undefined ? null : URL.parse(url);
	if (parsed === null || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) {
		return undefined;
	}

	return parsed.origin;
};

// The origins snapshotted are the ones the run actually attached to.
// They are never guessed from a URL seen on the wire.
// A third-party request origin has no session to ask on, and no reachable storage.
// Each origin is read on its own target session.
// That is what makes the sessionStorage answer belong to the tab it came from.
// The first session seen for an origin wins, so an origin open twice is read once.
// A session only recorded the URL its target had when it attached.
// For a page that is usually about:blank, so live target URLs take precedence.
const collectSnapshotOrigins = (
	sessions: Iterable<SessionInfo>,
	currentUrls: ReadonlyMap<string, string> = new Map(),
): SnapshotOrigin[] => {
	const origins = new Map<string, SnapshotOrigin>();
	for (const session of sessions) {
		const current = session.targetId === undefined ? undefined : currentUrls.get(session.targetId);
		const securityOrigin = snapshotOriginOf(current ?? session.targetUrl);
		if (
			securityOrigin === undefined ||
			!SNAPSHOT_TARGET_TYPES.has(session.targetType ?? "") ||
			origins.has(securityOrigin)
		) {
			continue;
		}

		origins.set(securityOrigin, {
			securityOrigin,
			sessionId: session.sessionId,
			targetId: session.targetId,
		});
	}

	return [...origins.values()];
};

// CDP answers with a live-object handle beside a bounded preview.
// That handle is meaningless once the run is over, and resolving it would need the
// Runtime domain, so it is dropped.
// Whatever CDP already materialized is recorded exactly as it arrived.
const snapshotValue = (value: Protocol.Runtime.RemoteObject): StorageSnapshotValue => ({
	className: value.className,
	deepSerializedValue: value.deepSerializedValue,
	description: value.description,
	preview: value.preview,
	subtype: value.subtype,
	type: value.type,
	unserializableValue: value.unserializableValue,
	value: value.value as unknown,
});

const snapshotEntry = (entry: Protocol.IndexedDB.DataEntry): IndexedDbEntrySnapshot => ({
	key: snapshotValue(entry.key),
	primaryKey: snapshotValue(entry.primaryKey),
	value: snapshotValue(entry.value),
});

// DOMStorage answers with [key, value] pairs; a malformed pair is skipped.
const toStorageItems = (entries: Protocol.DOMStorage.Item[]): Record<string, string> =>
	Object.fromEntries(
		entries.flatMap((entry) => {
			const [key, value] = entry;
			return key === undefined ? [] : [[key, value ?? ""] as [string, string]];
		}),
	);

const requestKey = (sessionId: string, requestId: string): string => `${sessionId}:${requestId}`;

const requestBodyErrorEvent = (source: RequestBodySource | undefined): string =>
	source === "requestWillBeSent"
		? "Network.requestWillBeSent.postData"
		: "Network.getRequestPostData";

// A body dropped by a size limit is a policy decision, not a capture failure.
// The marker keeps the getResponseBody name even for a streamed body.
// Such a body never reached that call, but a run summary stays comparable.
const responseBodyErrorEvent = (skipped: boolean | undefined): string =>
	skipped === true ? "Network.getResponseBody.skipped" : "Network.getResponseBody";

// Empty cookie diagnostics are the normal case, and JSON.stringify drops undefined.
// A response that blocked nothing keeps the record shape it had before the flag.
const applyResponseExtraInfo = (
	target: ExtraInfoState,
	event: ResponseReceivedExtraInfoEvent,
): void => {
	target.rawResponseHeaders = event.headers;
	if (event.blockedCookies.length > 0) {
		target.blockedCookies = event.blockedCookies;
	}
	if (event.exemptedCookies && event.exemptedCookies.length > 0) {
		target.exemptedCookies = event.exemptedCookies;
	}
	if (event.cookiePartitionKey) {
		target.cookiePartitionKey = event.cookiePartitionKey;
	}
};

// The cookie diagnostics are only ever set together with rawResponseHeaders.
// The header checks already cover them, so they are listed only for robustness.
// The predicate then holds even if that invariant is ever relaxed.
const hasBufferedExtraInfo = (pending: PendingExtraInfo): boolean =>
	pending.orphanedRequests > 0 ||
	pending.orphanedResponses > 0 ||
	pending.rawRequestHeaders !== undefined ||
	pending.rawResponseHeaders !== undefined ||
	pending.blockedCookies !== undefined ||
	pending.exemptedCookies !== undefined ||
	pending.cookiePartitionKey !== undefined;

const createErrorRecord = (
	event: string,
	session: SessionInfo | undefined,
	error: unknown,
	requestId?: string,
	url?: string,
): ErrorRecord => ({
	error: errorMessage(error),
	event,
	requestId,
	sessionId: session?.sessionId,
	targetId: session?.targetId,
	timestamp: nowIso(),
	url,
});

const createCompletedMetadata = (
	state: RequestState,
	finished: LoadingFinishedEvent,
	bodyResult: CompletedBodyResult,
	requestBodyResult: Partial<RequestBodySaveResult>,
	runTimestamp: string,
): CompletedResponseMetadata => {
	const response = state.response;

	return {
		base64Encoded: bodyResult.base64Encoded,
		blockedCookies: state.blockedCookies,
		bodyFile: bodyResult.bodyFile,
		bodyLength: bodyResult.bodyLength,
		bodySaved: bodyResult.bodySaved,
		bodySha256: bodyResult.bodySha256,
		cookiePartitionKey: state.cookiePartitionKey,
		encodedDataLength: finished.encodedDataLength,
		error: bodyResult.error,
		exemptedCookies: state.exemptedCookies,
		fromDiskCache: response?.fromDiskCache,
		fromPrefetchCache: response?.fromPrefetchCache,
		fromServiceWorker: response?.fromServiceWorker,
		loaderId: state.loaderId,
		mimeType: response?.mimeType,
		protocol: response?.protocol,
		// Recorded next to the refined headers, never in place of them.
		rawRequestHeaders: state.rawRequestHeaders,
		rawResponseHeaders: state.rawResponseHeaders,
		redirectIndex: state.redirectIndex,
		remoteIPAddress: response?.remoteIPAddress,
		remotePort: response?.remotePort,
		requestBodyError: requestBodyResult.error,
		requestBodyFile: requestBodyResult.bodyFile,
		requestBodyLength: requestBodyResult.bodyLength,
		requestBodySaved: requestBodyResult.bodySaved,
		requestBodySha256: requestBodyResult.bodySha256,
		requestBodySource: requestBodyResult.source,
		requestHeaders: state.requestHeaders,
		requestId: state.requestId,
		requestMethod: state.requestMethod,
		responseHeaders: response?.headers,
		runTimestamp,
		sessionId: state.session.sessionId,
		status: response?.status,
		statusText: response?.statusText,
		tabTargetId: state.session.targetId,
		targetType: state.session.targetType,
		targetUrl: state.session.targetUrl,
		type: state.type,
		url: response?.url ?? state.requestUrl,
	};
};

const isInspectableTarget = (targetInfo: Protocol.Target.TargetInfo): boolean =>
	TARGET_TYPES.has(targetInfo.type);

const headerValue = (
	headers: Protocol.Network.Headers | undefined,
	name: string,
): string | undefined => {
	const wanted = name.toLowerCase();
	const entry = Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === wanted);
	const value = entry?.[1];

	if (Array.isArray(value)) {
		return value.join(", ");
	}

	return typeof value === "string" ? value : undefined;
};

// Reads the browser-process storage domains into one snapshot object.
// Nothing here executes page script: Storage, DOMStorage, and IndexedDB all answer
// From the browser side, and no Runtime method is ever sent.
// Each read answers with a fallback instead of throwing, so one failed origin
// Cannot lose the rest of the file.
class StorageSnapshotReader {
	// Set when the caller's deadline race gave up on this reader.
	// Only some steps watch the deadline, so an abandoned read would otherwise keep
	// Enabling domains and recording errors on a storage writer the run has closed.
	#aborted = false;
	readonly #deadline: number;
	// Entries read so far across the whole snapshot, against MAX_SNAPSHOT_ENTRIES.
	#entries = 0;
	readonly #recordError: (event: string, error: unknown, origin?: SnapshotOrigin) => Promise<void>;
	readonly #send: RawSend;
	readonly #snapshot: StorageSnapshot;

	constructor(
		client: CdpClient,
		snapshot: StorageSnapshot,
		deadline: number,
		recordError: (event: string, error: unknown, origin?: SnapshotOrigin) => Promise<void>,
	) {
		this.#deadline = deadline;
		this.#recordError = recordError;
		this.#send = client.send.bind(client) as unknown as RawSend;
		this.#snapshot = snapshot;
	}

	async read(origins: SnapshotOrigin[]): Promise<void> {
		await this.#readCookies();
		const wanted = origins.slice(0, MAX_SNAPSHOT_ORIGINS);
		if (origins.length > wanted.length) {
			this.#snapshot.truncated = true;
		}

		await mapSequential(wanted, async (origin) => {
			await this.#readOrigin(origin);
		});
	}

	// Stops the reader from sending or recording anything else.
	// The caller calls this once its own race around read() has been decided.
	abort(): void {
		this.#aborted = true;
	}

	#expired(): boolean {
		if (Date.now() < this.#deadline) {
			return false;
		}
		this.#snapshot.truncated = true;

		return true;
	}

	// The CDP method name doubles as the errors.ndjson event, as everywhere else.
	async #call<Result>(
		method: string,
		params: object,
		origin: SnapshotOrigin | undefined,
		fallback: Result,
	): Promise<Result> {
		if (this.#aborted) {
			return fallback;
		}

		try {
			return (await this.#send(method, params, origin?.sessionId)) as Result;
		} catch (error) {
			if (!this.#aborted) {
				await this.#recordError(method, error, origin);
			}
			return fallback;
		}
	}

	// Enabling is deferred to here, so these domains are only ever open for the moment
	// They are read.
	// A run without the flag never enables them at all.
	async #enable(domain: string, origin: SnapshotOrigin): Promise<boolean> {
		if (this.#aborted) {
			return false;
		}

		const method = `${domain}.enable`;
		try {
			await this.#send(method, {}, origin.sessionId);
			return true;
		} catch (error) {
			if (!this.#aborted) {
				await this.#recordError(method, error, origin);
			}
			return false;
		}
	}

	// Cookies are browser-wide, so this is one call on the browser connection.
	// No browserContextId is passed, which means the default context.
	// Nothing narrows the answer to the origins below: a stored session usually needs
	// Cookies of an API host that was never navigated to, which has no target at all.
	async #readCookies(): Promise<void> {
		// Every request below is annotated with its protocol type, because the widened
		// Send() would otherwise accept a misspelled parameter until it reached Chrome.
		const params: Protocol.Storage.GetCookiesRequest = {};
		const { cookies } = await this.#call<Protocol.Storage.GetCookiesResponse>(
			"Storage.getCookies",
			params,
			undefined,
			{ cookies: [] },
		);
		this.#snapshot.cookies = cookies;
	}

	async #readOrigin(origin: SnapshotOrigin): Promise<void> {
		if (this.#expired()) {
			return;
		}

		const record: OriginStorageSnapshot = {
			databases: [],
			securityOrigin: origin.securityOrigin,
			targetId: origin.targetId,
		};
		this.#snapshot.origins.push(record);
		await this.#readDomStorage(origin, record);
		await this.#readIndexedDb(origin, record);
	}

	// Both areas are read on the session of the target that owns them.
	// A cross-origin frame therefore answers for itself, not for the page embedding it.
	async #readDomStorage(origin: SnapshotOrigin, record: OriginStorageSnapshot): Promise<void> {
		if (!(await this.#enable("DOMStorage", origin))) {
			return;
		}

		record.localStorage = await this.#readDomStorageArea(origin, true);
		record.sessionStorage = await this.#readDomStorageArea(origin, false);
	}

	// An undefined area is one CDP refused; an empty one is an area with no keys.
	async #readDomStorageArea(
		origin: SnapshotOrigin,
		isLocalStorage: boolean,
	): Promise<Record<string, string> | undefined> {
		const params: Protocol.DOMStorage.GetDOMStorageItemsRequest = {
			storageId: { isLocalStorage, securityOrigin: origin.securityOrigin },
		};
		const entries = await this.#call<Protocol.DOMStorage.GetDOMStorageItemsResponse | undefined>(
			"DOMStorage.getDOMStorageItems",
			params,
			origin,
			undefined,
		);

		return entries === undefined ? undefined : toStorageItems(entries.entries);
	}

	async #readIndexedDb(origin: SnapshotOrigin, record: OriginStorageSnapshot): Promise<void> {
		if (!(await this.#enable("IndexedDB", origin))) {
			return;
		}

		const params: Protocol.IndexedDB.RequestDatabaseNamesRequest = {
			securityOrigin: origin.securityOrigin,
		};
		const { databaseNames } = await this.#call<Protocol.IndexedDB.RequestDatabaseNamesResponse>(
			"IndexedDB.requestDatabaseNames",
			params,
			origin,
			{ databaseNames: [] },
		);
		const wanted = databaseNames.slice(0, MAX_DATABASES_PER_ORIGIN);
		if (databaseNames.length > wanted.length) {
			record.truncatedDatabases = databaseNames.length - wanted.length;
			this.#snapshot.truncated = true;
		}

		record.databases = await mapSequential(
			wanted,
			async (name) => await this.#readDatabase(origin, name),
		);
	}

	async #readDatabase(
		origin: SnapshotOrigin,
		databaseName: string,
	): Promise<IndexedDbDatabaseSnapshot> {
		const params: Protocol.IndexedDB.RequestDatabaseRequest = {
			databaseName,
			securityOrigin: origin.securityOrigin,
		};
		const database = await this.#call<Protocol.IndexedDB.RequestDatabaseResponse | undefined>(
			"IndexedDB.requestDatabase",
			params,
			origin,
			undefined,
		);
		if (database === undefined) {
			return { error: "IndexedDB.requestDatabase failed.", name: databaseName, objectStores: [] };
		}

		const stores = database.databaseWithObjectStores.objectStores;
		const wanted = stores.slice(0, MAX_OBJECT_STORES_PER_DATABASE);
		if (stores.length > wanted.length) {
			this.#snapshot.truncated = true;
		}

		return {
			name: database.databaseWithObjectStores.name,
			objectStores: await mapSequential(
				wanted,
				async (store) => await this.#readObjectStore(origin, databaseName, store),
			),
			truncatedObjectStores:
				stores.length > wanted.length ? stores.length - wanted.length : undefined,
			version: database.databaseWithObjectStores.version,
		};
	}

	// One page per store, never paged further.
	// The caps are what keeps a huge store from stalling shutdown.
	// A store with more entries than the page holds reports `hasMore` instead.
	async #readObjectStore(
		origin: SnapshotOrigin,
		databaseName: string,
		store: Protocol.IndexedDB.ObjectStore,
	): Promise<IndexedDbObjectStoreSnapshot> {
		const shape = { autoIncrement: store.autoIncrement, keyPath: store.keyPath, name: store.name };
		const pageSize = Math.min(MAX_ENTRIES_PER_OBJECT_STORE, MAX_SNAPSHOT_ENTRIES - this.#entries);
		if (pageSize <= 0 || this.#expired()) {
			this.#snapshot.truncated = true;
			return { ...shape, entries: [], hasMore: true };
		}

		// No indexName is sent, which is what asks for the object store itself.
		// Chrome reads an empty one as a request for an index and fails the call.
		const params: Protocol.IndexedDB.RequestDataRequest = {
			databaseName,
			objectStoreName: store.name,
			pageSize,
			securityOrigin: origin.securityOrigin,
			skipCount: 0,
		};
		const data = await this.#call<Protocol.IndexedDB.RequestDataResponse | undefined>(
			"IndexedDB.requestData",
			params,
			origin,
			undefined,
		);
		if (data === undefined) {
			return { ...shape, entries: [], error: "IndexedDB.requestData failed.", hasMore: false };
		}

		this.#entries += data.objectStoreDataEntries.length;
		if (data.hasMore) {
			this.#snapshot.truncated = true;
		}

		return {
			...shape,
			entries: data.objectStoreDataEntries.map(snapshotEntry),
			hasMore: data.hasMore,
		};
	}
}

class CdpResponseLogger {
	readonly #client: CdpClient;
	// Set once the browser connection is gone, so shutdown stops sending to it.
	#disconnected = false;
	// Downloads seen this run keyed by GUID, only populated with --capture-downloads.
	readonly #downloads = new Map<string, PendingDownload>();
	// Downloads whose record is waiting on the hash of a saved file.
	#hashingDownloads = 0;
	// Raw headers with no request state to live on yet, keyed like #requests.
	// Only populated with --capture-cookies, since nothing else subscribes ExtraInfo.
	readonly #extraInfo = new Map<string, PendingExtraInfo>();
	// Redirect hop writes in flight, keyed like #requests so a chain appends in order.
	readonly #hopWrites = new Map<string, Promise<void>>();
	readonly #options: StartLoggerOptions;
	readonly #pendingEvents = new Set<Promise<void>>();
	readonly #requests = new Map<string, RequestState>();
	readonly #sessions = new Map<string, SessionInfo>();
	// Streamed body buffers keyed like #requests, only populated with --stream-bodies.
	// Held only while a request is in flight, then dropped on finish, failure, or detach.
	readonly #streams = new Map<string, StreamAccumulator>();
	// One record per run: an unsupported method fails on every request there is.
	#streamFailureRecorded = false;
	// Socket URLs keyed like #requests.
	// A WebSocket handshake produces no Network.requestWillBeSent event.
	// Nothing else maps a frame requestId back to its URL.
	readonly #webSockets = new Map<string, string>();

	constructor(client: CdpClient, options: StartLoggerOptions) {
		this.#client = client;
		this.#options = options;
	}

	async start(): Promise<void> {
		this.#registerEvents();
		await this.#client.Target.setDiscoverTargets({ discover: true });
		await this.#setDownloadBehavior();
		await this.#client.Target.setAutoAttach({
			autoAttach: true,
			flatten: true,
			waitForDebuggerOnStart: false,
		});
		await this.#attachExistingTargets();
	}

	// Runs while the browser and the CDP connection are both still up.
	// That is why it is its own step before shutdown rather than part of close().
	// A failure is recorded and the partial snapshot is still written, so neither
	// Teardown nor the run summary depends on the storage domains answering.
	async snapshotStorage(): Promise<void> {
		if (!this.#options.snapshotStorage || this.#disconnected) {
			if (this.#options.snapshotStorage) {
				await this.#recordCaptureError(
					createErrorRecord(
						"Storage.snapshot",
						undefined,
						"The browser disconnected before the storage snapshot could be taken.",
					),
				);
			}
			return;
		}

		const timeout = this.#options.snapshotTimeoutMs ?? SNAPSHOT_TIMEOUT_MS;
		// One deadline covers the whole snapshot, target lookup included, so shutdown
		// Waits for this step at most once.
		const deadline = Date.now() + timeout;
		const snapshot: StorageSnapshot = {
			cookies: [],
			origins: [],
			runTimestamp: this.#options.storage.runTimestamp,
			timestamp: nowIso(),
		};
		const reader = new StorageSnapshotReader(
			this.#client,
			snapshot,
			deadline,
			async (event, error, origin) => {
				await this.#recordCaptureError(
					createErrorRecord(event, undefined, error, undefined, origin?.securityOrigin),
				);
			},
		);

		const origins = collectSnapshotOrigins(
			this.#sessions.values(),
			await this.#currentTargetUrls(timeout),
		);
		const remaining = Math.max(deadline - Date.now(), 0);
		if (!(await finishesWithin(reader.read(origins), remaining))) {
			// The race only abandons the read; this is what stops the reader itself.
			reader.abort();
			snapshot.truncated = true;
			await this.#recordCaptureError(
				createErrorRecord("Storage.snapshot", undefined, `Snapshot stopped after ${timeout}ms.`),
			);
		}

		await this.#writeSnapshot(snapshot);
	}

	// A session only ever recorded the URL its target had when it attached.
	// A page target usually attaches on about:blank and navigates afterwards.
	// The live target list is therefore what says which origin each session is on now.
	// A browser that is connected but wedged answers this call never, and it runs before
	// The reader's deadline guards anything, so it carries the same bound itself.
	// Timing out leaves the map empty, exactly like a failure does.
	async #currentTargetUrls(timeout: number): Promise<Map<string, string>> {
		const urls = await resolvesWithin<Map<string, string> | undefined>(
			this.#requestTargetUrls(),
			timeout,
			undefined,
		);
		if (urls !== undefined) {
			return urls;
		}
		await this.#recordCaptureError(
			createErrorRecord(
				"Target.getTargets",
				undefined,
				`Target.getTargets stopped after ${timeout}ms.`,
			),
		);

		return new Map();
	}

	// A failure leaves the map empty, so the attach-time URLs answer instead.
	async #requestTargetUrls(): Promise<Map<string, string>> {
		try {
			const { targetInfos } = await this.#client.Target.getTargets({});
			return new Map(targetInfos.map((info) => [info.targetId, info.url]));
		} catch (error) {
			await this.#recordCaptureError(createErrorRecord("Target.getTargets", undefined, error));
			return new Map();
		}
	}

	async #writeSnapshot(snapshot: StorageSnapshot): Promise<void> {
		try {
			const file = await this.#options.storage.recordStorageSnapshot(snapshot);
			await this.#options.hooks?.publish(
				createStorageSnapshotHookEvent(
					file,
					countStorageSnapshot(snapshot),
					snapshot.truncated === true,
					this.#options.storage,
				),
			);
		} catch (error) {
			await this.#recordCaptureError(createErrorRecord("Storage.snapshot", undefined, error));
		}
	}

	async close(): Promise<void> {
		// The override has to go back before the connection that installed it is closed.
		await settlesWithin(this.#resetDownloadBehavior(), CDP_DRAIN_TIMEOUT_MS);
		const closing = this.#client.close();
		if (!(await settlesWithin(closing, CDP_CLOSE_TIMEOUT_MS))) {
			terminateClientSocket(this.#client);
			await settlesWithin(closing, CDP_DRAIN_TIMEOUT_MS);
		}
		if (
			!(await settlesWithin(this.#drainPendingEvents(), CDP_DRAIN_TIMEOUT_MS)) &&
			this.#hashingDownloads > 0
		) {
			// A download record still being hashed gets the longer budget of its own.
			await settlesWithin(this.#drainPendingEvents(), CDP_DOWNLOAD_DRAIN_TIMEOUT_MS);
		}
	}

	#log(message: string): void {
		process.stdout.write(`${message}\n`);
	}

	#verbose(message: string): void {
		if (this.#options.verbose) {
			this.#log(message);
		}
	}

	// The browser writes downloads here, so the path must be absolute for it, not for us.
	#downloadDirectory(): string {
		return resolvePath(this.#options.storage.runDirectory, DOWNLOADS_DIRECTORY);
	}

	// Sent on the browser connection with no sessionId, so it needs no attached target.
	// Every target of the default browser context is included, later ones among them.
	// No browserContextId is passed, so every non-default context keeps its own behavior.
	// A download started in incognito is neither redirected here nor reported at all.
	// This is the one call that changes browser behavior, hence the explicit opt-in.
	// Its eventsEnabled flag turns on the browser-wide events subscribed below.
	async #setDownloadBehavior(): Promise<void> {
		if (!this.#options.captureDownloads) {
			return;
		}

		try {
			await this.#client.Browser.setDownloadBehavior({
				behavior: "allowAndName",
				downloadPath: this.#downloadDirectory(),
				eventsEnabled: true,
			});
		} catch (error) {
			await this.#recordCaptureError(
				createErrorRecord("Browser.setDownloadBehavior", undefined, error),
			);
		}
	}

	// In attach mode the browser is the user's own and outlives the run.
	// An override left installed keeps naming downloads after their GUID.
	// It also keeps writing them into a run directory nothing reads any more.
	// A connection that is already gone has nothing to restore.
	async #resetDownloadBehavior(): Promise<void> {
		if (!this.#options.captureDownloads || this.#disconnected) {
			return;
		}

		try {
			await this.#client.Browser.setDownloadBehavior({ behavior: "default" });
		} catch (error) {
			// A browser closed by the run itself is the normal launch-mode path, not a loss.
			if (this.#disconnected) {
				return;
			}
			await this.#recordCaptureError(
				createErrorRecord("Browser.setDownloadBehavior", undefined, error),
			);
		}
	}

	#registerEvents(): void {
		this.#client.on("Target.attachedToTarget", (event) => {
			this.#trackEvent(this.#handleAttached(event));
		});
		this.#client.on("Target.detachedFromTarget", (event) => {
			this.#trackEvent(this.#handleDetached(event));
		});
		this.#client.on("Network.requestWillBeSent", (event, sessionId) => {
			this.#trackEvent(this.#handleRequestWillBeSent(event as RequestWillBeSentEvent, sessionId));
		});
		this.#client.on("Network.responseReceived", (event, sessionId) => {
			this.#handleResponseReceived(event as ResponseReceivedEvent, sessionId);
		});
		// Only --stream-bodies streams resources, so nothing else needs the chunk events.
		// Their `data` field is only populated once streaming is enabled for a request.
		if (this.#options.streamBodies) {
			this.#client.on("Network.dataReceived", (event, sessionId) => {
				this.#handleDataReceived(event as DataReceivedEvent, sessionId);
			});
		}
		// The ExtraInfo events are the only source of Cookie and Set-Cookie headers.
		// A run without --capture-cookies never subscribes them and buffers nothing.
		// The chrome-remote-interface types bundle an older devtools-protocol copy.
		// Its cookie shapes no longer line up with the pinned one, hence the widening.
		if (this.#options.captureCookies) {
			this.#client.on("Network.requestWillBeSentExtraInfo", (event, sessionId) => {
				this.#handleRequestExtraInfo(
					event as unknown as RequestWillBeSentExtraInfoEvent,
					sessionId,
				);
			});
			this.#client.on("Network.responseReceivedExtraInfo", (event, sessionId) => {
				this.#handleResponseExtraInfo(
					event as unknown as ResponseReceivedExtraInfoEvent,
					sessionId,
				);
			});
		}
		this.#client.on("Network.loadingFinished", (event, sessionId) => {
			this.#trackEvent(this.#handleLoadingFinished(event as LoadingFinishedEvent, sessionId));
		});
		this.#client.on("Network.loadingFailed", (event, sessionId) => {
			this.#trackEvent(this.#handleLoadingFailed(event as LoadingFailedEvent, sessionId));
		});
		this.#client.on("Network.webSocketCreated", (event, sessionId) => {
			this.#handleWebSocketCreated(event as WebSocketCreatedEvent, sessionId);
		});
		this.#client.on("Network.webSocketClosed", (event, sessionId) => {
			this.#handleWebSocketClosed(event as WebSocketClosedEvent, sessionId);
		});
		this.#client.on("Network.webSocketFrameReceived", (event, sessionId) => {
			this.#trackEvent(
				this.#handleWebSocketFrame("received", event as WebSocketFrameEvent, sessionId),
			);
		});
		this.#client.on("Network.webSocketFrameSent", (event, sessionId) => {
			this.#trackEvent(this.#handleWebSocketFrame("sent", event as WebSocketFrameEvent, sessionId));
		});
		// Downloads are reported by the Browser domain alone; Network reports none.
		// Its events are turned on by the setDownloadBehavior call the flag sends.
		// The Page equivalents are deprecated and miss a download whose tab closes first.
		// Both events are browser-wide, so neither carries a sessionId to dispatch on.
		// A run without the flag subscribes neither and tracks no download.
		if (this.#options.captureDownloads) {
			this.#client.on("Browser.downloadWillBegin", (event) => {
				this.#handleDownloadWillBegin(event as DownloadWillBeginEvent);
			});
			this.#client.on("Browser.downloadProgress", (event) => {
				this.#trackEvent(this.#handleDownloadProgress(event as DownloadProgressEvent));
			});
		}
		this.#client.on("Network.eventSourceMessageReceived", (event, sessionId) => {
			this.#trackEvent(
				this.#handleEventSourceMessage(event as EventSourceMessageReceivedEvent, sessionId),
			);
		});
		this.#client.on("Network.webSocketFrameError", (event, sessionId) => {
			this.#trackEvent(
				this.#handleWebSocketFrameError(event as WebSocketFrameErrorEvent, sessionId),
			);
		});
		this.#client.on("disconnect", () => {
			this.#disconnected = true;
			this.#log("cdp disconnected");
		});
	}

	#trackEvent(eventWork: Promise<void>): void {
		const tracked = eventWork
			.catch((error: unknown) => {
				this.#log(`cdp event handler failed: ${errorMessage(error)}`);
			})
			.finally(() => {
				this.#pendingEvents.delete(tracked);
			});
		this.#pendingEvents.add(tracked);
	}

	async #drainPendingEvents(): Promise<void> {
		while (this.#pendingEvents.size > 0) {
			await Promise.allSettled([...this.#pendingEvents]);
		}
	}

	async #attachExistingTargets(): Promise<void> {
		const { targetInfos } = await this.#client.Target.getTargets({});
		for (const targetInfo of targetInfos) {
			if (!isInspectableTarget(targetInfo)) {
				continue;
			}

			try {
				await this.#client.Target.attachToTarget({
					flatten: true,
					targetId: targetInfo.targetId,
				});
			} catch (error) {
				await this.#recordCaptureError(
					createErrorRecord(
						"Target.attachToTarget",
						{
							sessionId: "",
							targetId: targetInfo.targetId,
							targetType: targetInfo.type,
							targetUrl: targetInfo.url,
						},
						error,
					),
				);
			}
		}
	}

	async #handleAttached(event: TargetAttachedEvent): Promise<void> {
		const session: SessionInfo = {
			sessionId: event.sessionId,
			targetId: event.targetInfo.targetId,
			targetType: event.targetInfo.type,
			targetUrl: event.targetInfo.url,
		};
		this.#sessions.set(event.sessionId, session);

		if (!isInspectableTarget(event.targetInfo)) {
			this.#verbose(`skip target type=${event.targetInfo.type} id=${event.targetInfo.targetId}`);
			return;
		}

		try {
			await this.#client.Network.enable(NETWORK_BUFFER_OPTIONS, event.sessionId);
			this.#log(
				`attached target=${event.targetInfo.type} session=${event.sessionId} id=${event.targetInfo.targetId}`,
			);
		} catch (error) {
			await this.#recordCaptureError(createErrorRecord("Network.enable", session, error));
		}

		await this.#resumeTarget(event, session);
	}

	async #resumeTarget(event: TargetAttachedEvent, session: SessionInfo): Promise<void> {
		try {
			await this.#client.send("Runtime.runIfWaitingForDebugger", undefined, event.sessionId);
			if (event.waitingForDebugger) {
				this.#log(`resumed waiting target=${event.targetInfo.type} session=${event.sessionId}`);
			} else {
				this.#verbose(`resume checked target=${event.targetInfo.type} session=${event.sessionId}`);
			}
		} catch (error) {
			await this.#recordCaptureError(
				createErrorRecord(
					"Runtime.runIfWaitingForDebugger",
					session,
					error,
					undefined,
					session.targetUrl,
				),
			);
		}
	}

	async #handleDetached(event: TargetDetachedEvent): Promise<void> {
		const session = this.#sessions.get(event.sessionId);
		this.#sessions.delete(event.sessionId);
		let dropped = 0;

		for (const [key, state] of this.#requests) {
			if (state.session.sessionId === event.sessionId) {
				this.#requests.delete(key);
				this.#hopWrites.delete(key);
				dropped += 1;
			}
		}

		// Neither map is keyed by session.
		// Buffered ExtraInfo whose base event never arrives would outlive its session.
		// A stream whose loadingFinished never comes would keep its partial buffer alive.
		const sessionPrefix = `${event.sessionId}:`;
		for (const keyed of [this.#webSockets, this.#extraInfo, this.#streams]) {
			for (const key of keyed.keys()) {
				if (key.startsWith(sessionPrefix)) {
					keyed.delete(key);
					dropped += 1;
				}
			}
		}

		// Downloads are tracked browser-wide and outlive the target that started them.
		// Nothing about them is swept here.
		this.#verbose(`detached session=${event.sessionId}`);
		// A tab closing with nothing in flight is ordinary, and so are OOPIF and worker exits.
		// Recording those would bury the detaches that did drop capture state.
		// It would bury them in errors.ndjson and in the per-host breakdown alike.
		if (session && dropped > 0) {
			await this.#recordCaptureError({
				error: `Target detached before ${dropped} active request(s) completed.`,
				event: "Target.detachedFromTarget",
				sessionId: event.sessionId,
				targetId: session.targetId,
				timestamp: nowIso(),
				url: session.targetUrl,
			});
		}
	}

	async #handleRequestWillBeSent(event: RequestWillBeSentEvent, sessionId?: string): Promise<void> {
		if (!sessionId) {
			return;
		}
		// Messages arrive in wire order, and a detach sweeps its maps before its first await.
		// An event for a session no longer here therefore belongs to a destroyed target.
		// Recording it would resurrect request state nothing can ever complete or remove.
		const session = this.#sessions.get(sessionId);
		if (session === undefined) {
			return;
		}
		const key = requestKey(sessionId, event.requestId);
		const previous = this.#requests.get(key);
		const { redirectResponse } = event;

		// CDP reuses the requestId across a redirect chain.
		// Replace the state first so later events belong to the hop now in flight.
		// The hop it replaced is finalized below.
		this.#requests.set(key, {
			// ExtraInfo that ran ahead of this event was waiting for exactly this hop.
			// On a redirect only the buffered request headers are this hop's.
			// Buffered response headers belong to a previous hop and are discarded here.
			...this.#takeExtraInfo(key, redirectResponse !== undefined),
			frameId: event.frameId,
			hasPostData: event.request.hasPostData,
			initiator: event.initiator,
			loaderId: event.loaderId,
			redirectIndex:
				redirectResponse === undefined ? undefined : (previous?.redirectIndex ?? 0) + 1,
			requestContentType: headerValue(event.request.headers, "content-type"),
			requestHeaders: event.request.headers,
			requestId: event.requestId,
			requestMethod: event.request.method,
			requestPostData: event.request.postData,
			requestTime: nowIso(),
			requestUrl: event.request.url,
			session,
			type: event.type,
		});

		// Every hop of a chain shares one requestId and gets its own pair of ExtraInfo events.
		// The redirectHasExtraInfo flag marks the replaced hop's own ExtraInfo as still coming.
		// Each usually arrives before this base event and lands on the replaced hop directly.
		// A late one instead arrives after that hop record was already written to metadata.
		// Counting each still-missing one as owed makes the late event drop, not shift forward.
		// Nothing is owed with no previous hop: attached mid-chain, no record can own the headers.
		if (
			this.#options.captureCookies &&
			redirectResponse !== undefined &&
			event.redirectHasExtraInfo &&
			previous !== undefined
		) {
			const owed = this.#pendingExtraInfo(key);
			if (previous.rawRequestHeaders === undefined) {
				owed.orphanedRequests += 1;
			}
			if (previous.rawResponseHeaders === undefined) {
				owed.orphanedResponses += 1;
			}
			// A hop that already has both raw headers owes nothing; drop the empty entry.
			if (!hasBufferedExtraInfo(owed)) {
				this.#extraInfo.delete(key);
			}
		}

		// Without the replaced state there is no request to attribute the hop to.
		// That happens when the logger attaches in the middle of a chain.
		if (redirectResponse === undefined || previous === undefined) {
			return;
		}

		// Saving a hop request body can outlast the next hop's event.
		// Chaining the writes keeps metadata.ndjson in chain order.
		const pending = this.#hopWrites.get(key) ?? Promise.resolve();
		const write = pending.then(() => this.#recordRedirectHop(previous, redirectResponse, event));
		this.#hopWrites.set(
			key,
			write.catch(() => undefined),
		);
		await write;
	}

	// A redirect hop never reaches loadingFinished.
	// It is finalized from the redirectResponse of the request that replaced it.
	// No body is fetched: redirects have none.
	// Network.getResponseBody would answer for the final hop anyway.
	async #recordRedirectHop(
		state: RequestState,
		response: Protocol.Network.Response,
		event: RequestWillBeSentEvent,
	): Promise<void> {
		const hop: RequestState = {
			...state,
			redirectIndex: state.redirectIndex ?? 0,
			response,
		};
		const url = response.url;
		if (!matchesFilters(url, this.#options.include, this.#options.exclude)) {
			return;
		}

		const requestBodyResult = await this.#getHopRequestBodyResult(hop);
		const metadata: CompletedResponseMetadata = {
			...createCompletedMetadata(
				hop,
				{
					encodedDataLength: response.encodedDataLength,
					requestId: event.requestId,
					timestamp: event.timestamp,
				},
				{ bodySaved: false },
				requestBodyResult,
				this.#options.storage.runTimestamp,
			),
			redirect: true,
		};
		await this.#options.storage.recordCompletedResponse(metadata);
		await this.#options.hooks?.publish(
			createResponseCompletedHookEvent(metadata, this.#options.storage.runDirectory),
		);

		if (!requestBodyResult.bodySaved && requestBodyResult.error) {
			await this.#recordRequestError(
				requestBodyErrorEvent(requestBodyResult.source),
				hop,
				requestBodyResult.error,
				url,
			);
		}
	}

	#handleResponseReceived(event: ResponseReceivedEvent, sessionId?: string): void {
		if (!sessionId) {
			return;
		}
		// A response for a detached session is ignored for the same reason as its request.
		// Streaming one would also send a command on a session the browser already destroyed.
		const session = this.#sessions.get(sessionId);
		if (session === undefined) {
			return;
		}
		const key = requestKey(sessionId, event.requestId);
		const existing = this.#requests.get(key);

		this.#requests.set(key, {
			...existing,
			loaderId: existing?.loaderId ?? event.loaderId,
			requestId: event.requestId,
			response: event.response,
			session,
			type: event.type,
		});

		// Streaming is enabled here so subsequent dataReceived events carry the payload.
		// A redirect hop is reported through redirectResponse, never responseReceived.
		// So hops are never streamed, and the hop path below is left untouched.
		// The filter runs now, earlier than loadingFinished, to bound streaming overhead.
		// An event stream is left alone: it is captured message by message instead.
		if (
			this.#options.streamBodies &&
			!this.#streams.has(key) &&
			!isEventStream(event) &&
			matchesFilters(event.response.url, this.#options.include, this.#options.exclude)
		) {
			this.#beginStream(key, event, sessionId);
		}
	}

	#beginStream(key: string, event: ResponseReceivedEvent, sessionId: string): void {
		const accumulator: StreamAccumulator = {
			aborted: false,
			chunks: [],
			enabling: Promise.resolve(),
			encodedBytes: 0,
			failed: false,
		};
		this.#streams.set(key, accumulator);
		accumulator.enabling = this.#enableStream(accumulator, event, sessionId);
	}

	async #enableStream(
		accumulator: StreamAccumulator,
		event: ResponseReceivedEvent,
		sessionId: string,
	): Promise<void> {
		const requestId = event.requestId;
		try {
			const network = this.#client.Network as unknown as {
				streamResourceContent: StreamResourceContent;
			};
			const { bufferedData } = await network.streamResourceContent({ requestId }, sessionId);
			// A chunk that ran past the limit while enabling already freed the buffer.
			if (accumulator.aborted || !bufferedData) {
				return;
			}
			// The prefix bytes were reported by dataReceived events already counted.
			// Adding their decoded size here would double-count them against the limit.
			accumulator.prefix = Buffer.from(bufferedData, "base64");
		} catch (error) {
			// An unsupported method, or a request the browser no longer holds, refetches instead.
			accumulator.failed = true;
			await this.#recordStreamFailure(error, event, sessionId);
		}
	}

	// A Chrome without the experimental method fails every single request.
	// Only the first failure of the run is recorded, so it cannot flood the file.
	// Without that record the flag would be a silent no-op.
	async #recordStreamFailure(
		error: unknown,
		event: ResponseReceivedEvent,
		sessionId: string,
	): Promise<void> {
		if (this.#streamFailureRecorded) {
			return;
		}
		this.#streamFailureRecorded = true;
		await this.#recordCaptureError(
			createErrorRecord(
				"Network.streamResourceContent",
				this.#sessions.get(sessionId) ?? { sessionId },
				error,
				event.requestId,
				event.response.url,
			),
		);
	}

	// Past the limit the partial buffer is freed and the body recorded as a skip.
	// Without --max-body-bytes a default cap still applies.
	// Media and hanging chunked responses can never reach loadingFinished at all.
	// Their buffers would otherwise accumulate for as long as the target lives.
	#accountStreamBytes(accumulator: StreamAccumulator, added: number): void {
		if (accumulator.aborted) {
			return;
		}
		accumulator.encodedBytes += added;
		if (accumulator.encodedBytes > this.#streamByteLimit()) {
			accumulator.aborted = true;
			accumulator.chunks = [];
			accumulator.prefix = undefined;
		}
	}

	#streamByteLimit(): number {
		return this.#options.maxBodyBytes ?? NETWORK_BUFFER_OPTIONS.maxResourceBufferSize;
	}

	#handleDataReceived(event: DataReceivedEvent, sessionId?: string): void {
		if (!sessionId) {
			return;
		}
		const accumulator = this.#streams.get(requestKey(sessionId, event.requestId));
		// Nothing is accumulated once the stream failed or was aborted for its size.
		if (!accumulator || accumulator.aborted || accumulator.failed) {
			return;
		}
		// Every chunk counts toward the limit, including one that predates streaming.
		// Those bytes sit inside the buffered prefix that streaming returns.
		// The loadingFinished total the buffer path guards on counts them too.
		this.#accountStreamBytes(accumulator, event.encodedDataLength);
		// A chunk without `data` predates streaming and is already inside the prefix.
		if (accumulator.aborted || event.data === undefined) {
			return;
		}
		accumulator.chunks.push(Buffer.from(event.data, "base64"));
	}

	#pendingExtraInfo(key: string): PendingExtraInfo {
		const existing = this.#extraInfo.get(key);
		if (existing) {
			return existing;
		}

		if (this.#extraInfo.size >= MAX_PENDING_EXTRA_INFO) {
			this.#evictBufferedExtraInfo();
		}

		const created: PendingExtraInfo = { orphanedRequests: 0, orphanedResponses: 0 };
		this.#extraInfo.set(key, created);
		return created;
	}

	// Drop the oldest entry that owes nothing.
	// Evicting one that still owes would turn an intended drop into a misattribution.
	// Insertion order makes the first matching key the oldest such entry.
	#evictBufferedExtraInfo(): void {
		for (const [key, pending] of this.#extraInfo) {
			if (pending.orphanedRequests === 0 && pending.orphanedResponses === 0) {
				this.#extraInfo.delete(key);
				return;
			}
		}
	}

	// The base event claims the raw headers buffered for it, but never the owed counts.
	// On a redirect only the buffered request headers belong to the new hop.
	// Buffered response headers can only be a previous hop's, so they are dropped.
	#takeExtraInfo(key: string, isRedirect: boolean): ExtraInfoState {
		const pending = this.#extraInfo.get(key);
		if (!pending) {
			return {};
		}

		const { orphanedRequests, orphanedResponses, rawRequestHeaders } = pending;
		const claimed: ExtraInfoState = isRedirect
			? { rawRequestHeaders }
			: {
					blockedCookies: pending.blockedCookies,
					cookiePartitionKey: pending.cookiePartitionKey,
					exemptedCookies: pending.exemptedCookies,
					rawRequestHeaders,
					rawResponseHeaders: pending.rawResponseHeaders,
				};

		if (orphanedRequests > 0 || orphanedResponses > 0) {
			this.#extraInfo.set(key, { orphanedRequests, orphanedResponses });
		} else {
			this.#extraInfo.delete(key);
		}

		return claimed;
	}

	// Raw request headers belong to the hop in flight while its slot is still empty.
	// A filled slot means the event ran ahead of the next hop's base event.
	// It then waits in the buffer for that hop instead.
	#handleRequestExtraInfo(event: RequestWillBeSentExtraInfoEvent, sessionId?: string): void {
		// Headers of a detached session have no base event left to join, here or later.
		if (!sessionId || !this.#sessions.has(sessionId)) {
			return;
		}
		const key = requestKey(sessionId, event.requestId);
		const pending = this.#extraInfo.get(key);
		// The hop this belongs to was already recorded without it.
		// State now under this requestId is the next hop, whose own request event is to come.
		if (pending && pending.orphanedRequests > 0) {
			pending.orphanedRequests -= 1;
			if (!hasBufferedExtraInfo(pending)) {
				this.#extraInfo.delete(key);
			}
			return;
		}

		const state = this.#requests.get(key);
		if (state && state.rawRequestHeaders === undefined) {
			state.rawRequestHeaders = event.headers;
			return;
		}

		this.#pendingExtraInfo(key).rawRequestHeaders = event.headers;
	}

	#handleResponseExtraInfo(event: ResponseReceivedExtraInfoEvent, sessionId?: string): void {
		// Same as the request headers above: nothing detached can claim them any more.
		if (!sessionId || !this.#sessions.has(sessionId)) {
			return;
		}
		const key = requestKey(sessionId, event.requestId);
		const pending = this.#extraInfo.get(key);
		// The hop this belongs to was already recorded without it.
		// State under this requestId is the next hop, whose own event is still to come.
		if (pending && pending.orphanedResponses > 0) {
			pending.orphanedResponses -= 1;
			if (!hasBufferedExtraInfo(pending)) {
				this.#extraInfo.delete(key);
			}
			return;
		}

		const state = this.#requests.get(key);
		if (state && state.rawResponseHeaders === undefined) {
			applyResponseExtraInfo(state, event);
			return;
		}

		applyResponseExtraInfo(this.#pendingExtraInfo(key), event);
	}

	async #handleLoadingFinished(event: LoadingFinishedEvent, sessionId?: string): Promise<void> {
		if (!sessionId) {
			return;
		}
		const key = requestKey(sessionId, event.requestId);
		const state = this.#requests.get(key);
		const stream = this.#streams.get(key);
		// The request is over either way, so nothing buffered under it can still be joined.
		this.#extraInfo.delete(key);
		this.#streams.delete(key);
		if (!state) {
			return;
		}

		const hopWrites = this.#hopWrites.get(key);
		this.#requests.delete(key);
		this.#hopWrites.delete(key);

		const url = state.response?.url ?? state.requestUrl;
		if (!matchesFilters(url, this.#options.include, this.#options.exclude)) {
			return;
		}

		const bodyResult = await this.#getResponseBodyResult(state, event, stream);
		const requestBodyResult = await this.#getRequestBodyResult(state);
		const metadata = createCompletedMetadata(
			state,
			event,
			bodyResult,
			requestBodyResult,
			this.#options.storage.runTimestamp,
		);
		// The terminal response closes the chain, so its record appends last.
		await hopWrites;
		await this.#options.storage.recordCompletedResponse(metadata);
		await this.#options.hooks?.publish(
			createResponseCompletedHookEvent(metadata, this.#options.storage.runDirectory),
		);

		if (!bodyResult.bodySaved && bodyResult.error) {
			await this.#recordRequestError(
				responseBodyErrorEvent(bodyResult.skipped),
				state,
				bodyResult.error,
				url,
			);
		}

		if (!requestBodyResult.bodySaved && requestBodyResult.error) {
			await this.#recordRequestError(
				requestBodyErrorEvent(requestBodyResult.source),
				state,
				requestBodyResult.error,
				url,
			);
		}
	}

	async #recordRequestError(
		event: string,
		state: RequestState,
		error: string,
		url: string | undefined,
	): Promise<void> {
		await this.#recordCaptureError(
			createErrorRecord(event, state.session, error, state.requestId, url),
		);
	}

	async #recordCaptureError(record: ErrorRecord): Promise<void> {
		await this.#options.storage.recordError(record);
		await this.#options.hooks?.publish(createCaptureErrorHookEvent(record, this.#options.storage));
	}

	// Inline post data is the only request body a finalized hop can claim.
	// Network.getRequestPostData answers for the request now in flight, so a body
	// Chrome left out of the event is reported as a loss instead of fetched.
	async #getHopRequestBodyResult(state: RequestState): Promise<Partial<RequestBodySaveResult>> {
		if (state.requestPostData !== undefined) {
			return await this.#options.storage.recordRequestBody(state, state.requestPostData);
		}

		if (state.hasPostData !== true) {
			return {};
		}

		return {
			bodySaved: false,
			error: HOP_POST_DATA_ERROR,
			source: "requestWillBeSent",
		};
	}

	async #getRequestBodyResult(state: RequestState): Promise<Partial<RequestBodySaveResult>> {
		if (state.requestPostData !== undefined) {
			return await this.#options.storage.recordRequestBody(state, state.requestPostData);
		}

		if (!state.hasPostData) {
			return {};
		}

		try {
			const body = await this.#client.Network.getRequestPostData(
				{ requestId: state.requestId },
				state.session.sessionId,
			);
			if (typeof body.postData !== "string") {
				return {
					bodySaved: false,
					error: "Network.getRequestPostData returned no postData.",
					source: "getRequestPostData",
				};
			}

			return await this.#options.storage.recordRequestBody(state, body.postData);
		} catch (error) {
			return {
				bodySaved: false,
				error: errorMessage(error),
				source: "getRequestPostData",
			};
		}
	}

	// A streamed request finalizes from its accumulated bytes; anything else refetches.
	// A stream that failed or is unsupported also falls back so no body is lost.
	async #getResponseBodyResult(
		state: RequestState,
		event: LoadingFinishedEvent,
		stream: StreamAccumulator | undefined,
	): Promise<ResponseBodyResult> {
		if (!stream) {
			return await this.#getBodyResult(state, event);
		}

		// Wait for the buffered prefix, or for the failure that sends us to the fallback.
		await stream.enabling;
		if (stream.failed) {
			return await this.#getBodyResult(state, event);
		}
		if (stream.aborted) {
			return {
				bodySaved: false,
				error: `Skipped because the streamed body exceeded ${this.#streamLimitLabel()}.`,
				skipped: true,
			};
		}
		// Chrome leaves the payload out on some service-worker and cache paths.
		// Saving nothing would then be a successful zero-byte body.
		// The fallback answers instead, fetching the body or recording the loss.
		if (streamedByteLength(stream) === 0) {
			return await this.#getBodyResult(state, event);
		}

		return await this.#finalizeStream(state, stream);
	}

	#streamLimitLabel(): string {
		const limit = this.#options.maxBodyBytes;
		return limit === undefined
			? `the ${this.#streamByteLimit()} byte default stream limit`
			: `--max-body-bytes ${limit}`;
	}

	// The prefix is everything up to enabling, so it leads the streamed chunks.
	async #finalizeStream(
		state: RequestState,
		stream: StreamAccumulator,
	): Promise<ResponseBodyResult> {
		const parts = stream.prefix ? [stream.prefix, ...stream.chunks] : stream.chunks;
		const assembled = Buffer.concat(parts);
		// Drop the per-chunk references before the write; the completed body is not retained.
		stream.chunks = [];
		stream.prefix = undefined;
		// The bytes are saved as they are; only how CDP delivered them is base64.
		return {
			...(await this.#options.storage.recordBodyBytes(state, assembled)),
			base64Encoded: true,
		};
	}

	async #getBodyResult(
		state: RequestState,
		event: LoadingFinishedEvent,
	): Promise<ResponseBodyResult> {
		if (
			this.#options.maxBodyBytes !== undefined &&
			event.encodedDataLength > this.#options.maxBodyBytes
		) {
			return {
				bodySaved: false,
				error: `Skipped because encodedDataLength ${event.encodedDataLength} exceeds --max-body-bytes ${this.#options.maxBodyBytes}.`,
				skipped: true,
			};
		}

		try {
			const body = await this.#client.Network.getResponseBody(
				{ requestId: state.requestId },
				state.session.sessionId,
			);
			return await this.#options.storage.recordBody(
				state,
				body as Protocol.Network.GetResponseBodyResponse,
			);
		} catch (error) {
			return {
				bodySaved: false,
				error: errorMessage(error),
			};
		}
	}

	async #handleLoadingFailed(event: LoadingFailedEvent, sessionId?: string): Promise<void> {
		if (!sessionId) {
			return;
		}
		const key = requestKey(sessionId, event.requestId);
		const state = this.#requests.get(key);
		const hopWrites = this.#hopWrites.get(key);
		this.#requests.delete(key);
		this.#hopWrites.delete(key);
		this.#extraInfo.delete(key);
		this.#streams.delete(key);

		// Hops that already completed belong in the capture before the failure.
		await hopWrites;
		await this.#recordCaptureError({
			error: event.errorText,
			event: "Network.loadingFailed",
			requestId: event.requestId,
			sessionId,
			targetId: state?.session.targetId,
			timestamp: nowIso(),
			url: state?.response?.url ?? state?.requestUrl,
		});
	}

	// Network.webSocketCreated carries the socket URL, and it is the only event that does.
	// Handshake requests never reach #requests, so the URL is kept until the socket closes.
	#handleWebSocketCreated(event: WebSocketCreatedEvent, sessionId?: string): void {
		// A socket of a session already detached would never be swept again.
		if (!sessionId || !this.#sessions.has(sessionId)) {
			return;
		}
		this.#webSockets.set(requestKey(sessionId, event.requestId), event.url);
	}

	#handleWebSocketClosed(event: WebSocketClosedEvent, sessionId?: string): void {
		if (!sessionId) {
			return;
		}
		const key = requestKey(sessionId, event.requestId);
		this.#webSockets.delete(key);
		// A handshake buffers ExtraInfo that no requestWillBeSent will ever claim.
		this.#extraInfo.delete(key);
	}

	async #handleWebSocketFrame(
		direction: WebSocketFrameRecord["direction"],
		event: WebSocketFrameEvent,
		sessionId?: string,
	): Promise<void> {
		if (!sessionId) {
			return;
		}
		const session = this.#sessions.get(sessionId);
		const frame: WebSocketFrameRecord = {
			direction,
			opcode: event.response.opcode,
			payloadData: event.response.payloadData,
			requestId: event.requestId,
			sessionId,
			targetId: session?.targetId,
			timestamp: nowIso(),
			// A socket the logger never saw open, or one already closed, has no URL here.
			// The frame is still recorded, payload included.
			url: this.#webSockets.get(requestKey(sessionId, event.requestId)),
		};
		await this.#options.storage.recordWebSocketFrame(frame);
		await this.#options.hooks?.publish(createWebSocketFrameHookEvent(frame, this.#options.storage));
	}

	// An EventSource connection normally stays open for the life of the page, so
	// Network.loadingFinished usually never fires and no response body is retrieved.
	// It does fire when the server ends the stream or the page closes it.
	// A normal response is recorded then, with the messages still in their own file.
	// Each message arrives as its own event regardless, and is recorded on its own.
	//
	// Unlike a WebSocket handshake, an EventSource connection does emit
	// Network.requestWillBeSent, so #requests holds the stream while it is open.
	// A message arriving once that state is gone, dropped on detach, records no url.
	async #handleEventSourceMessage(
		event: EventSourceMessageReceivedEvent,
		sessionId?: string,
	): Promise<void> {
		if (!sessionId) {
			return;
		}
		const session = this.#sessions.get(sessionId);
		const state = this.#requests.get(requestKey(sessionId, event.requestId));
		const message: EventSourceMessageRecord = {
			data: event.data,
			eventId: event.eventId,
			eventName: event.eventName,
			requestId: event.requestId,
			sessionId,
			targetId: session?.targetId,
			timestamp: nowIso(),
			url: state?.response?.url ?? state?.requestUrl,
		};
		await this.#options.storage.recordEventSourceMessage(message);
		await this.#options.hooks?.publish(
			createEventSourceMessageHookEvent(message, this.#options.storage),
		);
	}

	// Every download the logger has seen lives here, running or already recorded.
	// A settled entry is kept so a repeated terminal event writes no second record.
	// Insertion order makes the first key the oldest download seen this run.
	// Unlike #evictBufferedExtraInfo the cap does not skip an entry still running.
	// The oldest entry is normally one already recorded.
	// Evicting a running one costs the url and filename of its record, never the record.
	#pendingDownload(guid: string): PendingDownload {
		const existing = this.#downloads.get(guid);
		if (existing) {
			return existing;
		}

		if (this.#downloads.size >= MAX_PENDING_DOWNLOADS) {
			const oldest = this.#downloads.keys().next().value;
			if (oldest !== undefined) {
				this.#downloads.delete(oldest);
			}
		}

		const created: PendingDownload = {};
		this.#downloads.set(guid, created);
		return created;
	}

	// Storage hashes the saved file before it appends, which shutdown has to wait for.
	// The count is what tells close() a slow hash is the reason the drain has not ended.
	async #recordDownload(
		event: DownloadProgressEvent,
		state: DownloadRecord["state"],
		pending: PendingDownload,
	): Promise<DownloadRecord> {
		this.#hashingDownloads += 1;
		try {
			return await this.#options.storage.recordDownload({
				frameId: pending.frameId,
				guid: event.guid,
				receivedBytes: event.receivedBytes,
				startedAt: pending.startedAt,
				state,
				suggestedFilename: pending.suggestedFilename,
				timestamp: nowIso(),
				totalBytes: event.totalBytes,
				url: pending.url,
			});
		} finally {
			this.#hashingDownloads -= 1;
		}
	}

	// Browser.downloadWillBegin is the only event carrying the URL and suggested filename.
	// Under "allowAndName" the file on disk is named after the GUID and nothing else.
	// This mapping is therefore what makes a saved download identifiable afterwards.
	#handleDownloadWillBegin(event: DownloadWillBeginEvent): void {
		const pending = this.#pendingDownload(event.guid);
		pending.frameId = event.frameId;
		pending.startedAt = nowIso();
		pending.suggestedFilename = event.suggestedFilename;
		pending.url = event.url;
	}

	// Progress repeats while bytes arrive; only a terminal state produces a record.
	// A canceled download is recorded too, with no file, so the loss is visible.
	// A download the logger never saw begin still gets a record, without url or filename.
	// Chrome keeps reporting a finished download while unrelated fields of it change.
	// An interrupted download is reported as canceled and may still complete later.
	// A repeat of the state already recorded is therefore ignored.
	// A completion still supersedes an earlier cancellation, appending its own record.
	async #handleDownloadProgress(event: DownloadProgressEvent): Promise<void> {
		const state = terminalDownloadState(event.state);
		if (state === undefined) {
			return;
		}
		const pending = this.#pendingDownload(event.guid);
		if (pending.settledState === state || pending.settledState === "completed") {
			return;
		}
		pending.settledState = state;

		const record = await this.#recordDownload(event, state, pending);
		if (record.error !== undefined) {
			await this.#recordCaptureError({
				error: record.error,
				event: "Browser.downloadProgress",
				timestamp: nowIso(),
				url: record.url,
			});
		}
		// Only a saved download has a file to hand a plugin, so only it publishes.
		if (record.state === "completed" && record.file !== undefined) {
			await this.#options.hooks?.publish(
				createDownloadCompletedHookEvent(record, this.#options.storage),
			);
		}
	}

	// A frame-level protocol error leaves no other trace.
	// The socket may stay open, and no frame event follows for the failed frame.
	async #handleWebSocketFrameError(
		event: WebSocketFrameErrorEvent,
		sessionId?: string,
	): Promise<void> {
		if (!sessionId) {
			return;
		}
		await this.#recordCaptureError({
			error: event.errorMessage,
			event: "Network.webSocketFrameError",
			requestId: event.requestId,
			sessionId,
			targetId: this.#sessions.get(sessionId)?.targetId,
			timestamp: nowIso(),
			url: this.#webSockets.get(requestKey(sessionId, event.requestId)),
		});
	}
}

type StartedCdpLogger = {
	close: () => Promise<void>;
	closeBrowser: () => Promise<void>;
	closed: Promise<void>;
	// Called before the browser is closed, and a no-op without --snapshot-storage.
	snapshotStorage: () => Promise<void>;
};

const startCdpLogger = async (options: StartLoggerOptions): Promise<StartedCdpLogger> => {
	const endpoint = new URL(options.cdp);
	const connectionOptions = {
		host: endpoint.hostname,
		port: Number(endpoint.port || (endpoint.protocol === "https:" ? 443 : 80)),
		secure: endpoint.protocol === "https:",
	};
	const version = await CDP.Version(connectionOptions);
	const client = await CDP({ ...connectionOptions, target: version.webSocketDebuggerUrl });
	const closed = new Promise<void>((resolve) => {
		client.on("disconnect", () => resolve());
	});
	const logger = new CdpResponseLogger(client, options);
	await logger.start();
	return {
		close: () => logger.close(),
		closeBrowser: () => client.Browser.close(),
		closed,
		snapshotStorage: () => logger.snapshotStorage(),
	};
};

export {
	CdpResponseLogger,
	MAX_DATABASES_PER_ORIGIN,
	MAX_ENTRIES_PER_OBJECT_STORE,
	MAX_OBJECT_STORES_PER_DATABASE,
	MAX_SNAPSHOT_ENTRIES,
	MAX_SNAPSHOT_ORIGINS,
	NETWORK_BUFFER_OPTIONS,
	SNAPSHOT_TIMEOUT_MS,
	collectSnapshotOrigins,
	createCompletedMetadata,
	startCdpLogger,
};
