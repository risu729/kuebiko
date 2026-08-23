import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bodyToBytes, createStorage, sha256 } from "./storage";
import type { RunInfo } from "./storage";
import type { RequestState } from "./types";

describe("bodyToBytes", () => {
	it("decodes base64 responses and UTF-8 text responses", () => {
		expect(Buffer.from(bodyToBytes({ base64Encoded: true, body: "aGVsbG8=" })).toString()).toBe(
			"hello",
		);
		expect(Buffer.from(bodyToBytes({ base64Encoded: false, body: "hello" })).toString()).toBe(
			"hello",
		);
	});
});

describe("createStorage", () => {
	it("writes bodies and metadata records", async () => {
		const dir = await mkdtemp(join(tmpdir(), "kuebiko-"));
		const storage = await createStorage(dir, "http://127.0.0.1:9222", {}, "2026-07-06T12:34:56Z");
		const state: RequestState = {
			requestId: "request-1",
			response: {
				charset: "",
				connectionId: 1,
				connectionReused: false,
				encodedDataLength: 11,
				headers: {},
				mimeType: "application/json",
				securityState: "secure",
				status: 200,
				statusText: "OK",
				url: "https://example.test/api",
			},
			session: { sessionId: "session-1", targetId: "target-1", targetType: "page" },
		};

		const result = await storage.recordBody(state, {
			base64Encoded: false,
			body: '{"ok":true}',
		});
		await storage.recordCompletedResponse({
			bodyFile: result.bodyFile,
			bodyLength: result.bodyLength,
			bodySaved: result.bodySaved,
			bodySha256: result.bodySha256,
			requestId: "request-1",
			runTimestamp: storage.runTimestamp,
			sessionId: "session-1",
		});
		await storage.close();

		expect(result).toMatchObject({
			base64Encoded: false,
			bodyLength: 11,
			bodySaved: true,
			bodySha256: sha256(Buffer.from('{"ok":true}')),
		});
		expect(result.bodyFile).toMatch(/^bodies[/\\].+\.json$/u);
		const metadata = await Bun.file(join(dir, "metadata.ndjson")).text();
		expect(metadata.trim()).toContain('"bodySaved":true');
	});

	// A streamed body is handed over as bytes, so nothing round-trips through base64.
	it("writes assembled bytes as a response body", async () => {
		const dir = await mkdtemp(join(tmpdir(), "kuebiko-"));
		const storage = await createStorage(dir, "http://127.0.0.1:9222", {}, "2026-07-06T12:34:56Z");
		const state: RequestState = {
			requestId: "request-1",
			session: { sessionId: "session-1" },
		};
		const bytes = Buffer.from([0, 1, 2, 250]);

		const result = await storage.recordBodyBytes(state, bytes);
		await storage.close();

		expect(result).toMatchObject({
			bodyLength: 4,
			bodySaved: true,
			bodySha256: sha256(bytes),
		});
		await expect(Bun.file(join(dir, result.bodyFile ?? "")).bytes()).resolves.toEqual(
			new Uint8Array(bytes),
		);
		expect(storage.summary.render()).toContain("responses=1 response_bytes=4");
	});

	it("writes request bodies separately from response bodies", async () => {
		const dir = await mkdtemp(join(tmpdir(), "kuebiko-"));
		const storage = await createStorage(dir, "http://127.0.0.1:9222", {}, "2026-07-06T12:34:56Z");
		const state: RequestState = {
			requestContentType: "application/json",
			requestHeaders: { "content-type": "application/json" },
			requestId: "request-1",
			requestPostData: '{"hello":"world"}',
			session: { sessionId: "session-1", targetId: "target-1", targetType: "page" },
		};

		const result = await storage.recordRequestBody(state, '{"hello":"world"}');
		await storage.close();

		expect(result).toMatchObject({
			bodyLength: 17,
			bodySaved: true,
			bodySha256: sha256(Buffer.from('{"hello":"world"}')),
			source: "requestWillBeSent",
		});
		expect(result.bodyFile).toMatch(/^requests[/\\].+\.json$/u);
		await expect(Bun.file(join(dir, result.bodyFile ?? "")).text()).resolves.toBe(
			'{"hello":"world"}',
		);
		await expect(readdir(join(dir, "requests"))).resolves.toHaveLength(1);
	});

	// The browser names a download after its GUID, so only the record maps it back.
	it("hashes a completed download and records where it was saved", async () => {
		const dir = await mkdtemp(join(tmpdir(), "kuebiko-"));
		const storage = await createStorage(
			dir,
			"http://127.0.0.1:9222",
			{ captureDownloads: true },
			"2026-07-06T12:34:56Z",
		);
		const bytes = Buffer.from("%PDF-1.7 statement");
		await Bun.write(join(dir, "downloads", "download-1"), bytes);

		const record = await storage.recordDownload({
			guid: "download-1",
			receivedBytes: bytes.byteLength,
			state: "completed",
			suggestedFilename: "statement.pdf",
			timestamp: "2026-07-06T12:34:57Z",
			totalBytes: bytes.byteLength,
			url: "https://bank.test/statements/2026-07.pdf",
		});
		await storage.close();

		expect(record).toMatchObject({
			file: join("downloads", "download-1"),
			sha256: sha256(bytes),
			state: "completed",
			suggestedFilename: "statement.pdf",
		});
		const downloads = await Bun.file(join(dir, "downloads.ndjson")).text();
		expect(downloads.trim()).toContain(sha256(bytes));
		expect(storage.summary.render()).toContain("downloads=1");
	});

	it("records a canceled download and a download whose file is gone as losses", async () => {
		const dir = await mkdtemp(join(tmpdir(), "kuebiko-"));
		const storage = await createStorage(
			dir,
			"http://127.0.0.1:9222",
			{ captureDownloads: true },
			"2026-07-06T12:34:56Z",
		);

		const canceled = await storage.recordDownload({
			guid: "download-1",
			state: "canceled",
			timestamp: "2026-07-06T12:34:57Z",
		});
		// Nothing was ever written under this GUID, which must not take the capture down.
		const missing = await storage.recordDownload({
			guid: "download-2",
			state: "completed",
			timestamp: "2026-07-06T12:34:58Z",
		});
		await storage.close();

		expect(canceled.error).toBeUndefined();
		expect(canceled.file).toBeUndefined();
		expect(missing.file).toBeUndefined();
		expect(missing.sha256).toBeUndefined();
		expect(missing.error).toBeDefined();
		// Both are still recorded, so neither loss is silent.
		expect(storage.summary.render()).toContain("downloads=2");
	});

	it("creates the download directory only when downloads are captured", async () => {
		const withFlag = await mkdtemp(join(tmpdir(), "kuebiko-"));
		const withoutFlag = await mkdtemp(join(tmpdir(), "kuebiko-"));
		await createStorage(
			withFlag,
			"http://127.0.0.1:9222",
			{ captureDownloads: true },
			"2026-07-06T12:34:56Z",
		);
		await createStorage(withoutFlag, "http://127.0.0.1:9222", {}, "2026-07-06T12:34:56Z");

		await expect(readdir(join(withFlag, "downloads"))).resolves.toEqual([]);
		await expect(readdir(join(withoutFlag, "downloads"))).rejects.toThrow();
	});

	it("tracks saved bodies and errors in the run summary", async () => {
		const dir = await mkdtemp(join(tmpdir(), "kuebiko-"));
		const storage = await createStorage(dir, "http://127.0.0.1:9222", {}, "2026-07-06T12:34:56Z");
		const state: RequestState = {
			requestId: "request-1",
			session: { sessionId: "session-1" },
		};

		await storage.recordBody(state, { base64Encoded: false, body: '{"ok":true}' });
		await storage.recordRequestBody(state, "hello");
		await storage.recordWebSocketFrame({
			direction: "received",
			opcode: 1,
			payloadData: "ping",
			requestId: "request-2",
			sessionId: "session-1",
			timestamp: "2026-07-06T12:34:57Z",
		});
		await storage.recordEventSourceMessage({
			data: '{"price":1}',
			eventId: "1",
			eventName: "price",
			requestId: "request-3",
			sessionId: "session-1",
			timestamp: "2026-07-06T12:34:57Z",
			url: "https://stream.example.test/prices",
		});
		await storage.recordError({
			error: "No data found for resource with given identifier",
			event: "Network.getResponseBody",
			timestamp: "2026-07-06T12:34:57Z",
			url: "https://example.test/api",
		});
		await storage.close();

		expect(storage.summary.render().split("\n")).toEqual([
			"summary responses=1 response_bytes=11 requests=1 request_bytes=5",
			"summary websocket_frames=1 eventsource_messages=1 downloads=0 redirects=0",
			"summary errors=1",
			"summary_errors host=example.test total=1 Network.getResponseBody=1",
		]);
	});

	it("counts redirect hops in the run summary without counting them as bodies", async () => {
		const dir = await mkdtemp(join(tmpdir(), "kuebiko-"));
		const storage = await createStorage(dir, "http://127.0.0.1:9222", {}, "2026-07-06T12:34:56Z");

		await storage.recordCompletedResponse({
			bodySaved: false,
			redirect: true,
			redirectIndex: 0,
			requestId: "request-1",
			runTimestamp: "2026-07-06T12:34:56Z",
			sessionId: "session-1",
			status: 302,
		});
		await storage.recordCompletedResponse({
			bodySaved: false,
			redirectIndex: 1,
			requestId: "request-1",
			runTimestamp: "2026-07-06T12:34:56Z",
			sessionId: "session-1",
			status: 200,
		});
		await storage.close();

		expect(storage.summary.render().split("\n")).toEqual([
			"summary responses=0 response_bytes=0 requests=0 request_bytes=0",
			"summary websocket_frames=0 eventsource_messages=0 downloads=0 redirects=1",
			"summary errors=0",
		]);
	});

	it("keeps unsaved bodies out of the summary totals", async () => {
		const dir = await mkdtemp(join(tmpdir(), "kuebiko-"));
		const storage = await createStorage(dir, "http://127.0.0.1:9222", {}, "2026-07-06T12:34:56Z");
		const state: RequestState = {
			requestId: "request-1",
			session: { sessionId: "session-1" },
		};
		// A file where the bodies directory belongs makes every body write fail.
		await rm(join(dir, "bodies"), { recursive: true });
		await Bun.write(join(dir, "bodies"), "not a directory");

		const result = await storage.recordBody(state, { base64Encoded: false, body: '{"ok":true}' });
		await storage.close();

		expect(result.bodySaved).toBe(false);
		expect(storage.summary.render()).toContain("responses=0 response_bytes=0");
	});

	it("counts errors even when the error log write fails", async () => {
		const dir = await mkdtemp(join(tmpdir(), "kuebiko-"));
		await mkdir(join(dir, "errors.ndjson"));
		const storage = await createStorage(dir, "http://127.0.0.1:9222", {}, "2026-07-06T12:34:56Z");

		await expect(
			storage.recordError({
				error: "Target detached before all active requests completed.",
				event: "Target.detachedFromTarget",
				timestamp: "2026-07-06T12:34:57Z",
				url: "https://example.test/api",
			}),
		).rejects.toThrow();
		await storage.close();

		expect(storage.summary.render()).toContain(
			"summary_errors host=example.test total=1 Target.detachedFromTarget=1",
		);
	});

	// Without a listener on the writer, a failing write emits an unhandled "error".
	// That terminates the process, so reaching the end of this test is the assertion.
	it("reports write failures to the caller instead of terminating the process", async () => {
		const dir = await mkdtemp(join(tmpdir(), "kuebiko-"));
		await mkdir(join(dir, "metadata.ndjson"));
		const storage = await createStorage(dir, "http://127.0.0.1:9222", {}, "2026-07-06T12:34:56Z");

		await expect(
			storage.recordCompletedResponse({
				bodySaved: false,
				requestId: "request-1",
				runTimestamp: "2026-07-06T12:34:56Z",
				sessionId: "session-1",
			}),
		).rejects.toThrow();
		await expect(storage.close()).resolves.toBeUndefined();
	});

	it("writes labels and a note into run.json", async () => {
		const dir = await mkdtemp(join(tmpdir(), "kuebiko-"));
		const storage = await createStorage(
			dir,
			"http://127.0.0.1:9222",
			{
				captureCookies: true,
				captureDownloads: true,
				labels: ["account-a", "billing"],
				note: "manual sweep",
				streamBodies: true,
			},
			"2026-07-06T12:34:56Z",
		);
		await storage.close();

		const runInfo = (await Bun.file(join(dir, "run.json")).json()) as RunInfo;

		expect(runInfo.labels).toEqual(["account-a", "billing"]);
		expect(runInfo.note).toBe("manual sweep");
		expect(runInfo.captureCookies).toBe(true);
		expect(runInfo.streamBodies).toBe(true);
		expect(runInfo.captureDownloads).toBe(true);
		expect(runInfo.createdAt).toBe("2026-07-06T12:34:56Z");
	});

	it("omits labels and note but always records the capture flags in run.json", async () => {
		for (const annotations of [{}, { labels: [], note: "  " }]) {
			const dir = await mkdtemp(join(tmpdir(), "kuebiko-"));
			const storage = await createStorage(
				dir,
				"http://127.0.0.1:9222",
				annotations,
				"2026-07-06T12:34:56Z",
			);
			await storage.close();

			const runInfo = (await Bun.file(join(dir, "run.json")).json()) as Record<string, unknown>;

			expect(Object.hasOwn(runInfo, "labels")).toBe(false);
			expect(Object.hasOwn(runInfo, "note")).toBe(false);
			// Plain booleans, so they stay in run.json even when the flags are off.
			expect(runInfo["captureCookies"]).toBe(false);
			expect(runInfo["captureDownloads"]).toBe(false);
			expect(runInfo["streamBodies"]).toBe(false);
		}
	});
});
