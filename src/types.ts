import type { Protocol } from "devtools-protocol";

type MaybePromise<T> = T | Promise<T>;

type CliOptions = {
	browserArgs: string[];
	browserCommand?: string | undefined;
	browserPath?: string | undefined;
	browserProfile?: string | undefined;
	config?: string | undefined;
	cdp: string;
	cdpPort: number;
	exclude?: RegExp | undefined;
	help: boolean;
	include?: RegExp | undefined;
	labels: string[];
	launchBrowser: boolean;
	maxBodyBytes?: number | undefined;
	netlog: boolean;
	noPlugins: boolean;
	note?: string | undefined;
	out?: string | undefined;
	verbose: boolean;
	version: boolean;
};

type SessionInfo = {
	sessionId: string;
	targetId?: string | undefined;
	targetType?: string | undefined;
	targetUrl?: string | undefined;
};

type RequestState = {
	frameId?: string | undefined;
	hasPostData?: boolean | undefined;
	initiator?: Protocol.Network.Initiator | undefined;
	loaderId?: string | undefined;
	// Position in the redirect chain, left undefined until the first redirect hop.
	redirectIndex?: number | undefined;
	requestContentType?: string | undefined;
	requestHeaders?: Protocol.Network.Headers | undefined;
	requestId: Protocol.Network.RequestId;
	requestMethod?: string | undefined;
	requestPostData?: string | undefined;
	requestTime?: string | undefined;
	requestUrl?: string | undefined;
	response?: Protocol.Network.Response | undefined;
	session: SessionInfo;
	type?: Protocol.Network.ResourceType | undefined;
};

type BodySaveResult = {
	bodyFile?: string | undefined;
	bodyLength?: number | undefined;
	bodySaved: boolean;
	bodySha256?: string | undefined;
	error?: string | undefined;
	skipped?: boolean | undefined;
};

type RequestBodySource = "requestWillBeSent" | "getRequestPostData";

type RequestBodySaveResult = BodySaveResult & { source: RequestBodySource };

// Carries the response body result verbatim; only the skip flag stays internal.
type CompletedResponseMetadata = Omit<BodySaveResult, "skipped"> & {
	base64Encoded?: boolean | undefined;
	encodedDataLength?: number | undefined;
	fromDiskCache?: boolean | undefined;
	fromPrefetchCache?: boolean | undefined;
	fromServiceWorker?: boolean | undefined;
	loaderId?: string | undefined;
	mimeType?: string | undefined;
	protocol?: string | undefined;
	// Set on redirect hops only; a terminal response never carries it.
	redirect?: boolean | undefined;
	// Present on every record of a request that redirected, hops being 0-based.
	// The terminal response takes the index after the last hop.
	redirectIndex?: number | undefined;
	remoteIPAddress?: string | undefined;
	remotePort?: number | undefined;
	requestBodyError?: string | undefined;
	requestBodyFile?: string | undefined;
	requestBodyLength?: number | undefined;
	requestBodySaved?: boolean | undefined;
	requestBodySha256?: string | undefined;
	requestBodySource?: RequestBodySource | undefined;
	requestHeaders?: Protocol.Network.Headers | undefined;
	requestId: string;
	requestMethod?: string | undefined;
	responseHeaders?: Protocol.Network.Headers | undefined;
	runTimestamp: string;
	sessionId: string;
	status?: number | undefined;
	statusText?: string | undefined;
	tabTargetId?: string | undefined;
	targetType?: string | undefined;
	targetUrl?: string | undefined;
	type?: string | undefined;
	url?: string | undefined;
};

type ErrorRecord = {
	error: string;
	event: string;
	pluginId?: string | undefined;
	requestId?: string | undefined;
	sessionId?: string | undefined;
	targetId?: string | undefined;
	timestamp: string;
	url?: string | undefined;
};

// Streams are recorded per frame or message, with no url when the stream is unknown.
type StreamRecord = {
	requestId: string;
	sessionId: string;
	targetId?: string | undefined;
	timestamp: string;
	url?: string | undefined;
};

type EventSourceMessageRecord = StreamRecord & {
	data: string;
	eventId: string;
	eventName: string;
};

type WebSocketFrameRecord = StreamRecord & {
	direction: "sent" | "received";
	opcode: number;
	payloadData: string;
};

type RunRef = {
	runDirectory: string;
	runTimestamp: string;
};

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

type CaptureErrorHookEvent = HookEventBase & { error: ErrorRecord; event: "capture.error" };

type HookEvent =
	| CaptureErrorHookEvent
	| EventSourceMessageHookEvent
	| ResponseCompletedHookEvent
	| RunHookEvent
	| WebSocketFrameHookEvent;

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

type LoggerPluginConfig = {
	enabled?: boolean | undefined;
	module: string;
	options?: unknown;
	queueSize?: number | undefined;
	timeoutMs?: number | undefined;
};

type LoggerConfig = {
	plugins?: LoggerPluginConfig[] | undefined;
};

type HookPublisher = {
	close: () => Promise<void>;
	publish: (event: HookEvent) => Promise<void>;
};

type LoggerStorage = {
	close: () => Promise<void>;
	recordRequestBody: (state: RequestState, postData: string) => Promise<RequestBodySaveResult>;
	recordBody: (
		state: RequestState,
		body: Protocol.Network.GetResponseBodyResponse,
	) => Promise<BodySaveResult & { base64Encoded: boolean }>;
	recordCompletedResponse: (metadata: CompletedResponseMetadata) => Promise<void>;
	recordError: (error: ErrorRecord) => Promise<void>;
	recordEventSourceMessage: (message: EventSourceMessageRecord) => Promise<void>;
	recordWebSocketFrame: (frame: WebSocketFrameRecord) => Promise<void>;
	runDirectory: string;
	runTimestamp: string;
};

type StartLoggerOptions = {
	cdp: string;
	exclude?: RegExp | undefined;
	hooks?: HookPublisher | undefined;
	include?: RegExp | undefined;
	maxBodyBytes?: number | undefined;
	storage: LoggerStorage;
	verbose: boolean;
};

export type {
	BodySaveResult,
	CaptureErrorHookEvent,
	CliOptions,
	CompletedResponseMetadata,
	ErrorRecord,
	EventSourceMessageHookEvent,
	EventSourceMessageRecord,
	HookEvent,
	HookEventName,
	HookPublisher,
	LoggerConfig,
	LoggerPlugin,
	LoggerPluginConfig,
	LoggerStorage,
	MaybePromise,
	PluginContext,
	RequestState,
	RequestBodySaveResult,
	RequestBodySource,
	ResponseCompletedHookEvent,
	RunRef,
	RunHookEvent,
	SessionInfo,
	StartLoggerOptions,
	WebSocketFrameHookEvent,
	WebSocketFrameRecord,
};
