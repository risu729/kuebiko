import { describe, expect, it, mock } from "bun:test";
import type { Mock } from "bun:test";
import { EventEmitter } from "node:events";
import { resolve } from "node:path";

import type { Protocol } from "devtools-protocol";

import {
	CdpResponseLogger,
	NETWORK_BUFFER_OPTIONS,
	createCompletedMetadata,
	startLogger,
} from "./cdp";
import type { HookEvent, HookPublisher } from "./plugins";
import type {
	CompletedResponseMetadata,
	DownloadRecord,
	ErrorRecord,
	EventSourceMessageRecord,
	LoggerStorage,
	RequestState,
	RequestBodySource,
	StorageChangeRecord,
	StorageSnapshot,
	WebSocketFrameRecord,
} from "./types";

class FakeClient extends EventEmitter {
	// Every CDP method the logger sends, in order.
	// It is also how the tests assert that no Runtime method beyond the resume is used.
	sent: { method: string; params?: object | undefined; sessionId?: string | undefined }[] = [];

	// A domain accessor is the other way into the client, so it records like send() does.
	// Otherwise an assertion over `sent` would miss, say, a future client.Runtime.enable().
	#domain =
		<Result>(method: string, reply: () => Promise<Result>) =>
		(params?: object, sessionId?: string): Promise<Result> => {
			this.sent.push({ method, params, sessionId });
			return reply();
		};

