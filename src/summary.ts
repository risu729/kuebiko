import type { CaptureSummary, ErrorRecord } from "./types";

type EventCounts = Map<string, number>;

const UNKNOWN_HOST = "unknown";

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

const createCaptureSummary = (): CaptureSummary => {
	const errorsByHost = new Map<string, EventCounts>();
	let errorCount = 0;
	let requestBodies = 0;
	let requestBytes = 0;
	let responseBodies = 0;
	let responseBytes = 0;

	const renderTotals = (): string =>
		`summary responses=${responseBodies} response_bytes=${responseBytes} requests=${requestBodies} request_bytes=${requestBytes} errors=${errorCount}`;

	return {
		recordError: (record: ErrorRecord): void => {
			errorCount += 1;
			const host = hostFromUrl(record.url);
			const events = errorsByHost.get(host) ?? new Map<string, number>();
			increment(events, record.event);
			errorsByHost.set(host, events);
		},
		recordSavedRequestBody: (byteLength: number): void => {
			requestBodies += 1;
			requestBytes += byteLength;
		},
		recordSavedResponseBody: (byteLength: number): void => {
			responseBodies += 1;
			responseBytes += byteLength;
		},
		render: (): string =>
			[renderTotals(), ...sortHosts([...errorsByHost.entries()]).map(renderHostLine)].join("\n"),
	};
};

export { createCaptureSummary, hostFromUrl };
