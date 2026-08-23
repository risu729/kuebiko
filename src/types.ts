import type { Protocol } from "devtools-protocol";

type CliOptions = {
	browserArgs: string[];
	browserCommand?: string | undefined;
	browserPath?: string | undefined;
	browserProfile?: string | undefined;
	captureCookies: boolean;
	captureDownloads: boolean;
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
	streamBodies: boolean;
	verbose: boolean;
	version: boolean;
};

type SessionInfo = {
	sessionId: string;
	targetId?: string | undefined;
	targetType?: string | undefined;
	targetUrl?: string | undefined;
};

// Raw wire headers and cookie diagnostics, only collected with --capture-cookies.
// Either ExtraInfo event can precede its base event, so the logger buffers this shape.
type ExtraInfoState = {
	blockedCookies?: Protocol.Network.BlockedSetCookieWithReason[] | undefined;
	cookiePartitionKey?: Protocol.Network.CookiePartitionKey | undefined;
	exemptedCookies?: Protocol.Network.ExemptedSetCookieWithReason[] | undefined;
	rawRequestHeaders?: Protocol.Network.Headers | undefined;
	rawResponseHeaders?: Protocol.Network.Headers | undefined;
};

type RequestState = ExtraInfoState & {
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

// Carries the body result verbatim minus the internal skip flag; raw ExtraInfo fields sit beside the refined headers, absent without the flag.
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
	// On every record of a request that redirected, hops 0-based; terminal takes the next index.
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
} & ExtraInfoState;

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

// One record per browser download, written only with --capture-downloads.
// A canceled download is recorded too, without a file, so the loss stays visible.
// The Browser download events are browser-wide and name only the frame behind one.
// A record is therefore tied to its origin by frameId, not by CDP session.
type DownloadRecord = {
	error?: string | undefined;
	// Saved file relative to the run directory, absent unless the file was hashed.
	file?: string | undefined;
	frameId?: string | undefined;
	guid: string;
	receivedBytes?: number | undefined;
	sha256?: string | undefined;
	startedAt?: string | undefined;
	state: "canceled" | "completed";
	suggestedFilename?: string | undefined;
	timestamp: string;
	totalBytes?: number | undefined;
	url?: string | undefined;
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

// Published for a saved download only: a canceled one has no file to hand a plugin.
type DownloadCompletedHookEvent = HookEventBase & {
	download: DownloadRecord;
	event: "download.completed";
};

type CaptureErrorHookEvent = HookEventBase & { error: ErrorRecord; event: "capture.error" };

type HookEvent =
	| CaptureErrorHookEvent
	| DownloadCompletedHookEvent
	| EventSourceMessageHookEvent
	| ResponseCompletedHookEvent
	| RunHookEvent
	| WebSocketFrameHookEvent;

type HookPublisher = {
	close: () => Promise<void>;
	publish: (event: HookEvent) => Promise<void>;
};

// Storage owns the run directory, so it also identifies the run to every hook event.
type LoggerStorage = RunRef & {
	close: () => Promise<void>;
	recordRequestBody: (state: RequestState, postData: string) => Promise<RequestBodySaveResult>;
	recordBody: (
		state: RequestState,
		body: Protocol.Network.GetResponseBodyResponse,
	) => Promise<BodySaveResult & { base64Encoded: boolean }>;
	// Bytes already assembled, saved without the base64 round-trip recordBody needs.
	recordBodyBytes: (state: RequestState, bytes: Uint8Array) => Promise<BodySaveResult>;
	recordCompletedResponse: (metadata: CompletedResponseMetadata) => Promise<void>;
	// Hashes the saved file for a completed download, then appends the record it wrote.
	recordDownload: (download: DownloadRecord) => Promise<DownloadRecord>;
	recordError: (error: ErrorRecord) => Promise<void>;
	recordEventSourceMessage: (message: EventSourceMessageRecord) => Promise<void>;
	recordWebSocketFrame: (frame: WebSocketFrameRecord) => Promise<void>;
};

export type {
	BodySaveResult,
	CaptureErrorHookEvent,
	CliOptions,
	CompletedResponseMetadata,
	DownloadCompletedHookEvent,
	DownloadRecord,
	ErrorRecord,
	EventSourceMessageHookEvent,
	EventSourceMessageRecord,
	ExtraInfoState,
	HookEvent,
	HookEventName,
	HookPublisher,
	LoggerStorage,
	RequestState,
	RequestBodySaveResult,
	RequestBodySource,
	ResponseCompletedHookEvent,
	RunRef,
	RunHookEvent,
	SessionInfo,
	WebSocketFrameHookEvent,
	WebSocketFrameRecord,
};
