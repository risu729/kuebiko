import { resolve as resolvePath } from "node:path";

import CDP from "chrome-remote-interface";
import type { Protocol } from "devtools-protocol";

import { DOWNLOADS_DIRECTORY } from "./constants";
import {
	createCaptureErrorHookEvent,
	createDownloadCompletedHookEvent,
	createEventSourceMessageHookEvent,
	createResponseCompletedHookEvent,
	createWebSocketFrameHookEvent,
} from "./plugins";
import type { HookPublisher } from "./plugins";
import { matchesFilters } from "./sanitize";
import {
	MAX_DATABASES_PER_ORIGIN,
	MAX_ENTRIES_PER_OBJECT_STORE,
	MAX_OBJECT_STORES_PER_DATABASE,
	STORAGE_TARGET_TYPES,
	captureStorageSnapshot,
	readObjectStorePage,
	storageOriginOf,
} from "./storage-snapshot";
import { settlesWithin } from "./timeout";
import type {
	BodySaveResult,
	CompletedResponseMetadata,
	DownloadRecord,
	ErrorRecord,
	EventSourceMessageRecord,
	ExtraInfoState,
	LoggerStorage,
	RequestState,
	RequestBodySaveResult,
	RequestBodySource,
	SessionInfo,
	StorageChangeRecord,
	WebSocketFrameRecord,
} from "./types";

// Only the logger reads these, so they stay next to the class they configure.
type StartLoggerOptions = {
	// Subscribes the ExtraInfo events, which is the only way raw cookies are recorded.
	captureCookies?: boolean | undefined;
	// Points browser downloads at the run directory and subscribes the Browser events.
	captureDownloads?: boolean | undefined;
	cdp: string;
	// Overrides the shutdown drain budgets; only tests need anything but the defaults.
	drainTimeoutMs?: number | undefined;
	exclude?: RegExp | undefined;
	extendedDrainTimeoutMs?: number | undefined;
	hooks?: HookPublisher | undefined;
	include?: RegExp | undefined;
	maxBodyBytes?: number | undefined;
	// Overrides the download-behavior reset budget; only tests need anything but the default.
	resetTimeoutMs?: number | undefined;
	// Reads the storage domains once at the end of the run; nothing is enabled before.
	snapshotStorage?: boolean | undefined;
	// Overrides the snapshot deadline; only tests need anything but the default.
	snapshotTimeoutMs?: number | undefined;
	streamBodies?: boolean | undefined;
	storage: LoggerStorage;
	// Follows web storage and IndexedDB for the whole run instead of reading them once.
	trackStorage?: boolean | undefined;
	verbose: boolean;
};

type CdpClient = CDP.Client;
// The client types send() to the command names its bundled protocol copy knows.
// The storage domains are addressed by name here, so they use a widened view.
type RawSend = (method: string, params?: object, sessionId?: string) => Promise<unknown>;
type TerminableSocket = { terminate?: () => void };
type TargetAttachedEvent = Protocol.Target.AttachedToTargetEvent;
type TargetDetachedEvent = Protocol.Target.DetachedFromTargetEvent;
type RequestWillBeSentEvent = Protocol.Network.RequestWillBeSentEvent;
type RequestWillBeSentExtraInfoEvent = Protocol.Network.RequestWillBeSentExtraInfoEvent;
type ResponseReceivedEvent = Protocol.Network.ResponseReceivedEvent;
type ResponseReceivedExtraInfoEvent = Protocol.Network.ResponseReceivedExtraInfoEvent;
type TargetInfoChangedEvent = Protocol.Target.TargetInfoChangedEvent;
// Only the cleared event names no key, so the union is narrowed by `in` where it matters.
type DomStorageEvent =
	| Protocol.DOMStorage.DomStorageItemAddedEvent
	| Protocol.DOMStorage.DomStorageItemRemovedEvent
	| Protocol.DOMStorage.DomStorageItemUpdatedEvent
	| Protocol.DOMStorage.DomStorageItemsClearedEvent;
type IndexedDbContentUpdatedEvent = Protocol.Storage.IndexedDBContentUpdatedEvent;
// The read chain of one object store: what is running, and whether one is waiting.
type QueuedStoreRead = { chain: Promise<void>; queued: boolean };
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
// Restoring the download behavior is one command sent to a browser that outlives the run.
// It gets a round-trip budget instead of the drain budget it used to share.
const CDP_RESET_TIMEOUT_MS = 5_000;
// The writers close right after the drain, so a late append from a handler is refused.
// Its record never reaches the file the summary already counted it in.
// Hashing a download or assembling a large streamed body takes far longer than the rest.
// Any handler still running therefore gets the longer budget, not only the download path.
const CDP_EXTENDED_DRAIN_TIMEOUT_MS = 30_000;

