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
	launchBrowser: boolean;
	maxBodyBytes?: number | undefined;
	netlog: boolean;
	noPlugins: boolean;
	out?: string | undefined;
	verbose: boolean;
	version: boolean;
};

type RunInfo = {
	cdpEndpoint: string;
	createdAt: string;
	nodePlatform: NodeJS.Platform;
	pid: number;
	runDirectory: string;
	tool: string;
	version: string;
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

type RequestBodySaveResult = BodySaveResult & {
	source: RequestBodySource;
};

type CompletedResponseMetadata = {
	base64Encoded?: boolean | undefined;
	bodyFile?: string | undefined;
	bodyLength?: number | undefined;
	bodySaved: boolean;
	bodySha256?: string | undefined;
	encodedDataLength?: number | undefined;
	error?: string | undefined;
	fromDiskCache?: boolean | undefined;
	fromPrefetchCache?: boolean | undefined;
	fromServiceWorker?: boolean | undefined;
	loaderId?: string | undefined;
	mimeType?: string | undefined;
	protocol?: string | undefined;
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

type WebSocketFrameRecord = {
	direction: "received";
	opcode: number;
	payloadData: string;
	requestId: string;
	sessionId: string;
	targetId?: string | undefined;
	timestamp: string;
	url?: string | undefined;
};

type RunRef = {
	runDirectory: string;
	runTimestamp: string;
};

type HookEventName =
	| "run.started"
	| "run.stopping"
	| "run.stopped"
	| "response.completed"
	| "websocket.frame.received"
	| "capture.error";

type RunHookEvent = {
	event: "run.started" | "run.stopping" | "run.stopped";
	run: RunRef;
	timestamp: string;
	version: 1;
};

type ResponseCompletedHookEvent = {
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
		status?: number | undefined;
		statusText?: string | undefined;
	};
	run: RunRef;
	target: {
		targetId?: string | undefined;
		targetType?: string | undefined;
		targetUrl?: string | undefined;
	};
	timestamp: string;
	version: 1;
};

type WebSocketFrameHookEvent = {
	event: "websocket.frame.received";
	frame: WebSocketFrameRecord;
	run: RunRef;
	timestamp: string;
	version: 1;
};

type CaptureErrorHookEvent = {
	error: ErrorRecord;
	event: "capture.error";
	run: RunRef;
	timestamp: string;
	version: 1;
};

type HookEvent =
	| CaptureErrorHookEvent
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
	RunInfo,
	RunRef,
	RunHookEvent,
	SessionInfo,
	StartLoggerOptions,
	WebSocketFrameHookEvent,
	WebSocketFrameRecord,
};
