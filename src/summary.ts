import type { ErrorRecord, StorageSnapshot, StorageSnapshotCounts } from "./types";

type EventCounts = Map<string, number>;

type CaptureSummary = {
	recordDownload: () => void;
	recordError: (record: ErrorRecord) => void;
	recordEventSourceMessage: () => void;
	recordRedirectHop: () => void;
	recordSavedRequestBody: (byteLength: number) => void;
	recordSavedResponseBody: (byteLength: number) => void;
	recordStorageSnapshot: (counts: StorageSnapshotCounts) => void;
	recordWebSocketFrame: () => void;
	// A record file that stopped recording, named after the writer that failed.
	recordWriterFailure: (name: string) => void;
	render: () => string;
};

const UNKNOWN_HOST = "unknown";
const MAX_ERROR_HOSTS = 20;

// Error records carry whatever URL the failing request had.
// That can be missing, relative, or a hostless scheme such as "data:".
const hostFromUrl = (url: string | undefined): string => {
	if (url === undefined) {
		return UNKNOWN_HOST;
	}

	const parsed = URL.parse(url);
	if (parsed === null || parsed.host === "") {
		return UNKNOWN_HOST;
	}

	return parsed.host;
};

// Plugin failures have no URL, so they would otherwise bury real hosts in "unknown".
const errorBucket = (record: ErrorRecord): string =>
	record.pluginId === undefined ? hostFromUrl(record.url) : `plugin:${record.pluginId}`;

const increment = (counts: EventCounts, key: string): void => {
	counts.set(key, (counts.get(key) ?? 0) + 1);
};

const totalCount = (counts: EventCounts): number =>
	[...counts.values()].reduce((total, count) => total + count, 0);

const renderHostLine = ([host, events]: [string, EventCounts]): string => {
	const byEvent = [...events.entries()]
		.sort(([leftEvent, leftCount], [rightEvent, rightCount]) =>
			leftCount === rightCount ? leftEvent.localeCompare(rightEvent) : rightCount - leftCount,
		)
		.map(([event, count]) => `${event}=${count}`)
		.join(" ");

	return `summary_errors host=${host} total=${totalCount(events)} ${byEvent}`;
};

const sortHosts = (entries: [string, EventCounts][]): [string, EventCounts][] =>
	entries.sort(([leftHost, leftEvents], [rightHost, rightEvents]) => {
		const leftTotal = totalCount(leftEvents);
		const rightTotal = totalCount(rightEvents);

		return leftTotal === rightTotal ? leftHost.localeCompare(rightHost) : rightTotal - leftTotal;
	});

const renderHostLines = (errorsByHost: Map<string, EventCounts>): string[] => {
	const hosts = sortHosts([...errorsByHost.entries()]);
	const lines = hosts.slice(0, MAX_ERROR_HOSTS).map(renderHostLine);
	const remaining = hosts.slice(MAX_ERROR_HOSTS);
	if (remaining.length === 0) {
		return lines;
	}

	const remainingErrors = remaining.reduce((total, [, events]) => total + totalCount(events), 0);
	return [...lines, `summary_errors (${remaining.length} more hosts, ${remainingErrors} errors)`];
};

// Totals of a written snapshot, for the summary line and the plugin event alike.
// Both need the same numbers, and neither may carry the snapshot contents.
const countStorageSnapshot = (snapshot: StorageSnapshot): StorageSnapshotCounts => {
	const stores = snapshot.origins.flatMap((origin) =>
		origin.databases.flatMap((database) => database.objectStores),
	);
	const items = (origin: StorageSnapshot["origins"][number]): number =>
		Object.keys(origin.localStorage ?? {}).length + Object.keys(origin.sessionStorage ?? {}).length;

	return {
		cookies: snapshot.cookies.length,
		databases: snapshot.origins.reduce((total, origin) => total + origin.databases.length, 0),
		entries: stores.reduce((total, store) => total + store.entries.length, 0),
		items: snapshot.origins.reduce((total, origin) => total + items(origin), 0),
		origins: snapshot.origins.length,
	};
};