// A WebSocket handshake gets ExtraInfo events but never a requestWillBeSent.
// Those entries are only cleaned up by the socket closing or the target detaching.
// The cap keeps a long capture bounded even when neither happens.
const MAX_PENDING_EXTRA_INFO = 1_000;

// Download events are browser-wide, so no target detaching ever sweeps this map.
// A download whose progress events stop is never finalized.
// A finished one is kept so a repeated terminal event writes no second record.
// The cap bounds the map like the one above, dropping the oldest entry it holds.
const MAX_PENDING_DOWNLOADS = 1_000;

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

const terminateClientSocket = (client: CdpClient): void => {
	const socket = Reflect.get(client, "_ws") as TerminableSocket | undefined;
	socket?.terminate?.();
};

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

class CdpResponseLogger {
	readonly #client: CdpClient;
	// Set once the browser connection is gone, so shutdown stops sending to it.
	#disconnected = false;
	// Set once this run really did install the download override, and only then.
	// The default it would be reset to is not this run's to restore otherwise.
	#downloadBehaviorApplied = false;
	// Downloads seen this run keyed by GUID, only populated with --capture-downloads.
	readonly #downloads = new Map<string, PendingDownload>();
	// Raw headers with no request state to live on yet, keyed like #requests.
	// Only populated with --capture-cookies, since nothing else subscribes ExtraInfo.
	readonly #extraInfo = new Map<string, PendingExtraInfo>();
	// Redirect hop writes in flight, keyed like #requests so a chain appends in order.
	readonly #hopWrites = new Map<string, Promise<void>>();
	// The session tracking IndexedDB for an origin, keyed by origin.
	// IndexedDB answers per origin, so one session tracks it for every tab on that origin.
	// Tracking dies with the session that asked for it, hence the owner kept here.
	// Detach drops the entry, which lets the next session of that origin take it over.
	readonly #indexedDbOrigins = new Map<string, string>();
	// One read in flight per object store, keyed origin:database:store, plus at most one
	// More queued behind it. A burst of updates to one store therefore costs two reads
	// Rather than one per event: the queued read runs after the current one and sees
	// The same final state every superseded read would have. Without that bound a bulk
	// IndexedDB import queued one 500-entry read per commit, and the reads still waiting
	// When the writers closed were counted in the summary but never reached the file.
	// The chain clears itself, so nothing here is tied to a session or swept on detach.
	readonly #indexedDbReads = new Map<string, QueuedStoreRead>();
	readonly #options: StartLoggerOptions;
	readonly #pendingEvents = new Set<Promise<void>>();
	readonly #requests = new Map<string, RequestState>();
	readonly #sessions = new Map<string, SessionInfo>();
	// The http(s) origins each session has already read its web storage for.
	// The localStorage area is shared per origin and sessionStorage belongs to the tab,
	// So the session and the origin together are what makes one baseline read unique.
	// It also says which sessions are on an origin, which is how a detached IndexedDB
	// Owner hands its tracking to a tab still open on the same origin.
	readonly #sessionOrigins = new Map<string, Set<string>>();
	// Streamed body buffers keyed like #requests, only populated with --stream-bodies.
	// Held only while a request is in flight, then dropped on finish, failure, or detach.
	readonly #streams = new Map<string, StreamAccumulator>();
	// One record per run: an unsupported method fails on every request there is.
	#streamFailureRecorded = false;
	// The session that owns each attached target, keyed by target id.
	// A target is only ever captured through its owning session, so it is captured once.
	readonly #targetSessions = new Map<string, string>();
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

	// The snapshot is a phase of its own, over domains the request path never touches.
	// Only the flag and the live connection are decided here.
	async snapshotStorage(): Promise<void> {
		if (!this.#options.snapshotStorage) {
			return;
		}
		if (this.#disconnected) {
			await this.#recordCaptureError(
				createErrorRecord(
					"Storage.snapshot",
					undefined,
					"The browser disconnected before the storage snapshot could be taken.",
				),
			);
			return;
		}

