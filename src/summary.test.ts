import { describe, expect, it } from "bun:test";

import { createCaptureSummary, hostFromUrl } from "./summary";
import type { ErrorRecord } from "./types";

const createError = (event: string, url?: string): ErrorRecord => ({
	error: "failed",
	event,
	timestamp: "2026-07-06T12:34:56Z",
	url,
});

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
	it("reports totals for saved bodies with no errors", () => {
		const summary = createCaptureSummary();
		summary.recordSavedResponseBody(11);
		summary.recordSavedResponseBody(89);
		summary.recordSavedRequestBody(17);

		expect(summary.render()).toBe(
			"summary responses=2 response_bytes=100 requests=1 request_bytes=17 errors=0",
		);
	});

	it("groups errors by host and event", () => {
		const summary = createCaptureSummary();
		summary.recordError(createError("Network.getResponseBody", "https://example.test/api"));
		summary.recordError(createError("Network.getResponseBody", "https://example.test/other"));
		summary.recordError(createError("Network.loadingFailed", "https://example.test/api"));
		summary.recordError(createError("Network.getRequestPostData", "https://cdn.test:8443/asset"));

		const lines = summary.render().split("\n");

		expect(lines[0]).toContain("errors=4");
		expect(lines.slice(1)).toEqual([
			"summary_errors host=example.test total=3 Network.getResponseBody=2 Network.loadingFailed=1",
			"summary_errors host=cdn.test:8443 total=1 Network.getRequestPostData=1",
		]);
	});

	it("falls back to an unknown host for missing or hostless URLs", () => {
		const summary = createCaptureSummary();
		summary.recordError(createError("Target.detachedFromTarget"));
		summary.recordError(createError("Network.loadingFailed", "not a url"));
		summary.recordError(createError("Network.loadingFailed", "data:text/plain,hello"));

		expect(summary.render().split("\n").slice(1)).toEqual([
			"summary_errors host=unknown total=3 Network.loadingFailed=2 Target.detachedFromTarget=1",
		]);
	});

	it("orders hosts by error count and breaks ties by name", () => {
		const summary = createCaptureSummary();
		summary.recordError(createError("Network.loadingFailed", "https://b.test/one"));
		summary.recordError(createError("Network.loadingFailed", "https://a.test/one"));
		summary.recordError(createError("Network.loadingFailed", "https://c.test/one"));
		summary.recordError(createError("Network.loadingFailed", "https://c.test/two"));

		expect(summary.render().split("\n").slice(1)).toEqual([
			"summary_errors host=c.test total=2 Network.loadingFailed=2",
			"summary_errors host=a.test total=1 Network.loadingFailed=1",
			"summary_errors host=b.test total=1 Network.loadingFailed=1",
		]);
	});
});
