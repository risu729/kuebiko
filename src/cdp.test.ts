import { describe, expect, it, mock } from "bun:test";
import type { Mock } from "bun:test";
import { EventEmitter } from "node:events";

import type { Protocol } from "devtools-protocol";

import { CdpResponseLogger, createCompletedMetadata } from "./cdp";
import type {
	CompletedResponseMetadata,
	ErrorRecord,
	EventSourceMessageRecord,
	HookEvent,
	HookPublisher,
	LoggerStorage,
	RequestState,
	RequestBodySource,
	WebSocketFrameRecord,
} from "./types";

class FakeClient extends EventEmitter {
	Network = {
		enable: mock(() => Promise.resolve()),
		getRequestPostData: mock(() =>
			Promise.resolve({
				postData: '{"from":"getRequestPostData"}',
			}),
		),
		getResponseBody: mock(() =>
			Promise.resolve({
				base64Encoded: false,
				body: '{"ok":true}',
			}),
		),
	};

	Target = {
		attachToTarget: mock(() => Promise.resolve({ sessionId: "session-1" })),
		getTargets: mock(() => Promise.resolve({ targetInfos: [] })),
		setAutoAttach: mock(() => Promise.resolve()),
		setDiscoverTargets: mock(() => Promise.resolve()),
	};

	close = mock(() => Promise.resolve());

	send = mock(() => Promise.resolve());
}

const createStorage = (): LoggerStorage & {
	errors: ErrorRecord[];
	eventSource: EventSourceMessageRecord[];
	metadata: CompletedResponseMetadata[];
	websocket: WebSocketFrameRecord[];
} => {
	const metadata: CompletedResponseMetadata[] = [];
	const errors: ErrorRecord[] = [];
	const eventSource: EventSourceMessageRecord[] = [];
	const websocket: WebSocketFrameRecord[] = [];

	return {
		close: mock(() => Promise.resolve()),
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
		recordCompletedResponse: mock((record) => {
			metadata.push(record);
			return Promise.resolve();
		}),
		recordError: mock((record) => {
			errors.push(record);
			return Promise.resolve();
		}),
		recordEventSourceMessage: mock((record) => {
			eventSource.push(record);
			return Promise.resolve();
		}),
		recordWebSocketFrame: mock((record) => {
			websocket.push(record);
			return Promise.resolve();
		}),
		runDirectory: "/captures/run",
		runTimestamp: "2026-07-06T12:34:56Z",
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
	request: { hasPostData?: boolean; method?: string; postData?: string; url: string },
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
			requestId: "request-1",
			timestamp: 1,
			type: "Document",
			wallTime: 1,
		},
		"session-1",
	);
};

