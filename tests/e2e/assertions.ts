import { expect } from "bun:test";
import { join } from "node:path";

type CapturedApiRecord = {
	bodyFile: string;
	bodySaved?: boolean | undefined;
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

const assertRunSummary = (output: string): void => {
	expect(output).toContain("summary responses=");
	expect(output).toContain("summary websocket_frames=");
	expect(output).toContain("eventsource_messages=");
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
	assertCapturedEventSourceMessages,
	assertCapturedWebSocketFrames,
	assertNetLog,
	assertRunSummary,
	readCapturedBodies,
	readNetLog,
};
export type { CapturedApiRecord, CapturedEventSourceMessage, CapturedWebSocketFrame };
