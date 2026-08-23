import { describe, expect, it } from "bun:test";

import { createCaptureSummary, hostFromUrl } from "./summary";
import type { ErrorRecord } from "./types";

const createError = (event: string, url?: string): ErrorRecord => ({
	error: "failed",
	event,
	timestamp: "2026-07-06T12:34:56Z",
	url,
});

const errorLines = (rendered: string): string[] => rendered.split("\n").slice(3);

describe("hostFromUrl", () => {
	it("returns the host including a non-default port", () => {
		expect(hostFromUrl("https://example.test:8443/api?q=1")).toBe("example.test:8443");
	});

	it("returns unknown for missing, unparsable, and hostless URLs", () => {
		expect(hostFromUrl(undefined)).toBe("unknown");
		expect(hostFromUrl("not a url")).toBe("unknown");
		expect(hostFromUrl("data:text/plain,hello")).toBe("unknown");
	});
});

describe("createCaptureSummary", () => {
	it("reports totals for saved bodies and frames with no errors", () => {
		const summary = createCaptureSummary();
		summary.recordSavedResponseBody(11);
		summary.recordSavedResponseBody(89);
		summary.recordSavedRequestBody(17);
		summary.recordWebSocketFrame();
		summary.recordWebSocketFrame();
		summary.recordEventSourceMessage();
		summary.recordDownload();

		expect(summary.render()).toBe(
			[
				"summary responses=2 response_bytes=100 requests=1 request_bytes=17",
				"summary websocket_frames=2 eventsource_messages=1 downloads=1 redirects=0",
				"summary errors=0",
			].join("\n"),
		);
	});

	it("counts redirect hops separately from saved response bodies", () => {
		const summary = createCaptureSummary();
		summary.recordRedirectHop();
		summary.recordRedirectHop();
		summary.recordSavedResponseBody(11);

		expect(summary.render().split("\n")).toEqual([
			"summary responses=1 response_bytes=11 requests=0 request_bytes=0",
			"summary websocket_frames=0 eventsource_messages=0 downloads=0 redirects=2",
			"summary errors=0",
		]);
	});

	it("groups errors by host and event", () => {
		const summary = createCaptureSummary();
		summary.recordError(createError("Network.getResponseBody", "https://example.test/api"));
		summary.recordError(createError("Network.getResponseBody", "https://example.test/other"));
		summary.recordError(createError("Network.loadingFailed", "https://example.test/api"));
		summary.recordError(createError("Network.getRequestPostData", "https://cdn.test:8443/asset"));

		const rendered = summary.render();

		expect(rendered.split("\n")[2]).toBe("summary errors=4");
		expect(errorLines(rendered)).toEqual([
			"summary_errors host=example.test total=3 Network.getResponseBody=2 Network.loadingFailed=1",
			"summary_errors host=cdn.test:8443 total=1 Network.getRequestPostData=1",
		]);
	});

	it("falls back to an unknown host for missing or hostless URLs", () => {
		const summary = createCaptureSummary();
		summary.recordError(createError("Target.detachedFromTarget"));
		summary.recordError(createError("Network.loadingFailed", "not a url"));
		summary.recordError(createError("Network.loadingFailed", "data:text/plain,hello"));

		expect(errorLines(summary.render())).toEqual([
			"summary_errors host=unknown total=3 Network.loadingFailed=2 Target.detachedFromTarget=1",
		]);
	});

	it("buckets plugin failures by plugin id instead of unknown", () => {
		const summary = createCaptureSummary();
		summary.recordError({
			error: "boom",
			event: "Plugin.onEvent",
			pluginId: "json-api-mirror",
			timestamp: "2026-07-06T12:34:56Z",
		});
		summary.recordError({
			error: "Plugin queue overflow; dropped response.completed.",
			event: "Plugin.queueOverflow",
			pluginId: "json-api-mirror",
			timestamp: "2026-07-06T12:34:57Z",
		});

		expect(errorLines(summary.render())).toEqual([
			"summary_errors host=plugin:json-api-mirror total=2 Plugin.onEvent=1 Plugin.queueOverflow=1",
		]);
	});

	it("orders hosts by error count and breaks ties by name", () => {
		const summary = createCaptureSummary();
		summary.recordError(createError("Network.loadingFailed", "https://b.test/one"));
		summary.recordError(createError("Network.loadingFailed", "https://a.test/one"));
		summary.recordError(createError("Network.loadingFailed", "https://c.test/one"));
		summary.recordError(createError("Network.loadingFailed", "https://c.test/two"));

		expect(errorLines(summary.render())).toEqual([
			"summary_errors host=c.test total=2 Network.loadingFailed=2",
			"summary_errors host=a.test total=1 Network.loadingFailed=1",
			"summary_errors host=b.test total=1 Network.loadingFailed=1",
		]);
	});

	it("caps host lines and reports the remainder", () => {
		const summary = createCaptureSummary();
		for (let index = 0; index < 25; index += 1) {
			summary.recordError(createError("Network.loadingFailed", `https://host-${index}.test/one`));
		}
		summary.recordError(createError("Network.loadingFailed", "https://host-0.test/two"));

		const lines = errorLines(summary.render());

		expect(lines).toHaveLength(21);
		expect(lines[0]).toBe("summary_errors host=host-0.test total=2 Network.loadingFailed=2");
		expect(lines.at(-1)).toBe("summary_errors (5 more hosts, 5 errors)");
	});
});
