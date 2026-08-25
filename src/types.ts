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
	snapshotStorage: boolean;
	streamBodies: boolean;
	trackStorage: boolean;
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

// Web storage and IndexedDB are keyed by origin, and neither change has a request id.
// A record therefore names the session and target it was observed on instead.
type StorageRecord = {
	securityOrigin?: string | undefined;
	sessionId: string;
	storageKey?: string | undefined;
	targetId?: string | undefined;
	timestamp: string;
};

// One line per observed storage change, written only with --track-storage.
// A `baseline` change is the state an area already held when the logger reached it.
// Folding the file forward from there never starts from an assumed-empty area.
type StorageChangeRecord = DomStorageChangeRecord | IndexedDbChangeRecord;

type DomStorageChangeRecord = StorageRecord & {
	area: "localStorage" | "sessionStorage";
	change: "added" | "baseline" | "cleared" | "removed" | "updated";
	// Absent for a cleared area, which names no key of its own.
	key?: string | undefined;
	newValue?: string | undefined;
	oldValue?: string | undefined;
};

// Chrome says only which store changed, so the entries are read back per change.
// The same per-store caps the end-of-run snapshot uses bound that read.
type IndexedDbChangeRecord = StorageRecord & {
	area: "indexedDB";
	change: "baseline" | "updated";
	databaseName: string;
	entries: IndexedDbEntrySnapshot[];
	error?: string | undefined;
	// True when the store still holds entries past the ones read.
	hasMore: boolean;
	objectStoreName: string;
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

// One end-of-run storage snapshot, written whole to storage-snapshot.json.
// Only produced with --snapshot-storage, and never appended to during a run.
type StorageSnapshot = {
	cookies: Protocol.Network.Cookie[];
	origins: OriginStorageSnapshot[];
	runTimestamp: string;
	timestamp: string;
	// Set when a cap or the snapshot deadline cut the read short.
	truncated?: boolean | undefined;
};

type OriginStorageSnapshot = {
	databases: IndexedDbDatabaseSnapshot[];
	// Absent when the DOMStorage read failed; an empty area is an empty object.
	localStorage?: Record<string, string> | undefined;
	securityOrigin: string;
	sessionStorage?: Record<string, string> | undefined;
	targetId?: string | undefined;
	// Databases past the per-origin cap, omitted when none were dropped.
	truncatedDatabases?: number | undefined;
};

type IndexedDbDatabaseSnapshot = {
	error?: string | undefined;
	name: string;
	objectStores: IndexedDbObjectStoreSnapshot[];
	truncatedObjectStores?: number | undefined;
	version?: number | undefined;
};

type IndexedDbObjectStoreSnapshot = {
	autoIncrement: boolean;
	entries: IndexedDbEntrySnapshot[];
	error?: string | undefined;
	// True when the store still holds entries past the ones read.
	hasMore: boolean;
	keyPath?: Protocol.IndexedDB.KeyPath | undefined;
	name: string;
};

type IndexedDbEntrySnapshot = {
	key: StorageSnapshotValue;
	primaryKey: StorageSnapshotValue;
	value: StorageSnapshotValue;
};

// What IndexedDB.requestData returns per field, minus the live object handle.
// Resolving that handle would need the Runtime domain, which this tool never uses.
// Every field is written out, and JSON.stringify drops the ones CDP left empty.
type StorageSnapshotValue = {
	[Key in keyof Omit<Protocol.Runtime.RemoteObject, "customPreview" | "objectId">]:
		| Protocol.Runtime.RemoteObject[Key]
		| undefined;
};

// Published to plugins and printed in the run summary; contents stay in the file.
type StorageSnapshotCounts = {
	cookies: number;
	databases: number;
	entries: number;
	items: number;
	origins: number;
};

type RunRef = {
	runDirectory: string;
	runTimestamp: string;
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
	recordStorageChange: (change: StorageChangeRecord) => Promise<void>;
	// Writes the whole snapshot once and answers with its run-relative path.
	recordStorageSnapshot: (snapshot: StorageSnapshot) => Promise<string>;
	recordWebSocketFrame: (frame: WebSocketFrameRecord) => Promise<void>;
};

export type {
	BodySaveResult,
	CliOptions,
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
	RunRef,
	SessionInfo,
	StorageChangeRecord,
	StorageSnapshot,
	StorageSnapshotCounts,
	StorageSnapshotValue,
	WebSocketFrameRecord,
};