	Browser = {
		close: mock(this.#domain("Browser.close", () => Promise.resolve())),
		setDownloadBehavior: mock(this.#domain("Browser.setDownloadBehavior", () => Promise.resolve())),
	};

	Network = {
		enable: mock(this.#domain("Network.enable", () => Promise.resolve())),
		getRequestPostData: mock(
			this.#domain("Network.getRequestPostData", () =>
				Promise.resolve({
					postData: '{"from":"getRequestPostData"}',
				}),
			),
		),
		getResponseBody: mock(
			this.#domain("Network.getResponseBody", () =>
				Promise.resolve({
					base64Encoded: false,
					body: '{"ok":true}',
				}),
			),
		),
		streamResourceContent: mock(
			this.#domain("Network.streamResourceContent", () => Promise.resolve({ bufferedData: "" })),
		),
	};

	Target = {
		attachToTarget: mock(
			this.#domain("Target.attachToTarget", () => Promise.resolve({ sessionId: "session-1" })),
		),
		getTargets: mock(
			this.#domain("Target.getTargets", () =>
				Promise.resolve({ targetInfos: [] as Protocol.Target.TargetInfo[] }),
			),
		),
		setAutoAttach: mock(this.#domain("Target.setAutoAttach", () => Promise.resolve())),
		setDiscoverTargets: mock(this.#domain("Target.setDiscoverTargets", () => Promise.resolve())),
	};

	close = mock(() => Promise.resolve());

	// Answers a raw send: an Error rejects, a function is called with the params.
	// Anything not listed resolves empty, the way a void CDP command does.
	sendReplies = new Map<string, unknown>();

	send = mock((method: string, params?: object, sessionId?: string) => {
		this.sent.push({ method, params, sessionId });
		const reply = this.sendReplies.get(method);
		if (reply instanceof Error) {
			return Promise.reject(reply);
		}

		return Promise.resolve(
			typeof reply === "function" ? (reply as (input: unknown) => unknown)(params) : (reply ?? {}),
		);
	});
}

const createStorage = (): LoggerStorage & {
	downloads: DownloadRecord[];
	errors: ErrorRecord[];
	eventSource: EventSourceMessageRecord[];
	metadata: CompletedResponseMetadata[];
	snapshots: StorageSnapshot[];
	storageChanges: StorageChangeRecord[];
	websocket: WebSocketFrameRecord[];
} => {
	const metadata: CompletedResponseMetadata[] = [];
	const downloads: DownloadRecord[] = [];
	const errors: ErrorRecord[] = [];
	const eventSource: EventSourceMessageRecord[] = [];
	const snapshots: StorageSnapshot[] = [];
	const storageChanges: StorageChangeRecord[] = [];
	const websocket: WebSocketFrameRecord[] = [];

	return {
		close: mock(() => Promise.resolve()),
		downloads,
		errors,
		eventSource,
		metadata,
		recordRequestBody: mock((state, postData) =>
			Promise.resolve(
				(() => {
					const source: RequestBodySource =
						state.requestPostData === postData ? "requestWillBeSent" : "getRequestPostData";

					return {
						bodyFile: "requests/request.json",
						bodyLength: Buffer.byteLength(postData),
						bodySaved: true,
						bodySha256: "request-hash",
						source,
					};
				})(),
			),
		),
		recordBody: mock(() =>
			Promise.resolve({
				base64Encoded: false,
				bodyFile: "bodies/body.json",
				bodyLength: 11,
				bodySaved: true,
				bodySha256: "hash",
			}),
		),
		recordBodyBytes: mock((_state: RequestState, bytes: Uint8Array) =>
			Promise.resolve({
				bodyFile: "bodies/body.json",
				bodyLength: bytes.byteLength,
				bodySaved: true,
				bodySha256: "hash",
			}),
		),
		recordCompletedResponse: mock((record) => {
			metadata.push(record);
			return Promise.resolve();
		}),
		// Mirrors storage: a completed download is hashed and keeps its saved path.
		recordDownload: mock((download: DownloadRecord) => {
			const record: DownloadRecord =
				download.state === "completed"
					? { ...download, file: `downloads/${download.guid}`, sha256: "download-hash" }
					: download;
			downloads.push(record);
			return Promise.resolve(record);
		}),
		recordError: mock((record) => {
			errors.push(record);
			return Promise.resolve();
		}),
		recordEventSourceMessage: mock((record) => {
			eventSource.push(record);
			return Promise.resolve();
		}),
		recordStorageChange: mock((change: StorageChangeRecord) => {
			storageChanges.push(change);
			return Promise.resolve();
		}),
		recordStorageSnapshot: mock((snapshot: StorageSnapshot) => {
			snapshots.push(snapshot);
			return Promise.resolve("storage-snapshot.json");
		}),
		recordWebSocketFrame: mock((record) => {
			websocket.push(record);
			return Promise.resolve();
		}),
		runDirectory: "/captures/run",
		runTimestamp: "2026-07-06T12:34:56Z",
		snapshots,
		storageChanges,
		websocket,
	};
};

const createHooks = (): HookPublisher & { events: HookEvent[] } => {
	const events: HookEvent[] = [];

	return {
		close: mock(() => Promise.resolve()),
		events,
		publish: mock((event) => {
			events.push(event);
			return Promise.resolve();
		}),
	};
};

// Event handlers only await promises that are already resolved.
// One turn of the event loop therefore drains a whole handler.
const waitForAsyncEvent = async (): Promise<void> => {
	await Bun.sleep(0);
};

// A fixed wait for work that takes real time races the thing it waits for.
// On a loaded machine it loses that race.
// Polling ends as soon as the records are there instead.
// It only gives up at a deadline far enough out to mean the work never happened.
const waitForRecords = async (ready: () => boolean, timeout = 5_000): Promise<void> => {
	const deadline = Date.now() + timeout;
	while (!ready() && Date.now() < deadline) {
		await Bun.sleep(1);
	}
};

const attachPageTarget = (client: FakeClient, session = "session-1", target = "target-1"): void => {
	client.emit("Target.attachedToTarget", {
		sessionId: session,
		targetInfo: {
			attached: true,
			browserContextId: "context-1",
			canAccessOpener: false,
			targetId: target,
			title: "Example",
			type: "page",
			url: "https://example.test",
		},
		waitingForDebugger: false,
	});
};

// A popup target, which is the one an opener can reach and a debugger can hold.
const attachPopupTarget = (client: FakeClient, waitingForDebugger: boolean): void => {
	client.emit("Target.attachedToTarget", {
		sessionId: "session-1",
		targetInfo: {
			attached: true,
			browserContextId: "context-1",
			canAccessOpener: true,
			targetId: "target-1",
			title: "Popup",
			type: "page",
			url: "https://example.test/popup",
		},
		waitingForDebugger,
	});
};

const createRedirectResponse = (options: {
	location: string;
	status: number;
	statusText: string;
	url: string;
}): Protocol.Network.Response => ({
	charset: "",
	connectionId: 1,
	connectionReused: false,
	encodedDataLength: 42,
	headers: { location: options.location, "set-cookie": "session=abc" },
	mimeType: "text/html",
	securityState: "secure",
	status: options.status,
	statusText: options.statusText,
	url: options.url,
});

const SSO_TO_IDP = createRedirectResponse({
	location: "https://idp.test/login",
	status: 301,
	statusText: "Moved Permanently",
	url: "https://sso.test/authorize",
});

const IDP_TO_APP = createRedirectResponse({
	location: "https://app.test/session",
	status: 302,
	statusText: "Found",
	url: "https://idp.test/login",
});

const emitRequestWillBeSent = (
	client: FakeClient,
	request: {
		hasPostData?: boolean;
		method?: string;
		postData?: string;
		sessionId?: string;
		url: string;
	},
	redirectResponse?: Protocol.Network.Response,
): void => {
	client.emit(
		"Network.requestWillBeSent",
		{
			documentURL: "https://example.test",
			frameId: "frame-1",
			hasUserGesture: false,
			initiator: { type: "other" },
			loaderId: "loader-1",
			redirectResponse,
			request: {
				hasPostData: request.hasPostData ?? request.postData !== undefined,
				headers: { accept: "text/html" },
				initialPriority: "High",
				method: request.method ?? "GET",
				mixedContentType: "none",
				postData: request.postData,
				referrerPolicy: "strict-origin-when-cross-origin",
				url: request.url,
			},
			// Chrome sets this on the event that follows a hop, never on the first request.
			redirectHasExtraInfo: redirectResponse !== undefined,
			requestId: "request-1",
			timestamp: 1,
			type: "Document",
			wallTime: 1,
		},
		request.sessionId ?? "session-1",
	);
};

const emitRequestExtraInfo = (client: FakeClient, headers: Record<string, string>): void => {
	client.emit(
		"Network.requestWillBeSentExtraInfo",
		{
			associatedCookies: [],
			connectTiming: { requestTime: 1 },
			headers,
			requestId: "request-1",
		},
		"session-1",
	);
};

type ResponseExtraInfo = {
	blockedCookies?: { blockedReasons: string[]; cookieLine: string }[];
	cookiePartitionKey?: { hasCrossSiteAncestor: boolean; topLevelSite: string };
	headers: Record<string, string>;
};

const emitResponseExtraInfo = (client: FakeClient, extra: ResponseExtraInfo): void => {
	client.emit(
		"Network.responseReceivedExtraInfo",
		{
			blockedCookies: extra.blockedCookies ?? [],
			cookiePartitionKey: extra.cookiePartitionKey,
			headers: extra.headers,
			requestId: "request-1",
			resourceIPAddressSpace: "Public",
			statusCode: 200,
		},
		"session-1",
	);
};

const emitResponseReceived = (
	client: FakeClient,
	url: string,
	kind?: { mimeType?: string; sessionId?: string; type?: string },
): void => {
	const mimeType = kind?.mimeType ?? "text/html";
	client.emit(
		"Network.responseReceived",
		{
			frameId: "frame-1",
			hasExtraInfo: false,
			loaderId: "loader-1",
			requestId: "request-1",
			response: {
				headers: { "content-type": mimeType },
				mimeType,
				status: 200,
				statusText: "OK",
				url,
			},
			timestamp: 4,
			type: kind?.type ?? "Document",
		},
		kind?.sessionId ?? "session-1",
	);
};

// Base64 is how CDP carries streamed payloads, so tests build chunks the same way.
const toBase64 = (text: string): string => Buffer.from(text).toString("base64");

// The `data` field is only present once streaming is enabled for the request.
// A chunk emitted without it stands for one Chrome buffered before that point.
// Its encodedDataLength still counts: those bytes end up inside the buffered prefix.
const emitDataReceived = (
	client: FakeClient,
	chunk: {
		data?: string | undefined;
		encodedDataLength?: number | undefined;
		requestId?: string;
		sessionId?: string;
	},
): void => {
	const dataLength = chunk.data === undefined ? 0 : Buffer.from(chunk.data, "base64").byteLength;
	client.emit(
		"Network.dataReceived",
		{
			dataLength,
			// Wire bytes, which is what an uncompressed chunk reports as its own length.
			encodedDataLength: chunk.encodedDataLength ?? dataLength,
			requestId: chunk.requestId ?? "request-1",
			timestamp: 4,
			...(chunk.data === undefined ? {} : { data: chunk.data }),
		},
		chunk.sessionId ?? "session-1",
	);
};

// Every mock resolving on the microtask queue satisfies `await stream.enabling`.
// A deferred call is what proves loadingFinished actually waits for the prefix.
const deferStreamResourceContent = (
	client: FakeClient,
): PromiseWithResolvers<{ bufferedData: string }> => {
	const deferred = Promise.withResolvers<{ bufferedData: string }>();
	client.Network.streamResourceContent.mockReturnValueOnce(deferred.promise);
	return deferred;
};

const emitLoadingFailed = (client: FakeClient, errorText: string): void => {
	client.emit(
		"Network.loadingFailed",
		{ canceled: false, errorText, requestId: "request-1", timestamp: 5, type: "Document" },
		"session-1",
	);
};

const emitLoadingFinished = (client: FakeClient, sessionId = "session-1"): void => {
	client.emit(
		"Network.loadingFinished",
		{ encodedDataLength: 123, requestId: "request-1", timestamp: 5 },
		sessionId,
	);
};

const emitFinalResponse = (client: FakeClient, url: string): void => {
	emitResponseReceived(client, url);
	emitLoadingFinished(client);
};

// Sockets are keyed by session and request id, so both are addressable per emit.
type SocketRef = { requestId?: string | undefined; sessionId?: string | undefined };

const socketRef = (ref: SocketRef | undefined): { requestId: string; sessionId: string } => ({
	requestId: ref?.requestId ?? "socket-1",
	sessionId: ref?.sessionId ?? "session-1",
});

const emitWebSocketCreated = (client: FakeClient, url: string, ref?: SocketRef): void => {
	const { requestId, sessionId } = socketRef(ref);
	client.emit(
		"Network.webSocketCreated",
		{ initiator: { type: "script" }, requestId, url },
		sessionId,
	);
};

const emitWebSocketFrame = (
	client: FakeClient,
	direction: "sent" | "received",
	frame: SocketRef & { payloadData: string },
): void => {
	const { payloadData } = frame;
	const { requestId, sessionId } = socketRef(frame);
	client.emit(
		direction === "sent" ? "Network.webSocketFrameSent" : "Network.webSocketFrameReceived",
		{
			requestId,
			response: { mask: direction === "sent", opcode: 1, payloadData },
			timestamp: 6,
		},
		sessionId,
	);
};

const emitWebSocketClosed = (client: FakeClient, ref?: SocketRef): void => {
	const { requestId, sessionId } = socketRef(ref);
	client.emit("Network.webSocketClosed", { requestId, timestamp: 7 }, sessionId);
};

const emitWebSocketFrameError = (
	client: FakeClient,
	errorMessage: string,
	ref?: SocketRef,
): void => {
	const { requestId, sessionId } = socketRef(ref);
	client.emit("Network.webSocketFrameError", { errorMessage, requestId, timestamp: 8 }, sessionId);
};

const emitEventSourceMessage = (
	client: FakeClient,
	message: SocketRef & { data: string; eventId?: string; eventName?: string },
): void => {
	const { sessionId } = socketRef(message);
	client.emit(
		"Network.eventSourceMessageReceived",
		{
			data: message.data,
			eventId: message.eventId ?? "",
			eventName: message.eventName ?? "message",
			requestId: message.requestId ?? "request-1",
			timestamp: 9,
		},
		sessionId,
	);
};

// The Browser download events are browser-wide, so neither carries a sessionId.
const emitDownloadWillBegin = (
	client: FakeClient,
	download: { frameId?: string; guid?: string; suggestedFilename?: string; url: string },
): void => {
	client.emit("Browser.downloadWillBegin", {
		frameId: download.frameId ?? "frame-1",
		guid: download.guid ?? "download-1",
		suggestedFilename: download.suggestedFilename ?? "statement.pdf",
		url: download.url,
	});
};

const emitDownloadProgress = (
	client: FakeClient,
	progress: {
		guid?: string;
		receivedBytes?: number;
		state: "inProgress" | "completed" | "canceled";
		totalBytes?: number;
	},
): void => {
	client.emit("Browser.downloadProgress", {
		guid: progress.guid ?? "download-1",
		receivedBytes: progress.receivedBytes ?? 1024,
		state: progress.state,
		totalBytes: progress.totalBytes ?? 1024,
	});
};

type LoggerOptions = ConstructorParameters<typeof CdpResponseLogger>[1];

type LoggerSetup = {
	client: FakeClient;
	hooks: ReturnType<typeof createHooks>;
	logger: CdpResponseLogger;
	storage: ReturnType<typeof createStorage>;
};

// One started logger over a fake client, with one page target attached.
// Every test needs that much, so each one passes only the options it is about.
// `start: false` leaves both steps to the test; `attach: false` leaves only the attach.
const setupLogger = async (
	overrides: Partial<LoggerOptions> & { attach?: boolean; start?: boolean } = {},
): Promise<LoggerSetup> => {
	const { start = true, attach = start, ...options } = overrides;
	const client = new FakeClient();
	const hooks = createHooks();
	const storage = createStorage();
	const logger = new CdpResponseLogger(client as never, {
		cdp: "http://127.0.0.1:9222",
		hooks,
		storage,
		verbose: false,
		...options,
	});

	if (start) {
		await logger.start();
	}
	if (attach) {
		attachPageTarget(client);
		await waitForAsyncEvent();
	}

	return { client, hooks, logger, storage };
};

describe("createCompletedMetadata", () => {
	it("creates one appendable metadata object per response", () => {
		const state: RequestState = {
			loaderId: "loader-1",
			requestHeaders: { accept: "application/json" },
			requestId: "request-1",
			requestMethod: "GET",
			requestUrl: "https://example.test/api",
			response: {
				charset: "",
				connectionId: 1,
				connectionReused: false,
				encodedDataLength: 123,
				fromDiskCache: false,
				headers: { "content-type": "application/json" },
				mimeType: "application/json",
				protocol: "h2",
				remoteIPAddress: "203.0.113.10",
				remotePort: 443,
				securityState: "secure",
				status: 200,
				statusText: "OK",
				url: "https://example.test/api",
			},
			session: {
				sessionId: "session-1",
				targetId: "target-1",
				targetType: "page",
				targetUrl: "https://example.test",
			},
		};

		expect(
			createCompletedMetadata(
				state,
				{ encodedDataLength: 123, requestId: "request-1", timestamp: 1 },
				{
					base64Encoded: false,
					bodyFile: "bodies/body.json",
					bodyLength: 11,
					bodySaved: true,
					bodySha256: "hash",
				},
				{},
				"2026-07-06T12:34:56Z",
			),
		).toMatchObject({
			bodyFile: "bodies/body.json",
			bodySaved: true,
			encodedDataLength: 123,
			mimeType: "application/json",
			requestHeaders: { accept: "application/json" },
			requestId: "request-1",
			requestMethod: "GET",
			responseHeaders: { "content-type": "application/json" },
			runTimestamp: "2026-07-06T12:34:56Z",
			sessionId: "session-1",
			status: 200,
			url: "https://example.test/api",
		});
	});

	it("adds request body metadata when post data was captured", () => {
		const state: RequestState = {
			hasPostData: true,
			loaderId: "loader-1",
			requestContentType: "application/json",
			requestHeaders: { "content-type": "application/json" },
			requestId: "request-1",
			requestMethod: "POST",
			requestPostData: '{"hello":"world"}',
			requestUrl: "https://example.test/api",
			response: {
				charset: "",
				connectionId: 1,
				connectionReused: false,
				encodedDataLength: 123,
				headers: { "content-type": "application/json" },
				mimeType: "application/json",
				securityState: "secure",
				status: 200,
				statusText: "OK",
				url: "https://example.test/api",
			},
			session: {
				sessionId: "session-1",
				targetId: "target-1",
				targetType: "page",
				targetUrl: "https://example.test",
			},
		};

		expect(
			createCompletedMetadata(
				state,
				{ encodedDataLength: 123, requestId: "request-1", timestamp: 1 },
				{
					base64Encoded: false,
					bodyFile: "bodies/body.json",
					bodyLength: 11,
					bodySaved: true,
					bodySha256: "hash",
				},
				{
					bodyFile: "requests/request.json",
					bodyLength: 17,
					bodySaved: true,
					bodySha256: "request-hash",
					source: "requestWillBeSent",
				},
				"2026-07-06T12:34:56Z",
			),
		).toMatchObject({
			requestBodyFile: "requests/request.json",
			requestBodyLength: 17,
			requestBodySaved: true,
			requestBodySha256: "request-hash",
			requestBodySource: "requestWillBeSent",
			requestMethod: "POST",
		});
	});
});

describe("CdpResponseLogger", () => {
	it("captures completed response bodies and metadata", async () => {
		const { client, hooks, storage } = await setupLogger();
		client.emit(
			"Network.requestWillBeSent",
			{
				documentURL: "https://example.test",
				frameId: "frame-1",
				hasUserGesture: false,
				initiator: { type: "other" },
				loaderId: "loader-1",
				request: {
					headers: { accept: "application/json" },
					initialPriority: "High",
					method: "GET",
					mixedContentType: "none",
					referrerPolicy: "strict-origin-when-cross-origin",
					url: "https://example.test/api",
				},
				requestId: "request-1",
				timestamp: 1,
				type: "XHR",
				wallTime: 1,
			},
			"session-1",
		);
		client.emit(
			"Network.responseReceived",
			{
				frameId: "frame-1",
				hasExtraInfo: false,
				loaderId: "loader-1",
				requestId: "request-1",
				response: {
					headers: { "content-type": "application/json" },
					mimeType: "application/json",
					status: 200,
					statusText: "OK",
					url: "https://example.test/api",
				},
				timestamp: 2,
				type: "XHR",
			},
			"session-1",
		);
		client.emit(
			"Network.loadingFinished",
			{ encodedDataLength: 123, requestId: "request-1", timestamp: 3 },
			"session-1",
		);
		await waitForAsyncEvent();

		expect(client.Network.enable).toHaveBeenCalledWith(
			{ maxResourceBufferSize: 104_857_600, maxTotalBufferSize: 524_288_000 },
			"session-1",
		);
		expect(client.send).toHaveBeenCalledWith(
			"Runtime.runIfWaitingForDebugger",
			undefined,
			"session-1",
		);
		expect(storage.recordBody).toHaveBeenCalledTimes(1);
		expect(storage.metadata).toHaveLength(1);
		expect(storage.metadata[0]).toMatchObject({
			bodyFile: "bodies/body.json",
			bodySaved: true,
			requestBodySaved: undefined,
			requestId: "request-1",
			requestMethod: "GET",
			status: 200,
			url: "https://example.test/api",
		});
		expect(hooks.events).toContainEqual(
			expect.objectContaining({
				event: "response.completed",
				request: expect.objectContaining({
					method: "GET",
					requestId: "request-1",
					url: "https://example.test/api",
				}),
				response: expect.objectContaining({
					bodyFile: "bodies/body.json",
					bodySaved: true,
					mimeType: "application/json",
					status: 200,
				}),
			}),
		);
	});

	it("enables network before resuming attached targets", async () => {
		const { client } = await setupLogger({ attach: false });

		attachPopupTarget(client, false);
		await waitForAsyncEvent();

		expect(client.send).toHaveBeenCalledWith(
			"Runtime.runIfWaitingForDebugger",
			undefined,
			"session-1",
		);
		expect(client.Network.enable).toHaveBeenCalledWith(
			{ maxResourceBufferSize: 104_857_600, maxTotalBufferSize: 524_288_000 },
			"session-1",
		);
		expect(client.Network.enable.mock.invocationCallOrder[0]).toBeLessThan(
			client.send.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
		);
	});

	it("records resume failures and still enables network capture", async () => {
		const { client, storage } = await setupLogger({ attach: false });

		client.send.mockRejectedValueOnce(new Error("resume failed"));
		attachPopupTarget(client, true);
		await waitForAsyncEvent();

		expect(storage.errors[0]).toMatchObject({
			error: "resume failed",
			event: "Runtime.runIfWaitingForDebugger",
			sessionId: "session-1",
			targetId: "target-1",
			url: "https://example.test/popup",
		});
		expect(client.Network.enable).toHaveBeenCalledWith(
			{ maxResourceBufferSize: 104_857_600, maxTotalBufferSize: 524_288_000 },
			"session-1",
		);
	});

	it("saves inline request post data without request interception", async () => {
		const { client, storage } = await setupLogger();
		client.emit(
			"Network.requestWillBeSent",
			{
				documentURL: "https://example.test",
				frameId: "frame-1",
				hasUserGesture: false,
				initiator: { type: "other" },
				loaderId: "loader-1",
				request: {
					hasPostData: true,
					headers: { "content-type": "application/json" },
					initialPriority: "High",
					method: "POST",
					mixedContentType: "none",
					postData: '{"hello":"world"}',
					referrerPolicy: "strict-origin-when-cross-origin",
					url: "https://example.test/api",
				},
				requestId: "request-1",
				timestamp: 1,
				type: "XHR",
				wallTime: 1,
			},
			"session-1",
		);
		client.emit(
			"Network.responseReceived",
			{
				frameId: "frame-1",
				hasExtraInfo: false,
				loaderId: "loader-1",
				requestId: "request-1",
				response: {
					headers: { "content-type": "application/json" },
					mimeType: "application/json",
					status: 200,
					statusText: "OK",
					url: "https://example.test/api",
				},
				timestamp: 2,
				type: "XHR",
			},
			"session-1",
		);
		client.emit(
			"Network.loadingFinished",
			{ encodedDataLength: 123, requestId: "request-1", timestamp: 3 },
			"session-1",
		);
		await waitForAsyncEvent();

		expect(client.Network.getRequestPostData).not.toHaveBeenCalled();
		expect(storage.recordRequestBody).toHaveBeenCalledWith(
			expect.objectContaining({ requestPostData: '{"hello":"world"}' }),
			'{"hello":"world"}',
		);
		expect(storage.metadata[0]).toMatchObject({
			requestBodyFile: "requests/request.json",
			requestBodyLength: 17,
			requestBodySaved: true,
			requestBodySource: "requestWillBeSent",
			requestMethod: "POST",
		});
	});

	it("falls back to Network.getRequestPostData when post data is not inline", async () => {
		const { client, storage } = await setupLogger();
		client.emit(
			"Network.requestWillBeSent",
			{
				documentURL: "https://example.test",
				frameId: "frame-1",
				hasUserGesture: false,
				initiator: { type: "other" },
				loaderId: "loader-1",
				request: {
					hasPostData: true,
					headers: { "content-type": "application/json" },
					initialPriority: "High",
					method: "POST",
					mixedContentType: "none",
					referrerPolicy: "strict-origin-when-cross-origin",
					url: "https://example.test/api",
				},
				requestId: "request-1",
				timestamp: 1,
				type: "XHR",
				wallTime: 1,
			},
			"session-1",
		);
		client.emit(
			"Network.responseReceived",
			{
				frameId: "frame-1",
				hasExtraInfo: false,
				loaderId: "loader-1",
				requestId: "request-1",
				response: {
					headers: { "content-type": "application/json" },
					mimeType: "application/json",
					status: 200,
					statusText: "OK",
					url: "https://example.test/api",
				},
				timestamp: 2,
				type: "XHR",
			},
			"session-1",
		);
		client.emit(
			"Network.loadingFinished",
			{ encodedDataLength: 123, requestId: "request-1", timestamp: 3 },
			"session-1",
		);
		await waitForAsyncEvent();

		expect(client.Network.getRequestPostData).toHaveBeenCalledWith(
			{ requestId: "request-1" },
			"session-1",
		);
		expect(storage.recordRequestBody).toHaveBeenCalledWith(
			expect.objectContaining({ hasPostData: true }),
			'{"from":"getRequestPostData"}',
		);
		expect(storage.metadata[0]).toMatchObject({
			requestBodyFile: "requests/request.json",
			requestBodySource: "getRequestPostData",
		});
	});

	it("labels inline request body save failures with the inline post data source", async () => {
		const { client, storage } = await setupLogger();
		const recordRequestBody = storage.recordRequestBody as Mock<LoggerStorage["recordRequestBody"]>;
		recordRequestBody.mockResolvedValueOnce({
			bodySaved: false,
			error: "disk full",
			source: "requestWillBeSent",
		});

		client.emit(
			"Network.requestWillBeSent",
			{
				documentURL: "https://example.test",
				frameId: "frame-1",
				hasUserGesture: false,
				initiator: { type: "other" },
				loaderId: "loader-1",
				request: {
					hasPostData: true,
					headers: { "content-type": "application/json" },
					initialPriority: "High",
					method: "POST",
					mixedContentType: "none",
					postData: '{"hello":"world"}',
					referrerPolicy: "strict-origin-when-cross-origin",
					url: "https://example.test/api",
				},
				requestId: "request-1",
				timestamp: 1,
				type: "XHR",
				wallTime: 1,
			},
			"session-1",
		);
		client.emit(
			"Network.responseReceived",
			{
				frameId: "frame-1",
				hasExtraInfo: false,
				loaderId: "loader-1",
				requestId: "request-1",
				response: {
					headers: { "content-type": "application/json" },
					mimeType: "application/json",
					status: 200,
					statusText: "OK",
					url: "https://example.test/api",
				},
				timestamp: 2,
				type: "XHR",
			},
			"session-1",
		);
		client.emit(
			"Network.loadingFinished",
			{ encodedDataLength: 123, requestId: "request-1", timestamp: 3 },
			"session-1",
		);
		await waitForAsyncEvent();

		expect(storage.errors[0]).toMatchObject({
			error: "disk full",
			event: "Network.requestWillBeSent.postData",
			requestId: "request-1",
		});
		expect(storage.metadata[0]).toMatchObject({
			requestBodyError: "disk full",
			requestBodySaved: false,
			requestBodySource: "requestWillBeSent",
		});
	});

	it("records missing getRequestPostData postData as a request body error", async () => {
		const { client, storage } = await setupLogger();
		client.Network.getRequestPostData.mockResolvedValueOnce({} as never);

		client.emit(
			"Network.requestWillBeSent",
			{
				documentURL: "https://example.test",
				frameId: "frame-1",
				hasUserGesture: false,
				initiator: { type: "other" },
				loaderId: "loader-1",
				request: {
					hasPostData: true,
					headers: { "content-type": "application/json" },
					initialPriority: "High",
					method: "POST",
					mixedContentType: "none",
					referrerPolicy: "strict-origin-when-cross-origin",
					url: "https://example.test/api",
				},
				requestId: "request-1",
				timestamp: 1,
				type: "XHR",
				wallTime: 1,
			},
			"session-1",
		);
		client.emit(
			"Network.responseReceived",
			{
				frameId: "frame-1",
				hasExtraInfo: false,
				loaderId: "loader-1",
				requestId: "request-1",
				response: {
					headers: { "content-type": "application/json" },
					mimeType: "application/json",
					status: 200,
					statusText: "OK",
					url: "https://example.test/api",
				},
				timestamp: 2,
				type: "XHR",
			},
			"session-1",
		);
		client.emit(
			"Network.loadingFinished",
			{ encodedDataLength: 123, requestId: "request-1", timestamp: 3 },
			"session-1",
		);
		await waitForAsyncEvent();

		expect(storage.recordRequestBody).not.toHaveBeenCalled();
		expect(storage.errors[0]).toMatchObject({
			error: "Network.getRequestPostData returned no postData.",
			event: "Network.getRequestPostData",
			requestId: "request-1",
		});
		expect(storage.metadata[0]).toMatchObject({
			requestBodyError: "Network.getRequestPostData returned no postData.",
			requestBodySaved: false,
			requestBodySource: "getRequestPostData",
		});
	});

	it("records body retrieval failures without crashing", async () => {
		const { client, storage } = await setupLogger();
		client.Network.getResponseBody.mockRejectedValueOnce(new Error("No resource with given id"));

		client.emit(
			"Network.responseReceived",
			{
				frameId: "frame-1",
				hasExtraInfo: false,
				loaderId: "loader-1",
				requestId: "request-1",
				response: {
					headers: {},
					mimeType: "application/json",
					status: 200,
					statusText: "OK",
					url: "https://example.test/api",
				},
				timestamp: 2,
				type: "XHR",
			},
			"session-1",
		);
		client.emit(
			"Network.loadingFinished",
			{ encodedDataLength: 123, requestId: "request-1", timestamp: 3 },
			"session-1",
		);
		await waitForAsyncEvent();

		expect(storage.metadata[0]).toMatchObject({
			bodySaved: false,
			error: "No resource with given id",
			requestId: "request-1",
		});
		expect(storage.errors[0]).toMatchObject({
			error: "No resource with given id",
			event: "Network.getResponseBody",
			requestId: "request-1",
		});
	});

	it("marks bodies dropped by --max-body-bytes as skipped instead of failed", async () => {
		const { client, storage } = await setupLogger({ maxBodyBytes: 10 });

		client.emit(
			"Network.responseReceived",
			{
				frameId: "frame-1",
				hasExtraInfo: false,
				loaderId: "loader-1",
				requestId: "request-1",
				response: {
					headers: {},
					mimeType: "application/json",
					status: 200,
					statusText: "OK",
					url: "https://example.test/large",
				},
				timestamp: 2,
				type: "XHR",
			},
			"session-1",
		);
		client.emit(
			"Network.loadingFinished",
			{ encodedDataLength: 123, requestId: "request-1", timestamp: 3 },
			"session-1",
		);
		await waitForAsyncEvent();

		expect(client.Network.getResponseBody).not.toHaveBeenCalled();
		expect(storage.errors[0]).toMatchObject({
			event: "Network.getResponseBody.skipped",
			requestId: "request-1",
			url: "https://example.test/large",
		});
	});

	it("records every redirect hop of a chain before the final response", async () => {
		const { client, hooks, storage } = await setupLogger();
		emitRequestWillBeSent(client, { url: "https://sso.test/authorize" });
		await waitForAsyncEvent();
		emitRequestWillBeSent(client, { url: "https://idp.test/login" }, SSO_TO_IDP);
		await waitForAsyncEvent();
		emitRequestWillBeSent(client, { url: "https://app.test/session" }, IDP_TO_APP);
		await waitForAsyncEvent();
		emitFinalResponse(client, "https://app.test/session");
		await waitForAsyncEvent();

		expect(client.Network.getResponseBody).toHaveBeenCalledTimes(1);
		expect(storage.metadata).toHaveLength(3);
		expect(storage.metadata[0]).toMatchObject({
			bodySaved: false,
			encodedDataLength: 42,
			redirect: true,
			redirectIndex: 0,
			responseHeaders: { location: "https://idp.test/login", "set-cookie": "session=abc" },
			status: 301,
			url: "https://sso.test/authorize",
		});
		expect(storage.metadata[1]).toMatchObject({
			bodySaved: false,
			redirect: true,
			redirectIndex: 1,
			responseHeaders: { location: "https://app.test/session", "set-cookie": "session=abc" },
			status: 302,
			url: "https://idp.test/login",
		});
		expect(storage.metadata[2]).toMatchObject({
			bodyFile: "bodies/body.json",
			bodySaved: true,
			redirectIndex: 2,
			status: 200,
			url: "https://app.test/session",
		});
		// A terminal response never carries the redirect marker.
		expect(storage.metadata[2]?.redirect).toBeUndefined();
		expect(storage.errors).toHaveLength(0);
		expect(hooks.events).toContainEqual(
			expect.objectContaining({
				event: "response.completed",
				response: expect.objectContaining({
					bodySaved: false,
					redirect: true,
					redirectIndex: 0,
					status: 301,
				}),
			}),
		);
	});

	it("applies url filters to redirect hops", async () => {
		const { client, storage } = await setupLogger({ exclude: /idp\.test/u });

		emitRequestWillBeSent(client, { url: "https://sso.test/authorize" });
		await waitForAsyncEvent();
		emitRequestWillBeSent(client, { url: "https://idp.test/login" }, SSO_TO_IDP);
		await waitForAsyncEvent();
		emitRequestWillBeSent(client, { url: "https://app.test/session" }, IDP_TO_APP);
		await waitForAsyncEvent();
		emitFinalResponse(client, "https://app.test/session");
		await waitForAsyncEvent();

		expect(storage.metadata.map((record) => record.url)).toEqual([
			"https://sso.test/authorize",
			"https://app.test/session",
		]);
		// A filtered hop keeps its place in the chain instead of renumbering it.
		expect(storage.metadata.map((record) => record.redirectIndex)).toEqual([0, 2]);
	});

	it("saves inline post data with the redirect hop that carried it", async () => {
		const { client, storage } = await setupLogger();
		emitRequestWillBeSent(client, {
			method: "POST",
			postData: '{"hello":"world"}',
			url: "https://idp.test/login",
		});
		await waitForAsyncEvent();
		emitRequestWillBeSent(client, { url: "https://app.test/session" }, IDP_TO_APP);
		await waitForAsyncEvent();
		emitFinalResponse(client, "https://app.test/session");
		await waitForAsyncEvent();

		expect(client.Network.getRequestPostData).not.toHaveBeenCalled();
		expect(storage.recordRequestBody).toHaveBeenCalledTimes(1);
		expect(storage.metadata[0]).toMatchObject({
			redirect: true,
			redirectIndex: 0,
			requestBodyFile: "requests/request.json",
			requestBodySaved: true,
			requestBodySource: "requestWillBeSent",
			requestMethod: "POST",
			status: 302,
		});
		expect(storage.metadata[1]).toMatchObject({
			requestBodySaved: undefined,
			requestMethod: "GET",
			status: 200,
		});
	});

	it("records hop post data the browser did not inline as a request body loss", async () => {
		const { client, storage } = await setupLogger();
		emitRequestWillBeSent(client, {
			hasPostData: true,
			method: "POST",
			url: "https://idp.test/login",
		});
		await waitForAsyncEvent();
		emitRequestWillBeSent(client, { url: "https://app.test/session" }, IDP_TO_APP);
		await waitForAsyncEvent();
		emitFinalResponse(client, "https://app.test/session");
		await waitForAsyncEvent();

		expect(client.Network.getRequestPostData).not.toHaveBeenCalled();
		expect(storage.recordRequestBody).not.toHaveBeenCalled();
		expect(storage.metadata[0]).toMatchObject({
			redirect: true,
			requestBodyError:
				"Redirect hop post data was not inlined; Network.getRequestPostData answers for the request now in flight.",
			requestBodySaved: false,
			requestBodySource: "requestWillBeSent",
		});
		expect(storage.errors[0]).toMatchObject({
			event: "Network.requestWillBeSent.postData",
			requestId: "request-1",
			url: "https://idp.test/login",
		});
	});

	it("keeps chain records in order when a hop request body write is slow", async () => {
		const { client, storage } = await setupLogger();
		const recordRequestBody = storage.recordRequestBody as Mock<LoggerStorage["recordRequestBody"]>;
		recordRequestBody.mockImplementationOnce(async (_, postData) => {
			await Bun.sleep(20);

			return {
				bodyFile: "requests/request.json",
				bodyLength: Buffer.byteLength(postData),
				bodySaved: true,
				bodySha256: "request-hash",
				source: "requestWillBeSent",
			};
		});

		// The whole chain arrives in one burst, as it does on a real connection.
		emitRequestWillBeSent(client, {
			method: "POST",
			postData: '{"hello":"world"}',
			url: "https://sso.test/authorize",
		});
		emitRequestWillBeSent(client, { url: "https://idp.test/login" }, SSO_TO_IDP);
		emitRequestWillBeSent(client, { url: "https://app.test/session" }, IDP_TO_APP);
		emitFinalResponse(client, "https://app.test/session");
		await waitForRecords(() => storage.metadata.length === 3);

		expect(storage.metadata.map((record) => record.redirectIndex)).toEqual([0, 1, 2]);
		expect(storage.metadata.map((record) => record.status)).toEqual([301, 302, 200]);
	});

	it("keeps capturing when a hop metadata write fails", async () => {
		const { client, storage } = await setupLogger();
		const recordCompletedResponse = storage.recordCompletedResponse as Mock<
			LoggerStorage["recordCompletedResponse"]
		>;
		recordCompletedResponse.mockRejectedValueOnce(new Error("metadata write failed"));

		emitRequestWillBeSent(client, { url: "https://sso.test/authorize" });
		await waitForAsyncEvent();
		emitRequestWillBeSent(client, { url: "https://idp.test/login" }, SSO_TO_IDP);
		await waitForAsyncEvent();
		emitRequestWillBeSent(client, { url: "https://app.test/session" }, IDP_TO_APP);
		await waitForAsyncEvent();
		emitFinalResponse(client, "https://app.test/session");
		await waitForAsyncEvent();

		expect(storage.metadata.map((record) => record.redirectIndex)).toEqual([1, 2]);
	});

	it("skips a hop whose request state a target detach already dropped", async () => {
		const { client, storage } = await setupLogger();
		emitRequestWillBeSent(client, { url: "https://sso.test/authorize" });
		await waitForAsyncEvent();
		// The detach lands while the first hop is still being written.
		emitRequestWillBeSent(client, { url: "https://idp.test/login" }, SSO_TO_IDP);
		client.emit("Target.detachedFromTarget", { sessionId: "session-1", targetId: "target-1" });
		await waitForAsyncEvent();
		emitRequestWillBeSent(client, { url: "https://app.test/session" }, IDP_TO_APP);
		await waitForAsyncEvent();

		expect(storage.metadata).toHaveLength(1);
		expect(storage.metadata[0]).toMatchObject({
			redirect: true,
			redirectIndex: 0,
			status: 301,
		});
		expect(storage.errors).toContainEqual(
			expect.objectContaining({ event: "Target.detachedFromTarget" }),
		);
	});

	it("records both frame directions with the url of the socket that carried them", async () => {
		const { client, hooks, storage } = await setupLogger();
		emitWebSocketCreated(client, "wss://chat.test/socket");
		emitWebSocketFrame(client, "sent", { payloadData: '{"type":"subscribe"}' });
		emitWebSocketFrame(client, "received", { payloadData: '{"type":"ack"}' });
		await waitForAsyncEvent();

		expect(storage.websocket).toEqual([
			{
				direction: "sent",
				opcode: 1,
				payloadData: '{"type":"subscribe"}',
				requestId: "socket-1",
				sessionId: "session-1",
				targetId: "target-1",
				timestamp: expect.any(String),
				url: "wss://chat.test/socket",
			},
			{
				direction: "received",
				opcode: 1,
				payloadData: '{"type":"ack"}',
				requestId: "socket-1",
				sessionId: "session-1",
				targetId: "target-1",
				timestamp: expect.any(String),
				url: "wss://chat.test/socket",
			},
		]);
		expect(hooks.events.map((event) => event.event)).toEqual([
			"websocket.frame.sent",
			"websocket.frame.received",
		]);
	});

	it("records a frame without a url once the socket closed", async () => {
		const { client, storage } = await setupLogger();
		emitWebSocketCreated(client, "wss://chat.test/socket");
		emitWebSocketFrame(client, "received", { payloadData: '{"type":"ack"}' });
		emitWebSocketClosed(client);
		emitWebSocketFrame(client, "received", { payloadData: '{"type":"late"}' });
		await waitForAsyncEvent();

		expect(storage.websocket.map((frame) => frame.url)).toEqual([
			"wss://chat.test/socket",
			undefined,
		]);
	});

	it("keeps concurrent sockets of one session apart", async () => {
		const { client, storage } = await setupLogger();
		emitWebSocketCreated(client, "wss://chat.test/rooms", { requestId: "socket-1" });
		emitWebSocketCreated(client, "wss://metrics.test/stream", { requestId: "socket-2" });
		emitWebSocketFrame(client, "received", {
			payloadData: '{"room":"general"}',
			requestId: "socket-1",
		});
		emitWebSocketFrame(client, "sent", { payloadData: '{"metric":"fps"}', requestId: "socket-2" });
		await waitForAsyncEvent();

		expect(storage.websocket.map((frame) => [frame.requestId, frame.url])).toEqual([
			["socket-1", "wss://chat.test/rooms"],
			["socket-2", "wss://metrics.test/stream"],
		]);
	});

	it("keeps sockets of other sessions when one target detaches", async () => {
		const { client, storage } = await setupLogger();

		attachPageTarget(client, "session-2", "target-2");
		await waitForAsyncEvent();
		// Request ids are only unique per session, so both sockets share one.
		emitWebSocketCreated(client, "wss://chat.test/first");
		emitWebSocketCreated(client, "wss://chat.test/second", { sessionId: "session-2" });
		client.emit("Target.detachedFromTarget", { sessionId: "session-1", targetId: "target-1" });
		await waitForAsyncEvent();
		emitWebSocketFrame(client, "received", { payloadData: '{"type":"ping"}' });
		emitWebSocketFrame(client, "received", {
			payloadData: '{"type":"ping"}',
			sessionId: "session-2",
		});
		await waitForAsyncEvent();

		expect(storage.websocket.map((frame) => [frame.sessionId, frame.url])).toEqual([
			["session-1", undefined],
			["session-2", "wss://chat.test/second"],
		]);
	});

	it("records a frame error against the socket url", async () => {
		const { client, storage } = await setupLogger();
		emitWebSocketCreated(client, "wss://chat.test/socket");
		emitWebSocketFrameError(client, "Could not decode a text frame as UTF-8.");
		await waitForAsyncEvent();

		expect(storage.errors).toContainEqual(
			expect.objectContaining({
				error: "Could not decode a text frame as UTF-8.",
				event: "Network.webSocketFrameError",
				requestId: "socket-1",
				sessionId: "session-1",
				targetId: "target-1",
				url: "wss://chat.test/socket",
			}),
		);
	});

	it("drops socket urls when the target detaches", async () => {
		const { client, storage } = await setupLogger();
		emitWebSocketCreated(client, "wss://chat.test/socket");
		client.emit("Target.detachedFromTarget", { sessionId: "session-1", targetId: "target-1" });
		await waitForAsyncEvent();
		emitWebSocketFrame(client, "sent", { payloadData: '{"type":"orphan"}' });
		await waitForAsyncEvent();

		expect(storage.websocket).toHaveLength(1);
		expect(storage.websocket[0]).toMatchObject({
			direction: "sent",
			payloadData: '{"type":"orphan"}',
			url: undefined,
		});
	});

	// An SSE stream never reaches loadingFinished, so its request state stays alive.
	// Every message on the open stream is therefore attributed to the stream URL.
	it("records eventsource messages with the url of the open stream request", async () => {
		const { client, hooks, storage } = await setupLogger();
		emitRequestWillBeSent(client, { url: "https://stream.test/prices" });
		await waitForAsyncEvent();
		emitEventSourceMessage(client, { data: '{"btc":1}', eventId: "1", eventName: "price" });
		emitEventSourceMessage(client, { data: '{"btc":2}', eventId: "2", eventName: "price" });
		await waitForAsyncEvent();

		expect(storage.eventSource).toEqual([
			{
				data: '{"btc":1}',
				eventId: "1",
				eventName: "price",
				requestId: "request-1",
				sessionId: "session-1",
				targetId: "target-1",
				timestamp: expect.any(String),
				url: "https://stream.test/prices",
			},
			{
				data: '{"btc":2}',
				eventId: "2",
				eventName: "price",
				requestId: "request-1",
				sessionId: "session-1",
				targetId: "target-1",
				timestamp: expect.any(String),
				url: "https://stream.test/prices",
			},
		]);
		expect(hooks.events.map((event) => event.event)).toEqual([
			"eventsource.message",
			"eventsource.message",
		]);
	});

	it("records an eventsource message without a url when no request state is known", async () => {
		const { client, storage } = await setupLogger();
		// A stream the logger joined mid-flight never produced Network.requestWillBeSent for it.
		emitEventSourceMessage(client, { data: '{"btc":3}' });
		await waitForAsyncEvent();

		expect(storage.eventSource).toHaveLength(1);
		expect(storage.eventSource[0]).toMatchObject({
			data: '{"btc":3}',
			eventName: "message",
			url: undefined,
		});
	});

	// The lookup is keyed by session and request id.
	// No stream URL leaks onto a message of another request or another session.
	it("attributes an eventsource message only to its own request", async () => {
		const { client, storage } = await setupLogger();

		attachPageTarget(client, "session-2", "target-2");
		await waitForAsyncEvent();
		emitRequestWillBeSent(client, { url: "https://stream.test/prices" });
		await waitForAsyncEvent();
		emitEventSourceMessage(client, { data: '{"btc":1}' });
		emitEventSourceMessage(client, { data: '{"btc":2}', requestId: "request-2" });
		emitEventSourceMessage(client, { data: '{"btc":3}', sessionId: "session-2" });
		await waitForAsyncEvent();

		expect(storage.eventSource.map((message) => [message.sessionId, message.url])).toEqual([
			["session-1", "https://stream.test/prices"],
			["session-1", undefined],
			["session-2", undefined],
		]);
	});

	// Detaching drops the request state, so later messages lose the URL but are still recorded.
	it("records eventsource messages without a url after the target detached", async () => {
		const { client, storage } = await setupLogger();
		emitRequestWillBeSent(client, { url: "https://stream.test/prices" });
		await waitForAsyncEvent();
		emitEventSourceMessage(client, { data: '{"btc":1}' });
		client.emit("Target.detachedFromTarget", { sessionId: "session-1", targetId: "target-1" });
		await waitForAsyncEvent();
		emitEventSourceMessage(client, { data: '{"btc":2}' });
		await waitForAsyncEvent();

		expect(storage.eventSource.map((message) => message.url)).toEqual([
			"https://stream.test/prices",
			undefined,
		]);
	});

	it("joins raw headers that arrive before the base event", async () => {
		const { client, storage } = await setupLogger({ captureCookies: true });
		emitRequestExtraInfo(client, { cookie: "session=abc" });
		emitRequestWillBeSent(client, { url: "https://example.test/api" });
		await waitForAsyncEvent();
		emitResponseExtraInfo(client, { headers: { "set-cookie": "session=def" } });
		emitFinalResponse(client, "https://example.test/api");
		await waitForAsyncEvent();

		expect(storage.metadata[0]).toMatchObject({
			rawRequestHeaders: { cookie: "session=abc" },
			rawResponseHeaders: { "set-cookie": "session=def" },
			// The refined headers stay exactly as they were.
			requestHeaders: { accept: "text/html" },
			responseHeaders: { "content-type": "text/html" },
		});
	});

	it("joins raw headers that arrive after the base event", async () => {
		const { client, storage } = await setupLogger({ captureCookies: true });
		emitRequestWillBeSent(client, { url: "https://example.test/api" });
		await waitForAsyncEvent();
		emitRequestExtraInfo(client, { cookie: "session=abc" });
		emitResponseReceived(client, "https://example.test/api");
		emitResponseExtraInfo(client, { headers: { "set-cookie": "session=def" } });
		emitLoadingFinished(client);
		await waitForAsyncEvent();

		expect(storage.metadata[0]).toMatchObject({
			rawRequestHeaders: { cookie: "session=abc" },
			rawResponseHeaders: { "set-cookie": "session=def" },
		});
	});

	it("records the cookies a response could not store", async () => {
		const { client, storage } = await setupLogger({ captureCookies: true });
		emitRequestWillBeSent(client, { url: "https://example.test/api" });
		await waitForAsyncEvent();
		emitResponseExtraInfo(client, {
			blockedCookies: [
				{ blockedReasons: ["SameSiteNoneInsecure"], cookieLine: "session=def; SameSite=None" },
			],
			cookiePartitionKey: { hasCrossSiteAncestor: false, topLevelSite: "https://example.test" },
			headers: { "set-cookie": "session=def; SameSite=None" },
		});
		emitFinalResponse(client, "https://example.test/api");
		await waitForAsyncEvent();

		expect(storage.metadata[0]).toMatchObject({
			blockedCookies: [
				{ blockedReasons: ["SameSiteNoneInsecure"], cookieLine: "session=def; SameSite=None" },
			],
			cookiePartitionKey: { hasCrossSiteAncestor: false, topLevelSite: "https://example.test" },
		});
	});

	it("leaves the ExtraInfo events unsubscribed without --capture-cookies", async () => {
		const { client, storage } = await setupLogger({ attach: false });

		expect(client.listenerCount("Network.requestWillBeSentExtraInfo")).toBe(0);
		expect(client.listenerCount("Network.responseReceivedExtraInfo")).toBe(0);

		attachPageTarget(client);
		await waitForAsyncEvent();
		emitRequestWillBeSent(client, { url: "https://example.test/api" });
		await waitForAsyncEvent();
		emitRequestExtraInfo(client, { cookie: "session=abc" });
		emitResponseExtraInfo(client, { headers: { "set-cookie": "session=def" } });
		emitFinalResponse(client, "https://example.test/api");
		await waitForAsyncEvent();

		expect(storage.metadata[0]?.rawRequestHeaders).toBeUndefined();
		expect(storage.metadata[0]?.rawResponseHeaders).toBeUndefined();
	});

	it("gives every redirect hop the raw headers of its own hop", async () => {
		const { client, storage } = await setupLogger({ captureCookies: true });
		emitRequestWillBeSent(client, { url: "https://sso.test/authorize" });
		await waitForAsyncEvent();
		emitRequestExtraInfo(client, { cookie: "hop=0" });
		emitResponseExtraInfo(client, { headers: { "set-cookie": "hop0=1" } });
		emitRequestWillBeSent(client, { url: "https://idp.test/login" }, SSO_TO_IDP);
		await waitForAsyncEvent();
		emitRequestExtraInfo(client, { cookie: "hop=1" });
		emitResponseExtraInfo(client, { headers: { "set-cookie": "hop1=1" } });
		emitRequestWillBeSent(client, { url: "https://app.test/session" }, IDP_TO_APP);
		await waitForAsyncEvent();
		emitRequestExtraInfo(client, { cookie: "hop=2" });
		emitResponseExtraInfo(client, { headers: { "set-cookie": "final=1" } });
		emitFinalResponse(client, "https://app.test/session");
		await waitForAsyncEvent();

		expect(
			storage.metadata.map((record) => [
				record.rawRequestHeaders?.["cookie"],
				record.rawResponseHeaders?.["set-cookie"],
			]),
		).toEqual([
			["hop=0", "hop0=1"],
			["hop=1", "hop1=1"],
			["hop=2", "final=1"],
		]);
	});

	// The hop is recorded without them rather than crediting them to the next hop.
	it("drops raw response headers that arrive after their hop was recorded", async () => {
		const { client, storage } = await setupLogger({ captureCookies: true });
		emitRequestWillBeSent(client, { url: "https://sso.test/authorize" });
		await waitForAsyncEvent();
		emitRequestWillBeSent(client, { url: "https://idp.test/login" }, SSO_TO_IDP);
		await waitForAsyncEvent();
		emitResponseExtraInfo(client, { headers: { "set-cookie": "hop0=1" } });
		emitResponseExtraInfo(client, { headers: { "set-cookie": "hop1=1" } });
		emitFinalResponse(client, "https://idp.test/login");
		await waitForAsyncEvent();

		expect(storage.metadata.map((record) => record.rawResponseHeaders?.["set-cookie"])).toEqual([
			undefined,
			"hop1=1",
		]);
	});

	// The redirectHasExtraInfo flag covers a hop's request ExtraInfo too.
	// A late one under the shared requestId must not land on the next hop's raw headers.
	it("drops raw request headers that arrive after their hop was recorded", async () => {
		const { client, storage } = await setupLogger({ captureCookies: true });
		emitRequestWillBeSent(client, { url: "https://sso.test/authorize" });
		await waitForAsyncEvent();
		// The sso hop is recorded here, before its own request ExtraInfo arrives.
		emitRequestWillBeSent(client, { url: "https://idp.test/login" }, SSO_TO_IDP);
		await waitForAsyncEvent();
		// The sso hop's late request ExtraInfo must be dropped, not attributed to idp.
		emitRequestExtraInfo(client, { cookie: "sso-late" });
		// The idp hop's own request ExtraInfo still lands on it.
		emitRequestExtraInfo(client, { cookie: "idp-own" });
		emitFinalResponse(client, "https://idp.test/login");
		await waitForAsyncEvent();

		expect(storage.metadata.map((record) => record.rawRequestHeaders?.["cookie"])).toEqual([
			undefined,
			"idp-own",
		]);
	});

	// Attaching mid-chain buffers a previous hop's response ExtraInfo.
	// It belongs to a hop never recorded, so it must not attach to the next hop.
	it("does not attach a buffered response to the next hop after attaching mid-chain", async () => {
		const { client, storage } = await setupLogger({ captureCookies: true });
		// The sso hop's response arrives first; the logger never saw its requestWillBeSent.
		emitResponseExtraInfo(client, { headers: { "set-cookie": "stale=1" } });
		// This idp hop has no previous state, so it is not recorded.
		// It must not claim the buffered stale response either.
		emitRequestWillBeSent(client, { url: "https://idp.test/login" }, SSO_TO_IDP);
		await waitForAsyncEvent();
		// The app hop now has a previous (idp) state, so idp is recorded here.
		// The idp hop never got its own response ExtraInfo, so its raw headers stay absent.
		emitRequestWillBeSent(client, { url: "https://app.test/session" }, IDP_TO_APP);
		await waitForAsyncEvent();
		emitFinalResponse(client, "https://app.test/session");
		await waitForAsyncEvent();

		const idpRecord = storage.metadata.find((record) => record.url === "https://idp.test/login");
		expect(idpRecord?.rawResponseHeaders).toBeUndefined();
	});

	it("drops buffered raw headers when the target detaches", async () => {
		const { client, storage } = await setupLogger({ captureCookies: true });
		// No base event ever claims this one.
		emitRequestExtraInfo(client, { cookie: "stale=1" });
		client.emit("Target.detachedFromTarget", { sessionId: "session-1", targetId: "target-1" });
		await waitForAsyncEvent();
		attachPageTarget(client);
		await waitForAsyncEvent();
		emitRequestWillBeSent(client, { url: "https://example.test/api" });
		await waitForAsyncEvent();
		emitFinalResponse(client, "https://example.test/api");
		await waitForAsyncEvent();

		expect(storage.metadata[0]?.rawRequestHeaders).toBeUndefined();
	});

	it("assembles a streamed body from the buffered prefix and later chunks in order", async () => {
		const { client, storage } = await setupLogger({ streamBodies: true });
		// The prefix is released only after loadingFinished was already handled.
		const stream = deferStreamResourceContent(client);

		emitRequestWillBeSent(client, { url: "https://example.test/api" });
		await waitForAsyncEvent();
		// The responseReceived event enables streaming; the chunks then carry the bytes.
		emitResponseReceived(client, "https://example.test/api");
		emitDataReceived(client, { data: toBase64("chunk1") });
		emitDataReceived(client, { data: toBase64("chunk2") });
		emitLoadingFinished(client);
		await waitForAsyncEvent();

		// Nothing is written while the prefix is still outstanding.
		expect(storage.recordBodyBytes).not.toHaveBeenCalled();
		stream.resolve({ bufferedData: toBase64("PRE") });
		await waitForAsyncEvent();

		expect(client.Network.streamResourceContent).toHaveBeenCalledWith(
			{ requestId: "request-1" },
			"session-1",
		);
		expect(client.Network.getResponseBody).not.toHaveBeenCalled();
		expect(storage.recordBodyBytes).toHaveBeenCalledWith(
			expect.anything(),
			Buffer.from("PREchunk1chunk2"),
		);
		expect(storage.metadata[0]).toMatchObject({
			base64Encoded: true,
			bodyFile: "bodies/body.json",
			bodySaved: true,
			url: "https://example.test/api",
		});
	});

	it("ignores a dataReceived chunk that has no data, since the prefix already covers it", async () => {
		const { client, storage } = await setupLogger({ streamBodies: true });
		client.Network.streamResourceContent.mockResolvedValueOnce({ bufferedData: toBase64("PRE") });

		emitRequestWillBeSent(client, { url: "https://example.test/api" });
		await waitForAsyncEvent();
		emitResponseReceived(client, "https://example.test/api");
		// A chunk before streaming was enabled reports no data and must not be appended.
		emitDataReceived(client, {});
		emitDataReceived(client, { data: toBase64("tail") });
		emitLoadingFinished(client);
		await waitForAsyncEvent();

		expect(storage.recordBodyBytes).toHaveBeenCalledWith(expect.anything(), Buffer.from("PREtail"));
	});

	it("falls back to getResponseBody when streamResourceContent is not supported", async () => {
		const { client, storage } = await setupLogger({ streamBodies: true });
		// A Chrome without the method fails every request, not only the first.
		client.Network.streamResourceContent.mockRejectedValue(new Error("not supported"));
		const captureOneRequest = async (): Promise<void> => {
			emitRequestWillBeSent(client, { url: "https://example.test/api" });
			await waitForAsyncEvent();
			emitResponseReceived(client, "https://example.test/api");
			emitDataReceived(client, { data: toBase64("ignored") });
			emitLoadingFinished(client);
			await waitForAsyncEvent();
		};
		await captureOneRequest();
		await captureOneRequest();

		expect(client.Network.getResponseBody).toHaveBeenCalledWith(
			{ requestId: "request-1" },
			"session-1",
		);
		expect(storage.metadata[0]).toMatchObject({
			base64Encoded: false,
			bodyFile: "bodies/body.json",
			bodySaved: true,
		});
		// Both requests fell back, but the failure is only reported once per run.
		expect(client.Network.streamResourceContent).toHaveBeenCalledTimes(2);
		expect(storage.errors).toEqual([
			expect.objectContaining({
				error: "not supported",
				event: "Network.streamResourceContent",
				requestId: "request-1",
				url: "https://example.test/api",
			}),
		]);
	});

	it("aborts a streamed body over --max-body-bytes and records it as a skip", async () => {
		const { client, storage } = await setupLogger({ maxBodyBytes: 5, streamBodies: true });
		client.Network.streamResourceContent.mockResolvedValueOnce({ bufferedData: toBase64("PRE") });

		emitRequestWillBeSent(client, { url: "https://example.test/large" });
		await waitForAsyncEvent();
		emitResponseReceived(client, "https://example.test/large");
		// The first chunk alone pushes the running total past the 5-byte limit.
		emitDataReceived(client, { data: toBase64("chunk1") });
		// A chunk after the abort is dropped rather than reviving the freed buffer.
		emitDataReceived(client, { data: toBase64("chunk2") });
		emitLoadingFinished(client);
		await waitForAsyncEvent();

		expect(client.Network.getResponseBody).not.toHaveBeenCalled();
		expect(storage.recordBodyBytes).not.toHaveBeenCalled();
		expect(storage.metadata[0]).toMatchObject({
			bodySaved: false,
			error: "Skipped because the streamed body exceeded --max-body-bytes 5.",
			url: "https://example.test/large",
		});
		expect(storage.errors[0]).toMatchObject({
			event: "Network.getResponseBody.skipped",
			requestId: "request-1",
			url: "https://example.test/large",
		});
	});

	// The buffer path guards on loadingFinished.encodedDataLength.
	// A body small on the wire and large decoded is saved by both paths alike.
	it("guards a streamed body on wire bytes, like the buffer path", async () => {
		const { client, storage } = await setupLogger({ maxBodyBytes: 5, streamBodies: true });
		client.Network.streamResourceContent.mockResolvedValueOnce({ bufferedData: "" });

		emitRequestWillBeSent(client, { url: "https://example.test/compressed" });
		await waitForAsyncEvent();
		emitResponseReceived(client, "https://example.test/compressed");
		// Twelve decoded bytes that cost four on the wire stay under the limit.
		emitDataReceived(client, { data: toBase64("decoded body"), encodedDataLength: 4 });
		emitLoadingFinished(client);
		await waitForAsyncEvent();

		expect(storage.recordBodyBytes).toHaveBeenCalledWith(
			expect.anything(),
			Buffer.from("decoded body"),
		);
		expect(storage.metadata[0]).toMatchObject({ bodySaved: true });
	});

	// An unfinished stream would otherwise accumulate for as long as its target lives.
	it("aborts a stream past the default limit when --max-body-bytes is unset", async () => {
		const { client, storage } = await setupLogger({ streamBodies: true });
		client.Network.streamResourceContent.mockResolvedValueOnce({ bufferedData: toBase64("PRE") });
		const limit = NETWORK_BUFFER_OPTIONS.maxResourceBufferSize;

		emitRequestWillBeSent(client, { url: "https://example.test/media" });
		await waitForAsyncEvent();
		emitResponseReceived(client, "https://example.test/media");
		// Wire bytes past the default cap, without holding that many bytes in the test.
		emitDataReceived(client, { data: toBase64("chunk1"), encodedDataLength: limit + 1 });
		emitLoadingFinished(client);
		await waitForAsyncEvent();

		expect(client.Network.getResponseBody).not.toHaveBeenCalled();
		expect(storage.recordBodyBytes).not.toHaveBeenCalled();
		expect(storage.metadata[0]).toMatchObject({
			bodySaved: false,
			error: `Skipped because the streamed body exceeded the ${limit} byte default stream limit.`,
		});
	});

	// The messages are already captured in eventsource.ndjson.
	// The connection normally never finishes, so it would grow for the page's life.
	it("never streams an event stream", async () => {
		const { client } = await setupLogger({ streamBodies: true });
		emitRequestWillBeSent(client, { url: "https://stream.test/prices" });
		await waitForAsyncEvent();
		// Either the resource type or the MIME type is enough to recognize one.
		emitResponseReceived(client, "https://stream.test/prices", { type: "EventSource" });
		emitResponseReceived(client, "https://stream.test/prices", {
			mimeType: "text/event-stream",
		});
		await waitForAsyncEvent();

		expect(client.Network.streamResourceContent).not.toHaveBeenCalled();
	});

	// Enabling the stream moves the filter decision to the response event.
	it("never streams a url the filters reject", async () => {
		const { client, storage } = await setupLogger({
			exclude: /\/tracker\//u,
			streamBodies: true,
		});

		emitRequestWillBeSent(client, { url: "https://example.test/tracker/pixel" });
		await waitForAsyncEvent();
		emitResponseReceived(client, "https://example.test/tracker/pixel");
		emitDataReceived(client, { data: toBase64("chunk1") });
		emitLoadingFinished(client);
		await waitForAsyncEvent();

		expect(client.Network.streamResourceContent).not.toHaveBeenCalled();
		expect(client.Network.getResponseBody).not.toHaveBeenCalled();
		expect(storage.metadata).toHaveLength(0);
	});

	// A hop is reported through redirectResponse, which never enables a stream.
	it("streams only the terminal response of a redirect chain", async () => {
		const { client, storage } = await setupLogger({ streamBodies: true });
		client.Network.streamResourceContent.mockResolvedValueOnce({ bufferedData: "" });

		emitRequestWillBeSent(client, { url: "https://sso.test/authorize" });
		await waitForAsyncEvent();
		emitRequestWillBeSent(client, { url: "https://idp.test/login" }, SSO_TO_IDP);
		await waitForAsyncEvent();
		emitResponseReceived(client, "https://idp.test/login");
		emitDataReceived(client, { data: toBase64("terminal") });
		emitLoadingFinished(client);
		await waitForAsyncEvent();

		expect(client.Network.streamResourceContent).toHaveBeenCalledTimes(1);
		expect(storage.recordBodyBytes).toHaveBeenCalledTimes(1);
		expect(storage.metadata.map((record) => [record.url, record.redirect])).toEqual([
			["https://sso.test/authorize", true],
			["https://idp.test/login", undefined],
		]);
	});

	it("frees the stream buffer and records no body when the request fails mid-stream", async () => {
		const { client, storage } = await setupLogger({ streamBodies: true });
		client.Network.streamResourceContent.mockResolvedValueOnce({ bufferedData: toBase64("PRE") });

		emitRequestWillBeSent(client, { url: "https://example.test/api" });
		await waitForAsyncEvent();
		emitResponseReceived(client, "https://example.test/api");
		emitDataReceived(client, { data: toBase64("chunk1") });
		emitLoadingFailed(client, "net::ERR_CONNECTION_RESET");
		await waitForAsyncEvent();
		// A finish arriving anyway finds neither request state nor a buffer.
		emitLoadingFinished(client);
		await waitForAsyncEvent();

		expect(storage.recordBodyBytes).not.toHaveBeenCalled();
		expect(storage.recordBody).not.toHaveBeenCalled();
		expect(storage.metadata).toHaveLength(0);
		expect(storage.errors).toEqual([
			expect.objectContaining({
				error: "net::ERR_CONNECTION_RESET",
				event: "Network.loadingFailed",
				url: "https://example.test/api",
			}),
		]);
	});

	// Chrome does not populate `data` on every path, such as a synthesized body.
	// An empty assembly would be saved as a successful zero-byte body.
	it("falls back to getResponseBody when the stream assembled nothing", async () => {
		const { client, storage } = await setupLogger({ streamBodies: true });
		client.Network.streamResourceContent.mockResolvedValueOnce({ bufferedData: "" });

		emitRequestWillBeSent(client, { url: "https://example.test/api" });
		await waitForAsyncEvent();
		emitResponseReceived(client, "https://example.test/api");
		// Bytes were reported, but none of them ever carried a payload.
		emitDataReceived(client, { encodedDataLength: 12 });
		emitLoadingFinished(client);
		await waitForAsyncEvent();

		expect(storage.recordBodyBytes).not.toHaveBeenCalled();
		expect(client.Network.getResponseBody).toHaveBeenCalledWith(
			{ requestId: "request-1" },
			"session-1",
		);
		expect(storage.metadata[0]).toMatchObject({
			base64Encoded: false,
			bodyFile: "bodies/body.json",
			bodySaved: true,
		});
	});

	it("never streams and ignores dataReceived without --stream-bodies", async () => {
		const { client, storage } = await setupLogger({ attach: false });

		expect(client.listenerCount("Network.dataReceived")).toBe(0);

		attachPageTarget(client);
		await waitForAsyncEvent();
		emitRequestWillBeSent(client, { url: "https://example.test/api" });
		await waitForAsyncEvent();
		emitResponseReceived(client, "https://example.test/api");
		emitDataReceived(client, { data: toBase64("chunk1") });
		emitLoadingFinished(client);
		await waitForAsyncEvent();

		expect(client.Network.streamResourceContent).not.toHaveBeenCalled();
		expect(client.Network.getResponseBody).toHaveBeenCalledTimes(1);
		expect(storage.metadata[0]).toMatchObject({
			base64Encoded: false,
			bodySaved: true,
		});
	});

	it("drops a partial stream buffer when the target detaches mid-stream", async () => {
		const { client, storage } = await setupLogger({ streamBodies: true });
		client.Network.streamResourceContent.mockResolvedValueOnce({ bufferedData: toBase64("PRE") });

		emitRequestWillBeSent(client, { url: "https://example.test/api" });
		await waitForAsyncEvent();
		emitResponseReceived(client, "https://example.test/api");
		emitDataReceived(client, { data: toBase64("chunk1") });
		client.emit("Target.detachedFromTarget", { sessionId: "session-1", targetId: "target-1" });
		await waitForAsyncEvent();
		// The finish arrives after the detach already dropped the request and its buffer.
		emitLoadingFinished(client);
		await waitForAsyncEvent();

		expect(storage.recordBody).not.toHaveBeenCalled();
		expect(storage.metadata).toHaveLength(0);
		// One request held both request state and a stream buffer, so two entries went with it.
		expect(storage.errors).toContainEqual(
			expect.objectContaining({
				error: "Target detached with 2 dropped capture state entries.",
				event: "Target.detachedFromTarget",
			}),
		);
	});

	it("leaves browser download behavior alone without --capture-downloads", async () => {
		const { client, logger, storage } = await setupLogger();
		// Nothing is subscribed, so an event from another CDP client changes nothing either.
		emitDownloadWillBegin(client, { url: "https://example.test/statement.pdf" });
		emitDownloadProgress(client, { state: "completed" });
		await waitForAsyncEvent();
		await logger.close();

		expect(client.listenerCount("Browser.downloadWillBegin")).toBe(0);
		expect(client.listenerCount("Browser.downloadProgress")).toBe(0);
		// Nothing was overridden, so shutdown has nothing to put back either.
		expect(client.Browser.setDownloadBehavior).not.toHaveBeenCalled();
		expect(storage.downloads).toHaveLength(0);
	});

	it("records a completed download with the name and url of the download that began", async () => {
		const { client, hooks, storage } = await setupLogger({ captureDownloads: true });
		emitDownloadWillBegin(client, {
			suggestedFilename: "statement-2026-07.pdf",
			url: "https://bank.test/statements/2026-07.pdf",
		});
		emitDownloadProgress(client, { receivedBytes: 512, state: "inProgress", totalBytes: 1024 });
		emitDownloadProgress(client, { receivedBytes: 1024, state: "completed", totalBytes: 1024 });
		await waitForAsyncEvent();

		expect(client.Browser.setDownloadBehavior).toHaveBeenCalledWith({
			behavior: "allowAndName",
			downloadPath: resolve("/captures/run", "downloads"),
			eventsEnabled: true,
		});
		// Only the terminal event is recorded; the in-progress one writes nothing.
		expect(storage.downloads).toHaveLength(1);
		expect(storage.downloads[0]).toMatchObject({
			file: "downloads/download-1",
			frameId: "frame-1",
			guid: "download-1",
			receivedBytes: 1024,
			sha256: "download-hash",
			state: "completed",
			suggestedFilename: "statement-2026-07.pdf",
			totalBytes: 1024,
			url: "https://bank.test/statements/2026-07.pdf",
		});
		expect(storage.downloads[0]?.startedAt).toBeDefined();
		expect(hooks.events).toContainEqual(
			expect.objectContaining({
				download: expect.objectContaining({ file: "downloads/download-1" }),
				event: "download.completed",
			}),
		);
		expect(storage.errors).toHaveLength(0);
	});

	it("records a canceled download without a file so the loss stays visible", async () => {
		const { client, hooks, storage } = await setupLogger({ captureDownloads: true });
		emitDownloadWillBegin(client, { url: "https://bank.test/statements/2026-07.pdf" });
		emitDownloadProgress(client, { receivedBytes: 64, state: "canceled", totalBytes: 1024 });
		await waitForAsyncEvent();

		expect(storage.downloads[0]).toMatchObject({
			receivedBytes: 64,
			state: "canceled",
			suggestedFilename: "statement.pdf",
			url: "https://bank.test/statements/2026-07.pdf",
		});
		expect(storage.downloads[0]?.file).toBeUndefined();
		expect(storage.downloads[0]?.sha256).toBeUndefined();
		// No file exists, so a path-based hook event would have nothing to point at.
		expect(hooks.events.map((event) => event.event)).not.toContain("download.completed");
	});

	// The Browser events are browser-wide, so a closing tab no longer loses the download.
	it("records a download whose target detached before it finished", async () => {
		const { client, storage } = await setupLogger({ captureDownloads: true });
		emitDownloadWillBegin(client, { url: "https://bank.test/statements/2026-07.pdf" });
		client.emit("Target.detachedFromTarget", { sessionId: "session-1", targetId: "target-1" });
		await waitForAsyncEvent();
		emitDownloadProgress(client, { state: "completed" });
		await waitForAsyncEvent();

		expect(storage.downloads).toHaveLength(1);
		expect(storage.downloads[0]).toMatchObject({
			file: "downloads/download-1",
			guid: "download-1",
			state: "completed",
			suggestedFilename: "statement.pdf",
			url: "https://bank.test/statements/2026-07.pdf",
		});
	});

	// Chrome dispatches on every update of a finished download, terminal ones included.
	it("records a repeated terminal download progress event only once", async () => {
		const { client, hooks, storage } = await setupLogger({ captureDownloads: true });
		emitDownloadWillBegin(client, { url: "https://bank.test/statements/2026-07.pdf" });
		emitDownloadProgress(client, { state: "completed" });
		await waitForAsyncEvent();
		emitDownloadProgress(client, { state: "completed" });
		emitDownloadProgress(client, { state: "canceled" });
		await waitForAsyncEvent();

		expect(storage.downloads).toHaveLength(1);
		expect(storage.downloads[0]).toMatchObject({ state: "completed" });
		expect(hooks.events.filter((event) => event.event === "download.completed")).toHaveLength(1);
	});

	// An interrupted download is reported as canceled and may still complete afterwards.
	it("supersedes a canceled download with the completion that follows it", async () => {
		const { client, storage } = await setupLogger({ captureDownloads: true });
		emitDownloadWillBegin(client, { url: "https://bank.test/statements/2026-07.pdf" });
		emitDownloadProgress(client, { receivedBytes: 64, state: "canceled" });
		await waitForAsyncEvent();
		emitDownloadProgress(client, { receivedBytes: 1024, state: "completed" });
		await waitForAsyncEvent();

		// Both lines stay, the later one superseding the loss the earlier one recorded.
		expect(storage.downloads.map((download) => download.state)).toEqual(["canceled", "completed"]);
		expect(storage.downloads[1]).toMatchObject({
			file: "downloads/download-1",
			suggestedFilename: "statement.pdf",
			url: "https://bank.test/statements/2026-07.pdf",
		});
	});

	it("keeps concurrent downloads apart by guid", async () => {
		const { client, storage } = await setupLogger({ captureDownloads: true });
		emitDownloadWillBegin(client, {
			guid: "download-1",
			suggestedFilename: "statement.pdf",
			url: "https://bank.test/statements/2026-07.pdf",
		});
		emitDownloadWillBegin(client, {
			frameId: "frame-2",
			guid: "download-2",
			suggestedFilename: "export.csv",
			url: "https://bank.test/exports/2026-07.csv",
		});
		emitDownloadProgress(client, { guid: "download-2", state: "completed" });
		emitDownloadProgress(client, { guid: "download-1", state: "completed" });
		await waitForAsyncEvent();

		expect(storage.downloads).toHaveLength(2);
		expect(storage.downloads[0]).toMatchObject({
			file: "downloads/download-2",
			frameId: "frame-2",
			suggestedFilename: "export.csv",
			url: "https://bank.test/exports/2026-07.csv",
		});
		expect(storage.downloads[1]).toMatchObject({
			file: "downloads/download-1",
			frameId: "frame-1",
			suggestedFilename: "statement.pdf",
			url: "https://bank.test/statements/2026-07.pdf",
		});
	});

	// In attach mode the browser keeps running, so the override must not outlive the run.
	it("restores the default download behavior when the run ends", async () => {
		const { client, logger, storage } = await setupLogger({
			attach: false,
			captureDownloads: true,
		});

		await logger.close();

		expect(client.Browser.setDownloadBehavior).toHaveBeenLastCalledWith({
			behavior: "default",
		});
		expect(storage.errors).toHaveLength(0);
	});

	// The default is only this run's to restore once this run has overridden it.
	// A failed override leaves whatever the user's Chrome or another CDP client set.
	// Resetting that to default is the very harm the restore exists to avoid.
	it("sends no reset when the download override never took", async () => {
		const { client, logger, storage } = await setupLogger({
			captureDownloads: true,
			start: false,
		});
		const setDownloadBehavior = client.Browser.setDownloadBehavior as Mock<
			(params?: object) => Promise<void>
		>;
		setDownloadBehavior.mockImplementationOnce(() =>
			Promise.reject(new Error("Browser.setDownloadBehavior failed")),
		);

		await logger.start();
		await logger.close();

		expect(setDownloadBehavior.mock.calls.map(([params]) => params)).toEqual([
			expect.objectContaining({ behavior: "allowAndName", eventsEnabled: true }),
		]);
		expect(storage.errors).toEqual([
			expect.objectContaining({
				error: "Browser.setDownloadBehavior failed",
				event: "Browser.setDownloadBehavior",
			}),
		]);
	});

	// The reset used to share the one second drain budget and discard its result.
	// A browser too busy to answer was abandoned in silence.
	// It kept saving downloads into a finished run with nothing in errors.ndjson to say so.
	it("records an unanswered download behavior reset before the connection closes", async () => {
		const { client, logger, storage } = await setupLogger({
			attach: false,
			captureDownloads: true,
			resetTimeoutMs: 5,
		});
		const unanswered = Promise.withResolvers<void>();
		const setDownloadBehavior = client.Browser.setDownloadBehavior as Mock<
			(params?: object) => Promise<void>
		>;

		setDownloadBehavior.mockImplementation(() => unanswered.promise);
		await logger.close();
		unanswered.resolve();

		expect(storage.errors).toContainEqual(
			expect.objectContaining({
				error: expect.stringContaining("did not answer within 5ms"),
				event: "Browser.setDownloadBehavior",
			}),
		);
	});

	it("records a completed download whose file storage could not read", async () => {
		const { client, hooks, storage } = await setupLogger({ captureDownloads: true });
		const recordDownload = storage.recordDownload as Mock<LoggerStorage["recordDownload"]>;
		recordDownload.mockImplementationOnce((download) =>
			Promise.resolve({ ...download, error: "ENOENT: no such file or directory" }),
		);

		emitDownloadWillBegin(client, { url: "https://bank.test/statements/2026-07.pdf" });
		emitDownloadProgress(client, { state: "completed" });
		await waitForAsyncEvent();

		expect(storage.errors).toEqual([
			expect.objectContaining({
				error: "ENOENT: no such file or directory",
				event: "Browser.downloadProgress",
				url: "https://bank.test/statements/2026-07.pdf",
			}),
		]);
		expect(hooks.events.map((event) => event.event)).not.toContain("download.completed");
	});

	// A slow body write is the same race a slow download hash is, and it used to lose.
	// Only downloads extended the drain, so any other handler was abandoned at 1s.
	it("waits past the first drain budget for any handler still recording", async () => {
		const { client, logger, storage } = await setupLogger({
			drainTimeoutMs: 1,
			extendedDrainTimeoutMs: 1_000,
		});
		const slowWrite = Promise.withResolvers<void>();
		const recordCompletedResponse = storage.recordCompletedResponse as Mock<
			LoggerStorage["recordCompletedResponse"]
		>;
		recordCompletedResponse.mockImplementationOnce(async (record) => {
			await slowWrite.promise;
			storage.metadata.push(record);
		});

		emitRequestWillBeSent(client, { url: "https://example.test/api" });
		await waitForAsyncEvent();
		emitFinalResponse(client, "https://example.test/api");
		await waitForAsyncEvent();
		// The write is still in flight when shutdown starts, past the first budget.
		setTimeout(() => {
			slowWrite.resolve();
		}, 20);
		await logger.close();

		expect(storage.metadata).toHaveLength(1);
		expect(storage.errors).toHaveLength(0);
	});

	// The writers close right after this, so an abandoned handler's record is lost.
	it("records the handlers shutdown abandoned before the writers close", async () => {
		const { client, logger, storage } = await setupLogger({
			drainTimeoutMs: 1,
			extendedDrainTimeoutMs: 5,
		});
		const neverWritten = Promise.withResolvers<void>();
		const recordCompletedResponse = storage.recordCompletedResponse as Mock<
			LoggerStorage["recordCompletedResponse"]
		>;
		recordCompletedResponse.mockImplementationOnce(async () => await neverWritten.promise);

		emitRequestWillBeSent(client, { url: "https://example.test/api" });
		await waitForAsyncEvent();
		emitFinalResponse(client, "https://example.test/api");
		await waitForAsyncEvent();
		await logger.close();
		neverWritten.resolve();

		expect(storage.metadata).toHaveLength(0);
		expect(storage.errors).toContainEqual(
			expect.objectContaining({
				error: expect.stringContaining("abandoned 1 event handler"),
				event: "Cdp.drainTimeout",
			}),
		);
	});

	// Messages arrive in wire order and a detach sweeps its state synchronously.
	// An event after it belongs to a target Chrome destroyed, so nothing can complete it.
	// Recording one used to leave a request entry no event will ever remove.
	it("ignores network events for a session that already detached", async () => {
		const { client, storage } = await setupLogger();
		client.emit("Target.detachedFromTarget", { sessionId: "session-1", targetId: "target-1" });
		await waitForAsyncEvent();
		emitRequestWillBeSent(client, { url: "https://sso.test/authorize" });
		await waitForAsyncEvent();
		// The hop would be written off the state the first event resurrected.
		emitRequestWillBeSent(client, { url: "https://idp.test/login" }, SSO_TO_IDP);
		await waitForAsyncEvent();
		// Nothing was resurrected, so the finish that follows finds no state to complete.
		emitFinalResponse(client, "https://idp.test/login");
		await waitForAsyncEvent();

		expect(storage.metadata).toHaveLength(0);
		expect(client.Network.getResponseBody).not.toHaveBeenCalled();
		// The detach dropped nothing either, so it is not an error of its own.
		expect(storage.errors).toHaveLength(0);
	});

	// Streaming a detached session sends a command the browser refuses.
	// The one record the run keeps for a stream failure would then describe that refusal.
	// The first real failure would be the one lost.
	it("never streams a response for a session that already detached", async () => {
		const { client, storage } = await setupLogger({ streamBodies: true });
		client.Network.streamResourceContent.mockImplementation(() =>
			Promise.reject(new Error("Network.streamResourceContent is not supported")),
		);

		attachPageTarget(client, "session-2", "target-2");
		await waitForAsyncEvent();
		client.emit("Target.detachedFromTarget", { sessionId: "session-1", targetId: "target-1" });
		await waitForAsyncEvent();
		emitResponseReceived(client, "https://example.test/gone");
		await waitForAsyncEvent();

		expect(client.Network.streamResourceContent).not.toHaveBeenCalled();

		// The first genuine failure of the run is what the one record must describe.
		emitResponseReceived(client, "https://example.test/api", { sessionId: "session-2" });
		await waitForAsyncEvent();

		expect(client.Network.streamResourceContent).toHaveBeenCalledTimes(1);
		expect(storage.errors).toEqual([
			expect.objectContaining({
				event: "Network.streamResourceContent",
				sessionId: "session-2",
				url: "https://example.test/api",
			}),
		]);
	});

	// The completion awaits the enabling promise.
	// A rejected one aborted the handler and dropped the metadata of a response saved fine.
	it("records the response even when the stream failure record cannot be written", async () => {
		const { client, logger, storage } = await setupLogger({ streamBodies: true });
		client.Network.streamResourceContent.mockImplementationOnce(() =>
			Promise.reject(new Error("Network.streamResourceContent is not supported")),
		);
		const recordError = storage.recordError as Mock<LoggerStorage["recordError"]>;
		recordError.mockImplementationOnce(() => Promise.reject(new Error("write after end")));

		emitRequestWillBeSent(client, { url: "https://example.test/api" });
		await waitForAsyncEvent();
		emitFinalResponse(client, "https://example.test/api");
		await waitForAsyncEvent();
		await logger.close();

		// The failed stream refetches, and the record still reaches metadata.
		expect(client.Network.getResponseBody).toHaveBeenCalledTimes(1);
		expect(storage.metadata).toHaveLength(1);
	});

	// Enabling a stream was started without being tracked, so shutdown never drained it.
	it("drains an enabling stream at shutdown", async () => {
		const { client, logger, storage } = await setupLogger({
			drainTimeoutMs: 1,
			extendedDrainTimeoutMs: 5,
			streamBodies: true,
		});
		const enabling = deferStreamResourceContent(client);

		emitRequestWillBeSent(client, { url: "https://example.test/api" });
		await waitForAsyncEvent();
		emitResponseReceived(client, "https://example.test/api");
		await waitForAsyncEvent();
		await logger.close();
		enabling.resolve({ bufferedData: "" });

		expect(storage.errors).toContainEqual(expect.objectContaining({ event: "Cdp.drainTimeout" }));
	});

	// A tab closing with nothing in flight is ordinary.
	// An error record for it inflates the error total and crowds out the real failures.
	it("records a detach only when it dropped capture state", async () => {
		const { client, storage } = await setupLogger();

		attachPageTarget(client, "session-2", "target-2");
		await waitForAsyncEvent();
		client.emit("Target.detachedFromTarget", { sessionId: "session-2", targetId: "target-2" });
		await waitForAsyncEvent();

		expect(storage.errors).toHaveLength(0);

		emitRequestWillBeSent(client, { url: "https://example.test/api" });
		await waitForAsyncEvent();
		client.emit("Target.detachedFromTarget", { sessionId: "session-1", targetId: "target-1" });
		await waitForAsyncEvent();

		expect(storage.errors).toEqual([
			expect.objectContaining({
				error: "Target detached with 1 dropped capture state entry.",
				event: "Target.detachedFromTarget",
				sessionId: "session-1",
			}),
		]);
	});

	// A browser-level setAutoAttach attaches to the targets that already exist.
	// The explicit attach of every existing target then ran over those very same ones.
	// Both sessions had Network enabled, so the browser delivered every event twice.
	// Every request of an already-open tab then reached metadata.ndjson twice over.
	it("enables network once for a target attached on two sessions", async () => {
		const { client, storage } = await setupLogger();

		attachPageTarget(client, "session-2", "target-1");
		await waitForAsyncEvent();

		expect(client.Network.enable).toHaveBeenCalledTimes(1);
		expect(client.Network.enable).toHaveBeenCalledWith(NETWORK_BUFFER_OPTIONS, "session-1");
		// The duplicate session is still resumed, so no target is left waiting on it.
		expect(client.send).toHaveBeenCalledWith(
			"Runtime.runIfWaitingForDebugger",
			undefined,
			"session-2",
		);

		emitRequestWillBeSent(client, { url: "https://example.test/api" });
		emitRequestWillBeSent(client, { sessionId: "session-2", url: "https://example.test/api" });
		await waitForAsyncEvent();
		emitFinalResponse(client, "https://example.test/api");
		emitResponseReceived(client, "https://example.test/api", { sessionId: "session-2" });
		emitLoadingFinished(client, "session-2");
		await waitForAsyncEvent();

		expect(storage.metadata).toEqual([
			expect.objectContaining({ sessionId: "session-1", url: "https://example.test/api" }),
		]);
		expect(storage.recordBody).toHaveBeenCalledTimes(1);
	});

	// A tab that reloads out of process detaches and attaches again under one target id.
	// Holding its old session as the owner would leave the tab captured by nothing.
	it("captures a target again once its owning session detached", async () => {
		const { client, storage } = await setupLogger();

		client.emit("Target.detachedFromTarget", { sessionId: "session-1", targetId: "target-1" });
		await waitForAsyncEvent();
		attachPageTarget(client, "session-2", "target-1");
		await waitForAsyncEvent();

		expect(client.Network.enable).toHaveBeenCalledTimes(2);
		expect(client.Network.enable).toHaveBeenLastCalledWith(NETWORK_BUFFER_OPTIONS, "session-2");

		emitRequestWillBeSent(client, { sessionId: "session-2", url: "https://example.test/api" });
		await waitForAsyncEvent();
		emitResponseReceived(client, "https://example.test/api", { sessionId: "session-2" });
		emitLoadingFinished(client, "session-2");
		await waitForAsyncEvent();

		expect(storage.metadata).toEqual([
			expect.objectContaining({ sessionId: "session-2", url: "https://example.test/api" }),
		]);
	});

	// Ownership is per target, so a second tab is a target of its own and captured on its own.
	it("enables network for every target of its own", async () => {
		const { client } = await setupLogger();

		attachPageTarget(client, "session-2", "target-2");
		await waitForAsyncEvent();

		expect(client.Network.enable).toHaveBeenCalledTimes(2);
		expect(client.Network.enable).toHaveBeenLastCalledWith(NETWORK_BUFFER_OPTIONS, "session-2");
	});

	// Chrome attaches to the targets that already exist while setAutoAttach is still in flight.
	// Attaching to one of those again only buys a session the attach handler discards.
	it("does not attach again to a target auto-attach already delivered", async () => {
		const { client, logger } = await setupLogger({ start: false });
		client.Target.setAutoAttach.mockImplementationOnce(() => {
			attachPageTarget(client);
			return Promise.resolve();
		});
		client.Target.getTargets.mockImplementationOnce(() =>
			Promise.resolve({
				targetInfos: [
					{
						attached: true,
						browserContextId: "context-1",
						canAccessOpener: false,
						targetId: "target-1",
						title: "Example",
						type: "page",
						url: "https://example.test",
					},
				],
			}),
		);

		await logger.start();
		await waitForAsyncEvent();

		expect(client.Target.attachToTarget).not.toHaveBeenCalled();
		expect(client.Network.enable).toHaveBeenCalledTimes(1);
	});
});

const sentMethods = (client: FakeClient): string[] => client.sent.map((call) => call.method);

describe("CdpResponseLogger storage snapshot", () => {
	it("sends no storage command and writes nothing without the flag", async () => {
		const { client, hooks, logger, storage } = await setupLogger();

		await logger.snapshotStorage();

		expect(storage.snapshots).toEqual([]);
		expect(storage.errors).toEqual([]);
		expect(hooks.events.map((event) => event.event)).not.toContain("storage.snapshot");
		expect(
			sentMethods(client).filter((method) => /^(?:DOMStorage|IndexedDB|Storage)\./u.test(method)),
		).toEqual([]);
		expect(sentMethods(client)).not.toContain("Runtime.evaluate");
		// Attaching and resuming a target is the whole of the logger's Runtime use.
		// That one call is the sanctioned exception, so the domain is asserted as a whole list.
		// Debugger is not sanctioned at all, on this path or any other.
		expect(sentMethods(client).filter((method) => method.startsWith("Runtime."))).toEqual([
			"Runtime.runIfWaitingForDebugger",
		]);
		expect(sentMethods(client).filter((method) => method.startsWith("Debugger."))).toEqual([]);
	});

	// The flag-off and disconnected tests both return before the snapshot module is reached.
	// This is the one test that runs that seam, so it pins what the logger hands it.
	it("snapshots the attached origin and records a failed read against it", async () => {
		const { client, hooks, logger, storage } = await setupLogger({ snapshotStorage: true });
		client.sendReplies.set("Storage.getCookies", { cookies: [] });
		client.sendReplies.set("DOMStorage.getDOMStorageItems", { entries: [["theme", "dark"]] });
		// The failing read names itself in the record, which is what pins the argument order.
		client.sendReplies.set("IndexedDB.enable", new Error("IndexedDB.enable failed"));

		await logger.snapshotStorage();

		expect(storage.snapshots).toHaveLength(1);
		expect(storage.snapshots[0]?.origins).toEqual([
			expect.objectContaining({
				localStorage: { theme: "dark" },
				securityOrigin: "https://example.test",
				targetId: "target-1",
			}),
		]);
		expect(hooks.events.map((event) => event.event)).toContain("storage.snapshot");
		expect(storage.errors).toEqual([
			expect.objectContaining({
				error: "IndexedDB.enable failed",
				event: "IndexedDB.enable",
				url: "https://example.test",
			}),
		]);
		// A snapshot error names the origin it happened on and never a session.
		expect(storage.errors[0]?.sessionId).toBeUndefined();
	});

	// The browser being gone is the normal launch-mode race, not a reason to crash.
	it("records why no snapshot exists when the browser already disconnected", async () => {
		const { client, logger, storage } = await setupLogger({
			attach: false,
			snapshotStorage: true,
		});

		client.emit("disconnect");
		await logger.snapshotStorage();

		expect(storage.snapshots).toEqual([]);
		expect(storage.errors).toEqual([
			expect.objectContaining({
				error: "The browser disconnected before the storage snapshot could be taken.",
				event: "Storage.snapshot",
			}),
		]);
	});
});

describe("startLogger", () => {
	// --capture-downloads points the user's own Chrome at this run directory early on.
	// A throw after that left the run with no logger to close.
	// Chrome kept naming every later download after a GUID and writing it into a dead run.
	it("restores the download behavior when starting fails", async () => {
		const { client, logger } = await setupLogger({ captureDownloads: true, start: false });
		client.Target.setAutoAttach.mockImplementationOnce(() =>
			Promise.reject(new Error("Target.setAutoAttach failed")),
		);

		await expect(startLogger(logger)).rejects.toThrow("Target.setAutoAttach failed");

		expect(client.Browser.setDownloadBehavior.mock.calls.map(([params]) => params)).toEqual([
			expect.objectContaining({ behavior: "allowAndName", eventsEnabled: true }),
			{ behavior: "default" },
		]);
		// The client is a socket this process owns, so a failed start must not leak it.
		expect(client.close).toHaveBeenCalled();
	});

	// A throw before the override went in leaves nothing of this run's to undo.
	// The default sent anyway would clear the behavior the browser already had.
	it("sends no reset when starting fails before the override goes in", async () => {
		const { client, logger } = await setupLogger({ captureDownloads: true, start: false });
		client.Target.setDiscoverTargets.mockImplementationOnce(() =>
			Promise.reject(new Error("Target.setDiscoverTargets failed")),
		);

		await expect(startLogger(logger)).rejects.toThrow("Target.setDiscoverTargets failed");

		expect(client.Browser.setDownloadBehavior).not.toHaveBeenCalled();
		expect(client.close).toHaveBeenCalled();
	});

	// The unguarded Target.getTargets is the other call that can end start().
	it("closes the client when attaching to existing targets fails", async () => {
		const { client, logger } = await setupLogger({ captureDownloads: true, start: false });
		client.Target.getTargets.mockImplementationOnce(() =>
			Promise.reject(new Error("Target.getTargets failed")),
		);

		await expect(startLogger(logger)).rejects.toThrow("Target.getTargets failed");

		expect(client.close).toHaveBeenCalled();
	});

	it("leaves a successful start untouched", async () => {
		const { client, logger } = await setupLogger({ captureDownloads: true, start: false });

		await expect(startLogger(logger)).resolves.toBeUndefined();

		expect(client.close).not.toHaveBeenCalled();
	});
});

const emitTargetInfoChanged = (
	client: FakeClient,
	url: string,
	target: { id?: string; type?: string } = {},
): void => {
	client.emit("Target.targetInfoChanged", {
		targetInfo: {
			attached: true,
			browserContextId: "context-1",
			canAccessOpener: false,
			targetId: target.id ?? "target-1",
			title: "Example",
			type: target.type ?? "page",
			url,
		},
	});
};

const emitDomStorageEvent = (
	client: FakeClient,
	event: string,
	payload: { isLocalStorage?: boolean } & Record<string, unknown> = {},
): void => {
	const { isLocalStorage = true, ...item } = payload;
	client.emit(
		event,
		{ storageId: { isLocalStorage, securityOrigin: "https://example.test" }, ...item },
		"session-1",
	);
};

const emitIndexedDbContentUpdated = (client: FakeClient, session = "session-1"): void => {
	client.emit(
		"Storage.indexedDBContentUpdated",
		{
			bucketId: "bucket-1",
			databaseName: "app-cache",
			objectStoreName: "sessions",
			origin: "https://example.test",
			storageKey: "https://example.test/",
		},
		session,
	);
};

// One entry as CDP hands it over: a bounded preview beside a live handle it drops.
const REMOTE_OBJECT_ENTRY = {
	key: { description: "token", type: "string", value: "token" },
	primaryKey: { description: "token", type: "string", value: "token" },
	value: { className: "Object", objectId: "handle-1", subtype: undefined, type: "object" },
};

const primeTrackingReplies = (client: FakeClient): void => {
	client.sendReplies.set("DOMStorage.getDOMStorageItems", (params: unknown) => ({
		entries: (params as { storageId: { isLocalStorage: boolean } }).storageId.isLocalStorage
			? [["theme", "dark"]]
			: [["tab", "1"]],
	}));
	client.sendReplies.set("IndexedDB.requestDatabaseNames", { databaseNames: [] });
};

describe("CdpResponseLogger storage tracking", () => {
	it("sends no storage command and writes nothing without the flag", async () => {
		const { client, storage } = await setupLogger();
		emitTargetInfoChanged(client, "https://example.test/app");
		emitDomStorageEvent(client, "DOMStorage.domStorageItemAdded", {
			key: "token",
			newValue: "abc123",
		});
		await waitForAsyncEvent();

		expect(storage.storageChanges).toEqual([]);
		expect(
			sentMethods(client).filter((method) => /^(?:DOMStorage|IndexedDB|Storage)\./u.test(method)),
		).toEqual([]);
	});

	// A page attaches on about:blank, so the attach-time URL is not what opens the domains.
	it("reads both web storage areas once a target reaches an origin", async () => {
		const { client, storage } = await setupLogger({ trackStorage: true });
		primeTrackingReplies(client);
		emitTargetInfoChanged(client, "https://example.test/app");
		await waitForAsyncEvent();

		expect(storage.storageChanges).toEqual([
			{
				area: "localStorage",
				change: "baseline",
				key: "theme",
				newValue: "dark",
				securityOrigin: "https://example.test",
				sessionId: "session-1",
				targetId: "target-1",
				timestamp: expect.any(String),
			},
			{
				area: "sessionStorage",
				change: "baseline",
				key: "tab",
				newValue: "1",
				securityOrigin: "https://example.test",
				sessionId: "session-1",
				targetId: "target-1",
				timestamp: expect.any(String),
			},
		]);
		expect(sentMethods(client)).toContain("DOMStorage.enable");
		expect(sentMethods(client)).toContain("Storage.trackIndexedDBForOrigin");
	});

	// The same target reaching the same origin again must not re-read what it already has.
	it("reads a web storage area once per session and origin", async () => {
		const { client, storage } = await setupLogger({ trackStorage: true });
		primeTrackingReplies(client);
		emitTargetInfoChanged(client, "https://example.test/app");
		await waitForAsyncEvent();
		emitTargetInfoChanged(client, "https://example.test/other");
		await waitForAsyncEvent();

		expect(storage.storageChanges).toHaveLength(2);
		expect(
			sentMethods(client).filter((method) => method === "DOMStorage.getDOMStorageItems"),
		).toHaveLength(2);
	});

	it("records every web storage change the browser reports", async () => {
		const { client, storage } = await setupLogger({ trackStorage: true });
		emitDomStorageEvent(client, "DOMStorage.domStorageItemAdded", {
			key: "token",
			newValue: "abc123",
		});
		emitDomStorageEvent(client, "DOMStorage.domStorageItemUpdated", {
			key: "token",
			newValue: "def456",
			oldValue: "abc123",
		});
		emitDomStorageEvent(client, "DOMStorage.domStorageItemRemoved", {
			isLocalStorage: false,
			key: "token",
		});
		emitDomStorageEvent(client, "DOMStorage.domStorageItemsCleared", {});
		await waitForAsyncEvent();

		expect(storage.storageChanges).toEqual([
			expect.objectContaining({
				area: "localStorage",
				change: "added",
				key: "token",
				newValue: "abc123",
				securityOrigin: "https://example.test",
				sessionId: "session-1",
				targetId: "target-1",
			}),
			expect.objectContaining({
				change: "updated",
				newValue: "def456",
				oldValue: "abc123",
			}),
			expect.objectContaining({ area: "sessionStorage", change: "removed", key: "token" }),
			// A cleared area names no key, so neither the key nor a value is carried.
			expect.objectContaining({ area: "localStorage", change: "cleared", key: undefined }),
		]);
	});

	// Chrome says only which store changed, so the record has to come from a read back.
	it("reads an object store back when its contents change", async () => {
		const { client, storage } = await setupLogger({ trackStorage: true });
		client.sendReplies.set("IndexedDB.requestData", {
			hasMore: false,
			objectStoreDataEntries: [REMOTE_OBJECT_ENTRY],
		});
		emitIndexedDbContentUpdated(client);
		await waitForAsyncEvent();

		expect(storage.storageChanges).toEqual([
			expect.objectContaining({
				area: "indexedDB",
				change: "updated",
				databaseName: "app-cache",
				hasMore: false,
				objectStoreName: "sessions",
				securityOrigin: "https://example.test",
				sessionId: "session-1",
			}),
		]);
		// The live handle is meaningless once the run is over, so it is never recorded.
		expect(JSON.stringify(storage.storageChanges)).not.toContain("objectId");
	});

	// Tracking twice would record one change once per tab open on the origin.
	it("tracks IndexedDB once for an origin open in two targets", async () => {
		const { client } = await setupLogger({ trackStorage: true });
		primeTrackingReplies(client);
		attachPageTarget(client, "session-2", "target-2");
		await waitForAsyncEvent();
		emitTargetInfoChanged(client, "https://example.test/app");
		await waitForAsyncEvent();
		emitTargetInfoChanged(client, "https://example.test/app", { id: "target-2" });
		await waitForAsyncEvent();

		expect(
			sentMethods(client).filter((method) => method === "Storage.trackIndexedDBForOrigin"),
		).toHaveLength(1);
	});

	// The tracking dies with the session that asked for it, so the next one must retake it.
	it("retracks an origin after the session holding its tracking detaches", async () => {
		const { client } = await setupLogger({ trackStorage: true });
		primeTrackingReplies(client);
		emitTargetInfoChanged(client, "https://example.test/app");
		await waitForAsyncEvent();
		client.emit("Target.detachedFromTarget", { sessionId: "session-1", targetId: "target-1" });
		await waitForAsyncEvent();
		attachPageTarget(client, "session-2", "target-2");
		await waitForAsyncEvent();
		emitTargetInfoChanged(client, "https://example.test/app", { id: "target-2" });
		await waitForAsyncEvent();

		expect(
			sentMethods(client).filter((method) => method === "Storage.trackIndexedDBForOrigin"),
		).toHaveLength(2);
	});

	// Targets without an http(s) origin have no storage area to read at all.
	it("ignores a target that has not reached an http origin", async () => {
		const { client, storage } = await setupLogger({ trackStorage: true });
		emitTargetInfoChanged(client, "about:blank");
		emitTargetInfoChanged(client, "chrome://newtab");
		await waitForAsyncEvent();

		expect(storage.storageChanges).toEqual([]);
		expect(
			sentMethods(client).filter((method) => /^(?:DOMStorage|IndexedDB|Storage)\./u.test(method)),
		).toEqual([]);
	});

	it("records a failed storage read against the origin it was reading", async () => {
		const { client, storage } = await setupLogger({ trackStorage: true });
		client.sendReplies.set("DOMStorage.getDOMStorageItems", new Error("DOMStorage read failed"));
		client.sendReplies.set("IndexedDB.requestDatabaseNames", { databaseNames: [] });
		emitTargetInfoChanged(client, "https://example.test/app");
		await waitForAsyncEvent();

		expect(storage.errors).toContainEqual(
			expect.objectContaining({
				error: "DOMStorage read failed",
				event: "DOMStorage.getDOMStorageItems",
				sessionId: "session-1",
				url: "https://example.test",
			}),
		);
		expect(storage.storageChanges).toEqual([]);
	});

	// Two updates of one store would otherwise append their pages in whichever order
	// The two reads happened to answer in.
	it("serializes two updates of the same object store", async () => {
		const { client, storage } = await setupLogger({ trackStorage: true });
		const first = Promise.withResolvers<{ hasMore: boolean; objectStoreDataEntries: never[] }>();
		let call = 0;
		client.sendReplies.set("IndexedDB.requestData", () => {
			call += 1;
			return call === 1
				? first.promise
				: Promise.resolve({ hasMore: true, objectStoreDataEntries: [] });
		});
		emitIndexedDbContentUpdated(client);
		emitIndexedDbContentUpdated(client);
		await waitForAsyncEvent();

		expect(call).toBe(1);
		first.resolve({ hasMore: false, objectStoreDataEntries: [] });
		await waitForRecords(() => storage.storageChanges.length === 2);

		expect(storage.storageChanges.map((change) => "hasMore" in change && change.hasMore)).toEqual([
			false,
			true,
		]);
	});
});
