import { describe, expect, it } from "bun:test";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bodyToBytes, createStorage, sha256 } from "./storage";
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
		const storage = await createStorage(dir, "http://127.0.0.1:9222", "2026-07-06T12:34:56Z");
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

	it("writes request bodies separately from response bodies", async () => {
		const dir = await mkdtemp(join(tmpdir(), "kuebiko-"));
		const storage = await createStorage(dir, "http://127.0.0.1:9222", "2026-07-06T12:34:56Z");
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
});