// One tally keeps the counters together as more record kinds are captured.
// The failed writers ride along: they say which of those counts reached no file.
type RecordCounts = {
	downloads: number;
	errors: number;
	eventSourceMessages: number;
	// Names of the record files that stopped recording, empty in a healthy run.
	failedWriters: Set<string>;
	redirectHops: number;
	requestBodies: number;
	requestBytes: number;
	responseBodies: number;
	responseBytes: number;
	webSocketFrames: number;
};

// A failed writer means the run counted records that its file never received.
// The line is printed only when one failed, so a healthy run reads as before.
const renderWriterFailures = (failed: Set<string>): string[] =>
	failed.size === 0
		? []
		: [`summary_writers ${[...failed].map((name) => `${name}=failed`).join(" ")}`];

// Saved bodies first, then the records that have no body of their own.
// The snapshot line is printed only when one was taken, so a normal run is unchanged.
// The error total comes last, heading the per-host breakdown printed below it.
const renderTotals = (
	counts: RecordCounts,
	snapshot: StorageSnapshotCounts | undefined,
): string[] => [
	`summary responses=${counts.responseBodies} response_bytes=${counts.responseBytes} requests=${counts.requestBodies} request_bytes=${counts.requestBytes}`,
	`summary websocket_frames=${counts.webSocketFrames} eventsource_messages=${counts.eventSourceMessages} downloads=${counts.downloads} redirects=${counts.redirectHops}`,
	...(snapshot === undefined
		? []
		: [
				`summary snapshot_origins=${snapshot.origins} cookies=${snapshot.cookies} items=${snapshot.items} databases=${snapshot.databases} entries=${snapshot.entries}`,
			]),
	`summary errors=${counts.errors}`,
	...renderWriterFailures(counts.failedWriters),
];

const createRecordCounts = (): RecordCounts => ({
	downloads: 0,
	errors: 0,
	eventSourceMessages: 0,
	failedWriters: new Set<string>(),
	redirectHops: 0,
	requestBodies: 0,
	requestBytes: 0,
	responseBodies: 0,
	responseBytes: 0,
	webSocketFrames: 0,
});

const createCaptureSummary = (): CaptureSummary => {
	const errorsByHost = new Map<string, EventCounts>();
	// Left undefined until a snapshot is written, which only --snapshot-storage does.
	let snapshotCounts: StorageSnapshotCounts | undefined = undefined;
	const counts = createRecordCounts();

	return {
		// Every recorded download counts, canceled ones included: the record says which.
		recordDownload: (): void => {
			counts.downloads += 1;
		},
		recordError: (record: ErrorRecord): void => {
			counts.errors += 1;
			const bucket = errorBucket(record);
			const events = errorsByHost.get(bucket) ?? new Map<string, number>();
			increment(events, record.event);
			errorsByHost.set(bucket, events);
		},
		// An SSE stream never finishes, so its messages reach no response total either.
		recordEventSourceMessage: (): void => {
			counts.eventSourceMessages += 1;
		},
		// Redirect hops carry no body, so they would otherwise miss every total.
		recordRedirectHop: (): void => {
			counts.redirectHops += 1;
		},
		recordSavedRequestBody: (byteLength: number): void => {
			counts.requestBodies += 1;
			counts.requestBytes += byteLength;
		},
		recordSavedResponseBody: (byteLength: number): void => {
			counts.responseBodies += 1;
			counts.responseBytes += byteLength;
		},
		// One snapshot per run, so a repeat replaces rather than accumulates.
		recordStorageSnapshot: (snapshot: StorageSnapshotCounts): void => {
			snapshotCounts = snapshot;
		},
		recordWebSocketFrame: (): void => {
			counts.webSocketFrames += 1;
		},
		// One line per run whatever a writer failed on, so repeats do not accumulate.
		recordWriterFailure: (name: string): void => {
			counts.failedWriters.add(name);
		},
		render: (): string =>
			[...renderTotals(counts, snapshotCounts), ...renderHostLines(errorsByHost)].join("\n"),
	};
};

export { countStorageSnapshot, createCaptureSummary, hostFromUrl };
export type { CaptureSummary };