const emitFinalResponse = (client: FakeClient, url: string): void => {
	client.emit(
		"Network.responseReceived",
		{
			frameId: "frame-1",
			hasExtraInfo: false,
			loaderId: "loader-1",
			requestId: "request-1",
			response: {
				headers: { "content-type": "text/html" },
				mimeType: "text/html",
				status: 200,
				statusText: "OK",
				url,
			},
			timestamp: 4,
			type: "Document",
		},
		"session-1",
	);
	client.emit(
		"Network.loadingFinished",
		{ encodedDataLength: 123, requestId: "request-1", timestamp: 5 },
		"session-1",
	);
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
	message: { data: string; eventId?: string; eventName?: string; requestId?: string },
): void => {
	client.emit(
		"Network.eventSourceMessageReceived",
		{
			data: message.data,
			eventId: message.eventId ?? "",
			eventName: message.eventName ?? "message",
			requestId: message.requestId ?? "request-1",
			timestamp: 9,
		},
		"session-1",
	);
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
		const client = new FakeClient();
		const storage = createStorage();
		const hooks = createHooks();
		const logger = new CdpResponseLogger(client as never, {
			cdp: "http://127.0.0.1:9222",
			hooks,
			storage,
			verbose: false,
		});

		await logger.start();
		client.emit("Target.attachedToTarget", {
			sessionId: "session-1",
			targetInfo: {
				attached: true,
				browserContextId: "context-1",
				canAccessOpener: false,
				targetId: "target-1",
				title: "Example",
				type: "page",
				url: "https://example.test",
			},
			waitingForDebugger: false,
		});
		await waitForAsyncEvent();
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
		const client = new FakeClient();
		const storage = createStorage();
		const logger = new CdpResponseLogger(client as never, {
			cdp: "http://127.0.0.1:9222",
			storage,
			verbose: false,
		});

		await logger.start();
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
			waitingForDebugger: false,
		});
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
		const client = new FakeClient();
		client.send.mockRejectedValueOnce(new Error("resume failed"));
		const storage = createStorage();
		const logger = new CdpResponseLogger(client as never, {
			cdp: "http://127.0.0.1:9222",
			storage,
			verbose: false,
		});

		await logger.start();
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
			waitingForDebugger: true,
		});
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
		const client = new FakeClient();
		const storage = createStorage();
		const logger = new CdpResponseLogger(client as never, {
			cdp: "http://127.0.0.1:9222",
			storage,
			verbose: false,
		});

		await logger.start();
		client.emit("Target.attachedToTarget", {
			sessionId: "session-1",
			targetInfo: {
				attached: true,
				browserContextId: "context-1",
				canAccessOpener: false,
				targetId: "target-1",
				title: "Example",
				type: "page",
				url: "https://example.test",
			},
			waitingForDebugger: false,
		});
		await waitForAsyncEvent();
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
		const client = new FakeClient();
		const storage = createStorage();
		const logger = new CdpResponseLogger(client as never, {
			cdp: "http://127.0.0.1:9222",
			storage,
			verbose: false,
		});

		await logger.start();
		client.emit("Target.attachedToTarget", {
			sessionId: "session-1",
			targetInfo: {
				attached: true,
				browserContextId: "context-1",
				canAccessOpener: false,
				targetId: "target-1",
				title: "Example",
				type: "page",
				url: "https://example.test",
			},
			waitingForDebugger: false,
		});
		await waitForAsyncEvent();
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
		const client = new FakeClient();
		const storage = createStorage();
		const recordRequestBody = storage.recordRequestBody as Mock<LoggerStorage["recordRequestBody"]>;
		recordRequestBody.mockResolvedValueOnce({
			bodySaved: false,
			error: "disk full",
			source: "requestWillBeSent",
		});
		const logger = new CdpResponseLogger(client as never, {
			cdp: "http://127.0.0.1:9222",
			storage,
			verbose: false,
		});

		await logger.start();
		client.emit("Target.attachedToTarget", {
			sessionId: "session-1",
			targetInfo: {
				attached: true,
				browserContextId: "context-1",
				canAccessOpener: false,
				targetId: "target-1",
				title: "Example",
				type: "page",
				url: "https://example.test",
			},
			waitingForDebugger: false,
		});
		await waitForAsyncEvent();
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
		const client = new FakeClient();
		client.Network.getRequestPostData.mockResolvedValueOnce({} as never);
		const storage = createStorage();
		const logger = new CdpResponseLogger(client as never, {
			cdp: "http://127.0.0.1:9222",
			storage,
			verbose: false,
		});

		await logger.start();
		client.emit("Target.attachedToTarget", {
			sessionId: "session-1",
			targetInfo: {
				attached: true,
				browserContextId: "context-1",
				canAccessOpener: false,
				targetId: "target-1",
				title: "Example",
				type: "page",
				url: "https://example.test",
			},
			waitingForDebugger: false,
		});
		await waitForAsyncEvent();
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
		const client = new FakeClient();
		client.Network.getResponseBody.mockRejectedValueOnce(new Error("No resource with given id"));
		const storage = createStorage();
		const logger = new CdpResponseLogger(client as never, {
			cdp: "http://127.0.0.1:9222",
			storage,
			verbose: false,
		});

		await logger.start();
		client.emit("Target.attachedToTarget", {
			sessionId: "session-1",
			targetInfo: {
				attached: true,
				browserContextId: "context-1",
				canAccessOpener: false,
				targetId: "target-1",
				title: "Example",
				type: "page",
				url: "https://example.test",
			},
			waitingForDebugger: false,
		});
		await waitForAsyncEvent();
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
		const client = new FakeClient();
		const storage = createStorage();
		const logger = new CdpResponseLogger(client as never, {
			cdp: "http://127.0.0.1:9222",
			maxBodyBytes: 10,
			storage,
			verbose: false,
		});

		await logger.start();
		client.emit("Target.attachedToTarget", {
			sessionId: "session-1",
			targetInfo: {
				attached: true,
				browserContextId: "context-1",
				canAccessOpener: false,
				targetId: "target-1",
				title: "Example",
				type: "page",
				url: "https://example.test",
			},
			waitingForDebugger: false,
		});
		await waitForAsyncEvent();
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
		const client = new FakeClient();
		const storage = createStorage();
		const hooks = createHooks();
		const logger = new CdpResponseLogger(client as never, {
			cdp: "http://127.0.0.1:9222",
			hooks,
			storage,
			verbose: false,
		});

		await logger.start();
		attachPageTarget(client);
		await waitForAsyncEvent();
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
		const client = new FakeClient();
		const storage = createStorage();
		const logger = new CdpResponseLogger(client as never, {
			cdp: "http://127.0.0.1:9222",
			exclude: /idp\.test/u,
			storage,
			verbose: false,
		});

		await logger.start();
		attachPageTarget(client);
		await waitForAsyncEvent();
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
		const client = new FakeClient();
		const storage = createStorage();
		const logger = new CdpResponseLogger(client as never, {
			cdp: "http://127.0.0.1:9222",
			storage,
			verbose: false,
		});

		await logger.start();
		attachPageTarget(client);
		await waitForAsyncEvent();
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
		const client = new FakeClient();
		const storage = createStorage();
		const logger = new CdpResponseLogger(client as never, {
			cdp: "http://127.0.0.1:9222",
			storage,
			verbose: false,
		});

		await logger.start();
		attachPageTarget(client);
		await waitForAsyncEvent();
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
		const client = new FakeClient();
		const storage = createStorage();
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
		const logger = new CdpResponseLogger(client as never, {
			cdp: "http://127.0.0.1:9222",
			storage,
			verbose: false,
		});

		await logger.start();
		attachPageTarget(client);
		await waitForAsyncEvent();
		// The whole chain arrives in one burst, as it does on a real connection.
		emitRequestWillBeSent(client, {
			method: "POST",
			postData: '{"hello":"world"}',
			url: "https://sso.test/authorize",
		});
		emitRequestWillBeSent(client, { url: "https://idp.test/login" }, SSO_TO_IDP);
		emitRequestWillBeSent(client, { url: "https://app.test/session" }, IDP_TO_APP);
		emitFinalResponse(client, "https://app.test/session");
		await Bun.sleep(60);

		expect(storage.metadata.map((record) => record.redirectIndex)).toEqual([0, 1, 2]);
		expect(storage.metadata.map((record) => record.status)).toEqual([301, 302, 200]);
	});

	it("keeps capturing when a hop metadata write fails", async () => {
		const client = new FakeClient();
		const storage = createStorage();
		const recordCompletedResponse = storage.recordCompletedResponse as Mock<
			LoggerStorage["recordCompletedResponse"]
		>;
		recordCompletedResponse.mockRejectedValueOnce(new Error("metadata write failed"));
		const logger = new CdpResponseLogger(client as never, {
			cdp: "http://127.0.0.1:9222",
			storage,
			verbose: false,
		});

		await logger.start();
		attachPageTarget(client);
		await waitForAsyncEvent();
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
		const client = new FakeClient();
		const storage = createStorage();
		const logger = new CdpResponseLogger(client as never, {
			cdp: "http://127.0.0.1:9222",
			storage,
			verbose: false,
		});

		await logger.start();
		attachPageTarget(client);
		await waitForAsyncEvent();
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
		const client = new FakeClient();
		const storage = createStorage();
		const hooks = createHooks();
		const logger = new CdpResponseLogger(client as never, {
			cdp: "http://127.0.0.1:9222",
			hooks,
			storage,
			verbose: false,
		});

		await logger.start();
		attachPageTarget(client);
		await waitForAsyncEvent();
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
		const client = new FakeClient();
		const storage = createStorage();
		const logger = new CdpResponseLogger(client as never, {
			cdp: "http://127.0.0.1:9222",
			storage,
			verbose: false,
		});

		await logger.start();
		attachPageTarget(client);
		await waitForAsyncEvent();
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
		const client = new FakeClient();
		const storage = createStorage();
		const logger = new CdpResponseLogger(client as never, {
			cdp: "http://127.0.0.1:9222",
			storage,
			verbose: false,
		});

		await logger.start();
		attachPageTarget(client);
		await waitForAsyncEvent();
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
		const client = new FakeClient();
		const storage = createStorage();
		const logger = new CdpResponseLogger(client as never, {
			cdp: "http://127.0.0.1:9222",
			storage,
			verbose: false,
		});

		await logger.start();
		attachPageTarget(client);
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
		const client = new FakeClient();
		const storage = createStorage();
		const logger = new CdpResponseLogger(client as never, {
			cdp: "http://127.0.0.1:9222",
			storage,
			verbose: false,
		});

		await logger.start();
		attachPageTarget(client);
		await waitForAsyncEvent();
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
		const client = new FakeClient();
		const storage = createStorage();
		const logger = new CdpResponseLogger(client as never, {
			cdp: "http://127.0.0.1:9222",
			storage,
			verbose: false,
		});

		await logger.start();
		attachPageTarget(client);
		await waitForAsyncEvent();
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
		const client = new FakeClient();
		const storage = createStorage();
		const hooks = createHooks();
		const logger = new CdpResponseLogger(client as never, {
			cdp: "http://127.0.0.1:9222",
			hooks,
			storage,
			verbose: false,
		});

		await logger.start();
		attachPageTarget(client);
		await waitForAsyncEvent();
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
		const client = new FakeClient();
		const storage = createStorage();
		const logger = new CdpResponseLogger(client as never, {
			cdp: "http://127.0.0.1:9222",
			storage,
			verbose: false,
		});

		await logger.start();
		attachPageTarget(client);
		await waitForAsyncEvent();
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

	// Detaching drops the request state, so later messages lose the URL but are still recorded.
	it("records eventsource messages without a url after the target detached", async () => {
		const client = new FakeClient();
		const storage = createStorage();
		const logger = new CdpResponseLogger(client as never, {
			cdp: "http://127.0.0.1:9222",
			storage,
			verbose: false,
		});

		await logger.start();
		attachPageTarget(client);
		await waitForAsyncEvent();
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
});
