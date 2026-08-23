import CDP from "chrome-remote-interface";
import type { Protocol } from "devtools-protocol";

import {
	createCaptureErrorHookEvent,
	createEventSourceMessageHookEvent,
	createResponseCompletedHookEvent,
	createWebSocketFrameHookEvent,
} from "./plugins";
import { matchesFilters } from "./sanitize";
import type {
	BodySaveResult,
	CompletedResponseMetadata,
	ErrorRecord,
	EventSourceMessageRecord,
	ExtraInfoState,
	RequestState,
	RequestBodySaveResult,
	RequestBodySource,
	SessionInfo,
	StartLoggerOptions,
	WebSocketFrameRecord,
} from "./types";

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
type WebSocketCreatedEvent = Protocol.Network.WebSocketCreatedEvent;
type WebSocketClosedEvent = Protocol.Network.WebSocketClosedEvent;
type WebSocketFrameErrorEvent = Protocol.Network.WebSocketFrameErrorEvent;
type EventSourceMessageReceivedEvent = Protocol.Network.EventSourceMessageReceivedEvent;
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

const TARGET_TYPES = new Set(["page", "iframe", "worker", "shared_worker", "service_worker"]);

const NETWORK_BUFFER_OPTIONS = {
	maxResourceBufferSize: 100 * 1024 * 1024,
	maxTotalBufferSize: 500 * 1024 * 1024,
};

const CDP_CLOSE_TIMEOUT_MS = 5_000;
const CDP_DRAIN_TIMEOUT_MS = 1_000;

// A WebSocket handshake gets ExtraInfo events but never a requestWillBeSent.
// Those entries are only cleaned up by the socket closing or the target detaching.
// The cap keeps a long capture bounded even when neither happens.
const MAX_PENDING_EXTRA_INFO = 1_000;

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

const requestKey = (sessionId: string, requestId: string): string => `${sessionId}:${requestId}`;

const requestBodyErrorEvent = (source: RequestBodySource | undefined): string =>
	source === "requestWillBeSent"
		? "Network.requestWillBeSent.postData"
		: "Network.getRequestPostData";

// A body dropped by --max-body-bytes is a policy decision, not a capture failure.
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
	// Raw headers with no request state to live on yet, keyed like #requests.
	// Only populated with --capture-cookies, since nothing else subscribes ExtraInfo.
	readonly #extraInfo = new Map<string, PendingExtraInfo>();
	// Redirect hop writes in flight, keyed like #requests so a chain appends in order.
	readonly #hopWrites = new Map<string, Promise<void>>();
	readonly #options: StartLoggerOptions;
	readonly #pendingEvents = new Set<Promise<void>>();
	readonly #requests = new Map<string, RequestState>();
	readonly #sessions = new Map<string, SessionInfo>();
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
		await this.#client.Target.setAutoAttach({
			autoAttach: true,
			flatten: true,
			waitForDebuggerOnStart: false,
		});
		await this.#attachExistingTargets();
	}

	async close(): Promise<void> {
		const closing = this.#client.close();
		if (!(await settlesWithin(closing, CDP_CLOSE_TIMEOUT_MS))) {
			terminateClientSocket(this.#client);
			await settlesWithin(closing, CDP_DRAIN_TIMEOUT_MS);
		}
		await settlesWithin(this.#drainPendingEvents(), CDP_DRAIN_TIMEOUT_MS);
	}

	#log(message: string): void {
		process.stdout.write(`${message}\n`);
	}

	#verbose(message: string): void {
		if (this.#options.verbose) {
			this.#log(message);
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

		for (const [key, state] of this.#requests) {
			if (state.session.sessionId === event.sessionId) {
				this.#requests.delete(key);
				this.#hopWrites.delete(key);
			}
		}

		// Neither map is keyed by session.
		// Buffered ExtraInfo whose base event never arrives would outlive its session.
		const sessionPrefix = `${event.sessionId}:`;
		for (const keyed of [this.#webSockets, this.#extraInfo]) {
			for (const key of keyed.keys()) {
				if (key.startsWith(sessionPrefix)) {
					keyed.delete(key);
				}
			}
		}

		this.#verbose(`detached session=${event.sessionId}`);
		if (session) {
			await this.#recordCaptureError({
				error: "Target detached before all active requests completed.",
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
		const session = this.#sessions.get(sessionId) ?? { sessionId };
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
		const key = requestKey(sessionId, event.requestId);
		const session = this.#sessions.get(sessionId) ?? { sessionId };
		const existing = this.#requests.get(key);

		this.#requests.set(key, {
			...existing,
			loaderId: existing?.loaderId ?? event.loaderId,
			requestId: event.requestId,
			response: event.response,
			session,
			type: event.type,
		});
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
		if (!sessionId) {
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
		if (!sessionId) {
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
		// The request is over either way, so nothing buffered under it can still be joined.
		this.#extraInfo.delete(key);
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

		const bodyResult = await this.#getBodyResult(state, event);
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
		if (!sessionId) {
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
	};
};

export { CdpResponseLogger, NETWORK_BUFFER_OPTIONS, createCompletedMetadata, startCdpLogger };
