import type { ErrorRecord } from "./types";

type EventCounts = Map<string, number>;

type CaptureSummary = {
	recordError: (record: ErrorRecord) => void;
	recordSavedRequestBody: (byteLength: number) => void;
	recordSavedResponseBody: (byteLength: number) => void;
	recordWebSocketFrame: () => void;
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

const createCaptureSummary = (): CaptureSummary => {
	const errorsByHost = new Map<string, EventCounts>();
	let errorCount = 0;
	let frameCount = 0;
	let requestBodies = 0;
	let requestBytes = 0;
	let responseBodies = 0;
	let responseBytes = 0;

	const renderTotals = (): string[] => [
		`summary responses=${responseBodies} response_bytes=${responseBytes} requests=${requestBodies} request_bytes=${requestBytes}`,
		`summary websocket_frames=${frameCount} errors=${errorCount}`,
	];

	return {
		recordError: (record: ErrorRecord): void => {
			errorCount += 1;
			const bucket = errorBucket(record);
			const events = errorsByHost.get(bucket) ?? new Map<string, number>();
			increment(events, record.event);
			errorsByHost.set(bucket, events);
		},
		recordSavedRequestBody: (byteLength: number): void => {
			requestBodies += 1;
			requestBytes += byteLength;
		},
		recordSavedResponseBody: (byteLength: number): void => {
			responseBodies += 1;
			responseBytes += byteLength;
		},
		recordWebSocketFrame: (): void => {
			frameCount += 1;
		},
		render: (): string => [...renderTotals(), ...renderHostLines(errorsByHost)].join("\n"),
	};
};

export { createCaptureSummary, hostFromUrl };
export type { CaptureSummary };