		await captureStorageSnapshot({
			client: this.#client,
			hooks: this.#options.hooks,
			// The snapshot never has a session or a request id to name.
			recordError: async (event, error, url) => {
				await this.#recordCaptureError(createErrorRecord(event, undefined, error, undefined, url));
			},
			sessions: this.#sessions.values(),
			storage: this.#options.storage,
			timeoutMs: this.#options.snapshotTimeoutMs,
		});
	}

	async close(): Promise<void> {
		// The override has to go back before the connection that installed it is closed.
		await this.#restoreDownloadBehavior();
		const closing = this.#client.close();
		if (!(await settlesWithin(closing, CDP_CLOSE_TIMEOUT_MS))) {
			terminateClientSocket(this.#client);
			await settlesWithin(closing, CDP_DRAIN_TIMEOUT_MS);
		}
		const budget = this.#options.drainTimeoutMs ?? CDP_DRAIN_TIMEOUT_MS;
		if (
			!(await settlesWithin(this.#drainPendingEvents(), budget)) &&
			this.#pendingEvents.size > 0
		) {
			// Every handler still running holds a record, so all of them get the longer budget.
			await settlesWithin(
				this.#drainPendingEvents(),
				this.#options.extendedDrainTimeoutMs ?? CDP_EXTENDED_DRAIN_TIMEOUT_MS,
			);
		}
		await this.#recordAbandonedEvents();
	}

	// Restoring the default is a command round trip, not a drain, so it gets its own budget.
	// A browser too busy to answer within it used to be abandoned in silence.
	// That left the user's own Chrome saving every later download into a finished run.
	async #restoreDownloadBehavior(): Promise<void> {
		const budget = this.#options.resetTimeoutMs ?? CDP_RESET_TIMEOUT_MS;
		if (await settlesWithin(this.#resetDownloadBehavior(), budget)) {
			return;
		}

		await this.#recordCaptureError(
			createErrorRecord(
				"Browser.setDownloadBehavior",
				undefined,
				`Restoring the default download behavior did not answer within ${budget}ms; the browser may still save downloads into ${this.#downloadDirectory()}.`,
			),
		);
	}

	// A handler that outlived both budgets is abandoned here, and the writers close next.
	// One that finishes before they do still records; one that finishes after is refused.
	// Which of the two it was is not knowable here, so the record says only that much.
	// It is written while the writers are still open, whichever way the handlers go.
	async #recordAbandonedEvents(): Promise<void> {
		const abandoned = this.#pendingEvents.size;
		if (abandoned === 0) {
			return;
		}

		await this.#recordCaptureError(
			createErrorRecord(
				"Cdp.drainTimeout",
				undefined,
				`Shutdown abandoned ${abandoned} event handler(s) still running; their records may not have been recorded.`,
			),
		);
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
			this.#downloadBehaviorApplied = true;
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
	// Only an override this run installed is undone here.
	// A start that threw first, or a setDownloadBehavior that failed, installed none.
	// Sending the default then would clear a behavior the user or another client set.
	async #resetDownloadBehavior(): Promise<void> {
		if (!this.#downloadBehaviorApplied || this.#disconnected) {
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
		// Storage is followed for the whole run only with --track-storage.
		// A run without the flag subscribes none of this and enables neither domain,
		// So the storage domains stay closed exactly as they were before the flag.
		// Target.targetInfoChanged is already flowing from setDiscoverTargets: a page
		// Attaches on about:blank, and this says it reached an origin worth reading.
		if (this.#options.trackStorage) {
			this.#client.on("Target.targetInfoChanged", (event) => {
				this.#trackEvent(this.#handleTargetInfoChanged(event as TargetInfoChangedEvent));
			});
			this.#client.on("DOMStorage.domStorageItemAdded", (event, sessionId) => {
				this.#trackEvent(
					this.#handleDomStorageChange("added", event as DomStorageEvent, sessionId),
				);
			});
			this.#client.on("DOMStorage.domStorageItemUpdated", (event, sessionId) => {
				this.#trackEvent(
					this.#handleDomStorageChange("updated", event as DomStorageEvent, sessionId),
				);
			});
			this.#client.on("DOMStorage.domStorageItemRemoved", (event, sessionId) => {
				this.#trackEvent(
					this.#handleDomStorageChange("removed", event as DomStorageEvent, sessionId),
				);
			});
			this.#client.on("DOMStorage.domStorageItemsCleared", (event, sessionId) => {
				this.#trackEvent(
					this.#handleDomStorageChange("cleared", event as DomStorageEvent, sessionId),
				);
			});
			this.#client.on("Storage.indexedDBContentUpdated", (event, sessionId) => {
				this.#trackEvent(
					this.#handleIndexedDbContentUpdated(event as IndexedDbContentUpdatedEvent, sessionId),
				);
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
			// Auto-attach already took the targets that existed when it was sent.
			// Attaching to one of those again only buys a session #handleAttached discards.
			if (!isInspectableTarget(targetInfo) || this.#targetSessions.has(targetInfo.targetId)) {
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
		const targetId = event.targetInfo.targetId;
		const session: SessionInfo = {
			sessionId: event.sessionId,
			targetId,
			targetType: event.targetInfo.type,
			targetUrl: event.targetInfo.url,
		};

		if (!isInspectableTarget(event.targetInfo)) {
			this.#sessions.set(event.sessionId, session);
			this.#verbose(`skip target type=${event.targetInfo.type} id=${targetId}`);
			return;
		}

		// A browser-level setAutoAttach attaches to the targets that already exist.
		// #attachExistingTargets attaches to those very same ones, so each arrives twice.
		// Enabling Network on both sessions makes the browser deliver its events twice.
		// Every request of a pre-existing target then reached metadata.ndjson twice over.
		// The first session to arrive owns the target and is the only one that captures it.
		// The claim is taken before the first await, so two handlers cannot both take it.
		const owner = this.#targetSessions.get(targetId);
		if (owner !== undefined && owner !== event.sessionId) {
			// The duplicate session captures nothing, so nothing is ever keyed under it.
			this.#verbose(
				`duplicate session=${event.sessionId} target=${event.targetInfo.type} id=${targetId} owner=${owner}`,
			);
			// A target attached with waitForDebuggerOnStart is held on every session it has.
			// Leaving this one unresumed would leave the target itself waiting.
			await this.#resumeTarget(event, session);
			return;
		}
		this.#targetSessions.set(targetId, event.sessionId);
		this.#sessions.set(event.sessionId, session);

		try {
			await this.#client.Network.enable(NETWORK_BUFFER_OPTIONS, event.sessionId);
			this.#log(
				`attached target=${event.targetInfo.type} session=${event.sessionId} id=${targetId}`,
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
		// Only the owning session releases its target, and a duplicate never held one.
		// A target attaching again after this is then captured through its new session.
		if (
			session?.targetId !== undefined &&
			this.#targetSessions.get(session.targetId) === event.sessionId
		) {
			this.#targetSessions.delete(session.targetId);
		}
		// Every counted map is keyed by session and request id, so one prefix sweeps them all.
		// Request state is only ever stored under the key built from the session it names.
		// The prefix assumes no session id is itself a prefix of another, as Chrome's hex ids are not.
		// What each map would otherwise leak past its session counts as its own dropped record.
		// That is a request nothing can complete, or buffered ExtraInfo no base event will claim.
		// It is a stream still filling its buffer too, or a socket url nothing else would delete.
		const sessionPrefix = `${event.sessionId}:`;
		let dropped = 0;
		for (const keyed of [this.#requests, this.#extraInfo, this.#streams, this.#webSockets]) {
			for (const key of keyed.keys()) {
				if (key.startsWith(sessionPrefix)) {
					keyed.delete(key);
					dropped += 1;
				}
			}
		}

		// A hop write in flight belongs to a request the loop above already counted.
		// Counting it again would inflate the dropped total, so it is swept on its own.
		for (const key of this.#hopWrites.keys()) {
			if (key.startsWith(sessionPrefix)) {
				this.#hopWrites.delete(key);
			}
		}

		// Storage bookkeeping is swept on its own, because losing it drops no capture.
		// The origin set only says which areas were already read on this session.
		// An IndexedDB owner only says which session holds Chrome's tracking for an origin.
		// Chrome drops that tracking with the session, so it is handed to a tab still open
		// On the origin. Waiting for another Target.targetInfoChanged would not do: a tab
		// That already navigated there never reports one, and its writes would go unseen
		// For the rest of the run with nothing saying so.
		this.#sessionOrigins.delete(event.sessionId);
		const orphanedOrigins = [...this.#indexedDbOrigins]
			.filter(([, owner]) => owner === event.sessionId)
			.map(([origin]) => origin);
		for (const origin of orphanedOrigins) {
			this.#indexedDbOrigins.delete(origin);
		}

		// Downloads are tracked browser-wide and outlive the target that started them.
		// Nothing about them is swept here.
		this.#verbose(`detached session=${event.sessionId}`);
		// A tab closing with nothing in flight is ordinary, and so are OOPIF and worker exits.
		// Recording those would bury the detaches that did drop capture state.
		// It would bury them in errors.ndjson and in the per-host breakdown alike.
		if (session && dropped > 0) {
			// Several of the swept maps can hold an entry for the very same request.
			// A websocket holds an entry here without ever having had request state.
			// The total therefore counts dropped state entries, not active requests.
			await this.#recordCaptureError(
				createErrorRecord(
					"Target.detachedFromTarget",
					session,
					`Target detached with ${dropped} dropped capture state ${dropped === 1 ? "entry" : "entries"}.`,
					undefined,
					session.targetUrl,
				),
			);
		}

		// Last, so a handover that has to talk to the browser cannot delay the sweep above.
		for (const origin of orphanedOrigins) {
			await this.#handOverIndexedDb(origin);
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
			createResponseCompletedHookEvent(metadata, this.#options.storage),
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
		// Enabling a stream is capture work like any handler, so shutdown drains it.
		// Its rejection is handled here rather than left to take the process down.
		this.#trackEvent(accumulator.enabling);
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
			try {
				await this.#recordStreamFailure(error, event, sessionId);
			} catch {
				// The loadingFinished handler awaits this promise before it records the response.
				// A failed error record must not abort that and lose the whole metadata line.
			}
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

	// A request ends at loadingFinished or at loadingFailed, and both end it the same way.
	// Every map keyed under it is dropped, whether or not the handler goes on to record.
	// Buffered ExtraInfo has no base event left to join, so it is dropped without being read.
	// Taking them together is what keeps the next map from being forgotten in one of the two.
	#takeRequest(key: string): {
		hopWrites: Promise<void> | undefined;
		state: RequestState | undefined;
		stream: StreamAccumulator | undefined;
	} {
		const taken = {
			hopWrites: this.#hopWrites.get(key),
			state: this.#requests.get(key),
			stream: this.#streams.get(key),
		};
		this.#requests.delete(key);
		this.#hopWrites.delete(key);
		this.#extraInfo.delete(key);
		this.#streams.delete(key);

		return taken;
	}

	async #handleLoadingFinished(event: LoadingFinishedEvent, sessionId?: string): Promise<void> {
		if (!sessionId) {
			return;
		}
		const { hopWrites, state, stream } = this.#takeRequest(requestKey(sessionId, event.requestId));
		if (!state) {
			return;
		}

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
			createResponseCompletedHookEvent(metadata, this.#options.storage),
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
		const { hopWrites, state } = this.#takeRequest(requestKey(sessionId, event.requestId));

		// Hops that already completed belong in the capture before the failure.
		await hopWrites;
		// A failure with no request state left names the session it arrived on and nothing more.
		await this.#recordCaptureError(
			createErrorRecord(
				"Network.loadingFailed",
				state?.session ?? { sessionId },
				event.errorText,
				event.requestId,
				state?.response?.url ?? state?.requestUrl,
			),
		);
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
	// The handler stays in #pendingEvents until then, which is what holds the drain open.
	async #recordDownload(
		event: DownloadProgressEvent,
		state: DownloadRecord["state"],
		pending: PendingDownload,
	): Promise<DownloadRecord> {
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
			// Downloads are browser-wide, so this one belongs to no session at all.
			await this.#recordCaptureError(
				createErrorRecord(
					"Browser.downloadProgress",
					undefined,
					record.error,
					undefined,
					record.url,
				),
			);
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
		await this.#recordCaptureError(
			createErrorRecord(
				"Network.webSocketFrameError",
				this.#sessions.get(sessionId) ?? { sessionId },
				event.errorMessage,
				event.requestId,
				this.#webSockets.get(requestKey(sessionId, event.requestId)),
			),
		);
	}

	// The storage domains are addressed by name, so they need the widened send.
	#rawSend(method: string, params: object, sessionId: string): Promise<unknown> {
		return (this.#client.send as unknown as RawSend)(method, params, sessionId);
	}

	// A storage read answers with its fallback instead of throwing, exactly as the
	// End-of-run snapshot does: one unreadable area must not stop the run from
	// Following every other one.
	async #sendStorage<Result>(
		method: string,
		params: object,
		session: SessionInfo,
		securityOrigin: string | undefined,
		fallback: Result,
	): Promise<Result> {
		try {
			return (await this.#rawSend(method, params, session.sessionId)) as Result;
		} catch (error) {
			await this.#recordCaptureError(
				createErrorRecord(method, session, error, undefined, securityOrigin),
			);
			return fallback;
		}
	}

	// A storage command whose answer carries nothing, so only whether it worked matters.
	// Enabling is deferred to the first origin a session reaches, which is why a run
	// That never navigates anywhere opens neither domain.
	async #sendStorageOk(
		method: string,
		params: object,
		session: SessionInfo,
		securityOrigin: string,
	): Promise<boolean> {
		try {
			await this.#rawSend(method, params, session.sessionId);
			return true;
		} catch (error) {
			await this.#recordCaptureError(
				createErrorRecord(method, session, error, undefined, securityOrigin),
			);
			return false;
		}
	}

	// Sessions are keyed by session id, and only a handful are attached at once.
	#sessionOfTarget(targetId: string): SessionInfo | undefined {
		for (const session of this.#sessions.values()) {
			if (session.targetId === targetId) {
				return session;
			}
		}

		return undefined;
	}

	// A page attaches on about:blank, so neither storage area can be read at attach time.
	// This is what says a target reached an origin that has storage to follow.
	// A target navigating on is read again, because the new origin is a new area.
	async #handleTargetInfoChanged(event: TargetInfoChangedEvent): Promise<void> {
		const securityOrigin = storageOriginOf(event.targetInfo.url);
		if (securityOrigin === undefined || !STORAGE_TARGET_TYPES.has(event.targetInfo.type)) {
			return;
		}
		const session = this.#sessionOfTarget(event.targetInfo.targetId);
		if (session === undefined) {
			return;
		}

		await this.#readDomStorageBaseline(session, securityOrigin);
		await this.#trackIndexedDb(session, securityOrigin);
	}

	// Both web storage areas of one origin on one session, read once.
	// Chrome only reports what changes after the domain is enabled, so without this
	// The keys a site wrote before the logger arrived would appear nowhere.
	async #readDomStorageBaseline(session: SessionInfo, securityOrigin: string): Promise<void> {
		const origins = this.#sessionOrigins.get(session.sessionId) ?? new Set<string>();
		if (origins.has(securityOrigin)) {
			return;
		}
		origins.add(securityOrigin);
		this.#sessionOrigins.set(session.sessionId, origins);

		// Releasing the marker leaves the next navigation free to try the domain again,
		// The same way a failed IndexedDB enable releases the origin it had claimed.
		if (!(await this.#sendStorageOk("DOMStorage.enable", {}, session, securityOrigin))) {
			origins.delete(securityOrigin);
			return;
		}
		for (const isLocalStorage of [true, false]) {
			await this.#readDomStorageArea(session, securityOrigin, isLocalStorage);
		}
	}

	async #readDomStorageArea(
		session: SessionInfo,
		securityOrigin: string,
		isLocalStorage: boolean,
	): Promise<void> {
		const params: Protocol.DOMStorage.GetDOMStorageItemsRequest = {
			storageId: { isLocalStorage, securityOrigin },
		};
		const items = await this.#sendStorage<
			Protocol.DOMStorage.GetDOMStorageItemsResponse | undefined
		>("DOMStorage.getDOMStorageItems", params, session, securityOrigin, undefined);
		// DOMStorage answers with [key, value] pairs; a malformed pair is skipped.
		for (const [key, value] of items?.entries ?? []) {
			if (key === undefined) {
				continue;
			}
			await this.#recordStorageChange({
				area: isLocalStorage ? "localStorage" : "sessionStorage",
				change: "baseline",
				key,
				newValue: value ?? "",
				securityOrigin,
				sessionId: session.sessionId,
				targetId: session.targetId,
				timestamp: nowIso(),
			});
		}
	}

	// One session tracks IndexedDB for an origin, however many tabs are open on it.
	// Tracking twice would record the same change once per tab.
	async #trackIndexedDb(session: SessionInfo, securityOrigin: string): Promise<void> {
		if (this.#indexedDbOrigins.has(securityOrigin)) {
			return;
		}
		this.#indexedDbOrigins.set(securityOrigin, session.sessionId);

		const params: Protocol.Storage.TrackIndexedDBForOriginRequest = { origin: securityOrigin };
		// Either failure has to release the claim. A kept claim is not a harmless retry
		// Lost: it says an origin is tracked that Chrome is reporting nothing for, so the
		// File reads as an origin whose IndexedDB never changed.
		if (
			!(await this.#sendStorageOk("IndexedDB.enable", {}, session, securityOrigin)) ||
			!(await this.#sendStorageOk(
				"Storage.trackIndexedDBForOrigin",
				params,
				session,
				securityOrigin,
			))
		) {
			this.#releaseIndexedDb(securityOrigin, session.sessionId);
			return;
		}
		await this.#readIndexedDbBaseline(session, securityOrigin);
	}

	// A detach between the claim and a failure can hand the origin to another session.
	// Releasing it blindly would drop that session's claim while Chrome still tracks for
	// It, so a third session would claim the origin and track it a second time, and every
	// Change would be recorded once per tracking session.
	#releaseIndexedDb(securityOrigin: string, sessionId: string): void {
		if (this.#indexedDbOrigins.get(securityOrigin) === sessionId) {
			this.#indexedDbOrigins.delete(securityOrigin);
		}
	}

	// Chrome drops IndexedDB tracking with the session that asked for it.
	// Any other session already on the origin can take it over, and one that is not on
	// The origin has nothing to hand over: its target is elsewhere.
	async #handOverIndexedDb(securityOrigin: string): Promise<void> {
		for (const [sessionId, origins] of this.#sessionOrigins) {
			const session = this.#sessions.get(sessionId);
			if (session !== undefined && origins.has(securityOrigin)) {
				await this.#trackIndexedDb(session, securityOrigin);
				return;
			}
		}
	}

	// What IndexedDB already held when tracking started.
	// Chrome reports only what changes after that, so a store a site never writes to
	// Again would otherwise reach no line of storage.ndjson at all.
	async #readIndexedDbBaseline(session: SessionInfo, securityOrigin: string): Promise<void> {
		const namesParams: Protocol.IndexedDB.RequestDatabaseNamesRequest = { securityOrigin };
		const names = await this.#sendStorage<
			Protocol.IndexedDB.RequestDatabaseNamesResponse | undefined
		>("IndexedDB.requestDatabaseNames", namesParams, session, securityOrigin, undefined);

		const databaseNames = names?.databaseNames ?? [];
		await this.#reportBaselineCap(
			session,
			securityOrigin,
			"databases",
			databaseNames.length,
			MAX_DATABASES_PER_ORIGIN,
		);

		for (const databaseName of databaseNames.slice(0, MAX_DATABASES_PER_ORIGIN)) {
			const databaseParams: Protocol.IndexedDB.RequestDatabaseRequest = {
				databaseName,
				securityOrigin,
			};
			const database = await this.#sendStorage<
				Protocol.IndexedDB.RequestDatabaseResponse | undefined
			>("IndexedDB.requestDatabase", databaseParams, session, securityOrigin, undefined);
			const stores = database?.databaseWithObjectStores.objectStores ?? [];
			await this.#reportBaselineCap(
				session,
				securityOrigin,
				`object stores of ${databaseName}`,
				stores.length,
				MAX_OBJECT_STORES_PER_DATABASE,
			);
			for (const store of stores.slice(0, MAX_OBJECT_STORES_PER_DATABASE)) {
				await this.#readObjectStore(session, securityOrigin, databaseName, store.name, "baseline");
			}
		}
	}

	// A store past a cap reaches no record of its own, and an entry cut from a page it
	// Did reach says so with `hasMore`. Nothing else would say the rest exists, so the
	// Cap reports itself the way every other capture loss does.
	async #reportBaselineCap(
		session: SessionInfo,
		securityOrigin: string,
		what: string,
		found: number,
		cap: number,
	): Promise<void> {
		if (found <= cap) {
			return;
		}
		await this.#recordCaptureError(
			createErrorRecord(
				"Storage.trackIndexedDBForOrigin",
				session,
				`Baseline read ${cap} of ${found} ${what}; the rest are not in storage.ndjson.`,
				undefined,
				securityOrigin,
			),
		);
	}

	// Chrome says only which store changed, so the store is read back to see what it holds.
	async #handleIndexedDbContentUpdated(
		event: IndexedDbContentUpdatedEvent,
		sessionId?: string,
	): Promise<void> {
		if (!sessionId) {
			return;
		}
		const session = this.#sessions.get(sessionId);
		if (session === undefined) {
			return;
		}

		// Two updates of one store would otherwise interleave their reads and append
		// Their pages in whichever order the two requestData calls happened to answer.
		const readKey = `${event.origin}:${event.databaseName}:${event.objectStoreName}`;
		await this.#queueIndexedDbRead(
			readKey,
			async () =>
				await this.#readObjectStore(
					session,
					event.origin,
					event.databaseName,
					event.objectStoreName,
					"updated",
				),
		);
	}

	// At most one read in flight per store and at most one waiting behind it.
	// A read already waiting will observe this change too, so queuing another would only
	// Re-read the state that one is going to see anyway.
	#queueIndexedDbRead(readKey: string, read: () => Promise<void>): Promise<void> {
		const pending = this.#indexedDbReads.get(readKey);
		if (pending === undefined) {
			const started: QueuedStoreRead = { chain: Promise.resolve(), queued: false };
			this.#indexedDbReads.set(readKey, started);
			started.chain = this.#runIndexedDbRead(readKey, started, read);

			return started.chain;
		}
		if (pending.queued) {
			return pending.chain;
		}
		pending.queued = true;
		pending.chain = pending.chain
			.catch(() => undefined)
			.then(async () => await this.#runIndexedDbRead(readKey, pending, read));

		return pending.chain;
	}

	async #runIndexedDbRead(
		readKey: string,
		pending: QueuedStoreRead,
		read: () => Promise<void>,
	): Promise<void> {
		// Cleared as the read starts, so a change arriving now queues the next one.
		pending.queued = false;
		try {
			await read();
		} finally {
			// Only the entry still holding this store clears it, and only with nothing
			// Queued behind: the waiting read is what clears it in that case.
			if (this.#indexedDbReads.get(readKey) === pending && !pending.queued) {
				this.#indexedDbReads.delete(readKey);
			}
		}
	}

	async #readObjectStore(
		session: SessionInfo,
		securityOrigin: string,
		databaseName: string,
		objectStoreName: string,
		change: "baseline" | "updated",
	): Promise<void> {
		const page = await readObjectStorePage(
			async (method, params, fallback) =>
				await this.#sendStorage(method, params, session, securityOrigin, fallback),
			{
				databaseName,
				objectStoreName,
				pageSize: MAX_ENTRIES_PER_OBJECT_STORE,
				securityOrigin,
			},
		);
		await this.#recordStorageChange({
			area: "indexedDB",
			change,
			databaseName,
			entries: page.entries,
			error: page.error,
			hasMore: page.hasMore,
			objectStoreName,
			securityOrigin,
			sessionId: session.sessionId,
			targetId: session.targetId,
			timestamp: nowIso(),
		});
	}

	// A change the browser reported, rather than one this run went looking for.
	async #handleDomStorageChange(
		change: "added" | "cleared" | "removed" | "updated",
		event: DomStorageEvent,
		sessionId?: string,
	): Promise<void> {
		if (!sessionId) {
			return;
		}
		const session = this.#sessions.get(sessionId);
		if (session === undefined) {
			return;
		}

		await this.#recordStorageChange({
			area: event.storageId.isLocalStorage ? "localStorage" : "sessionStorage",
			change,
			// A cleared area names no key, and only an update reports the value it replaced.
			key: "key" in event ? event.key : undefined,
			newValue: "newValue" in event ? event.newValue : undefined,
			oldValue: "oldValue" in event ? event.oldValue : undefined,
			securityOrigin: event.storageId.securityOrigin,
			sessionId,
			storageKey: event.storageId.storageKey,
			targetId: session.targetId,
			timestamp: nowIso(),
		});
	}

	// Storage values are the credentials the snapshot hook event deliberately withholds,
	// So they reach storage.ndjson and no plugin: there is no path-only shape to publish.
	async #recordStorageChange(change: StorageChangeRecord): Promise<void> {
		await this.#options.storage.recordStorageChange(change);
	}
}

