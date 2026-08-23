import { expect } from "bun:test";
import { createHash } from "node:crypto";
import { join } from "node:path";

type CapturedApiRecord = {
	bodyFile: string;
	bodySaved?: boolean | undefined;
	rawRequestHeaders?: Record<string, string> | undefined;
	rawResponseHeaders?: Record<string, string> | undefined;
	requestBodyFile: string;
	requestBodySaved?: boolean | undefined;
	requestMethod?: string | undefined;
};

type CapturedEventSourceMessage = {
	data?: string | undefined;
	eventId?: string | undefined;
	eventName?: string | undefined;
	url?: string | undefined;
};

type CapturedWebSocketFrame = {
	direction?: string | undefined;
	payloadData?: string | undefined;
	url?: string | undefined;
};

type CapturedDownload = {
	error?: string | undefined;
	file?: string | undefined;
	guid?: string | undefined;
	sha256?: string | undefined;
	state?: string | undefined;
	suggestedFilename?: string | undefined;
	url?: string | undefined;
};

type NetLogRecord = {
	constants?: unknown;
	events?: unknown;
};

const readCapturedBodies = async (
	captureDirectory: string,
	metadata: CapturedApiRecord,
): Promise<{ requestBody: string; responseBody: string }> => ({
	requestBody: await Bun.file(join(captureDirectory, metadata.requestBodyFile)).text(),
	responseBody: await Bun.file(join(captureDirectory, metadata.bodyFile)).text(),
});

const assertCapturedApi = (
	metadata: CapturedApiRecord,
	bodies: { requestBody: string; responseBody: string },
): void => {
	expect(metadata.bodySaved).toBe(true);
	expect(metadata.requestBodySaved).toBe(true);
	expect(metadata.requestMethod).toBe("POST");
	expect(JSON.parse(bodies.responseBody)).toEqual({
		ok: true,
		posted: { hello: "from-page" },
		source: "cdp-e2e",
	});
	expect(JSON.parse(bodies.requestBody)).toEqual({ hello: "from-page" });
};

// Raw headers keep the casing they had on the wire, which varies by protocol.
const rawHeader = (headers: Record<string, string> | undefined, name: string): string =>
	Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === name)?.[1] ?? "";

// Only the ExtraInfo events carry Cookie and Set-Cookie, and only with --capture-cookies.
const assertCapturedRawHeaders = (metadata: CapturedApiRecord): void => {
	expect(rawHeader(metadata.rawRequestHeaders, "cookie")).toContain("e2e=1");
	expect(rawHeader(metadata.rawResponseHeaders, "set-cookie")).toContain("e2e-response=1");
};

const assertCapturedWebSocketFrames = (
	frames: CapturedWebSocketFrame[],
	socketUrl: string,
): void => {
	const attributed = frames.filter((frame) => frame.url === socketUrl);
	expect(attributed.map((frame) => frame.direction)).toContain("sent");
	expect(attributed.map((frame) => frame.direction)).toContain("received");
	expect(attributed.map((frame) => frame.payloadData)).toContain("hello-from-page");
	expect(attributed.map((frame) => frame.payloadData)).toContain("echo:hello-from-page");
};

// An EventSource connection does produce Network.requestWillBeSent, unlike a
// WebSocket handshake, so every message must carry the stream URL.
const assertCapturedEventSourceMessages = (
	messages: CapturedEventSourceMessage[],
	streamUrl: string,
): void => {
	const attributed = messages.filter((message) => message.url === streamUrl);
	expect(attributed.map((message) => message.data)).toEqual(['{"price":1}', '{"price":2}']);
	expect(attributed.map((message) => message.eventName)).toEqual(["price", "price"]);
	expect(attributed.map((message) => message.eventId)).toEqual(["1", "2"]);
};

// The browser names the saved file after the download GUID.
// The record is the only thing tying it back to a filename and the URL it came from.
const assertCapturedDownload = async (
	downloads: CapturedDownload[],
	options: { captureDirectory: string; contents: string; url: string },
): Promise<void> => {
	const download = downloads.find((record) => record.url === options.url);
	expect(download?.state).toBe("completed");
	expect(download?.suggestedFilename).toBe("statement.csv");
	expect(download?.error).toBeUndefined();
	expect(download?.file).toBe(join("downloads", download?.guid ?? ""));
	const saved = Bun.file(join(options.captureDirectory, download?.file ?? ""));
	await expect(saved.text()).resolves.toBe(options.contents);
	expect(download?.sha256).toBe(
		createHash("sha256")
			.update(new Uint8Array(await saved.arrayBuffer()))
			.digest("hex"),
	);
};

const assertRunSummary = (output: string): void => {
	expect(output).toContain("summary responses=");
	expect(output).toContain("summary websocket_frames=");
	expect(output).toContain("eventsource_messages=");
	expect(output).toContain("downloads=");
};

const readNetLog = async (path: string): Promise<NetLogRecord> => {
	const file = Bun.file(path);
	if (!(await file.exists())) {
		throw new Error(`NetLog file does not exist: ${path}`);
	}

	const contents = (await file.text()).trim();
	if (!contents) {
		throw new Error(`NetLog file is empty and may not have been finalized: ${path}`);
	}

	try {
		return JSON.parse(contents) as NetLogRecord;
	} catch (error) {
		throw new Error(`NetLog file contains incomplete or invalid JSON: ${path}`, {
			cause: error,
		});
	}
};

const assertNetLog = (netLog: NetLogRecord): void => {
	expect(netLog.constants).toBeDefined();
	expect(Array.isArray(netLog.events)).toBe(true);
};

export {
	assertCapturedApi,
	assertCapturedDownload,
	assertCapturedEventSourceMessages,
	assertCapturedRawHeaders,
	assertCapturedWebSocketFrames,
	assertNetLog,
	assertRunSummary,
	readCapturedBodies,
	readNetLog,
};
export type {
	CapturedApiRecord,
	CapturedDownload,
	CapturedEventSourceMessage,
	CapturedWebSocketFrame,
};