type StartedCdpLogger = {
	close: () => Promise<void>;
	closeBrowser: () => Promise<void>;
	closed: Promise<void>;
	// Called before the browser is closed, and a no-op without --snapshot-storage.
	snapshotStorage: () => Promise<void>;
};

// Starting changes browser behavior before it is finished.
// With --capture-downloads the browser saves into this run directory from early on.
// Either call after that can still throw, and the run then never sees a logger at all.
// Chrome was left naming every later download after a GUID and writing it into a dead run.
// The CDP client was left connected with nothing to close it.
const startLogger = async (logger: CdpResponseLogger): Promise<void> => {
	try {
		await logger.start();
	} catch (error) {
		// Closing is the undo already written: it restores the behavior and closes the client.
		// Its own failure must not replace the error that actually ended the run.
		// Whatever it could not do is recorded in errors.ndjson by the call that failed.
		await logger.close().catch(() => undefined);
		throw error;
	}
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
	await startLogger(logger);
	return {
		close: () => logger.close(),
		closeBrowser: () => client.Browser.close(),
		closed,
		snapshotStorage: () => logger.snapshotStorage(),
	};
};

export {
	CdpResponseLogger,
	NETWORK_BUFFER_OPTIONS,
	createCompletedMetadata,
	startCdpLogger,
	startLogger,
};
