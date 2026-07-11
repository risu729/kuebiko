import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import type { Protocol } from "devtools-protocol";

import { TOOL_NAME, TOOL_VERSION } from "./constants";
import { createBodyFilename, relativeBodyPath, timestampForFile } from "./sanitize";
import type {
	BodySaveResult,
	CompletedResponseMetadata,
	ErrorRecord,
	LoggerStorage,
	RequestState,
	RequestBodySaveResult,
	RunInfo,
	WebSocketFrameRecord,
} from "./types";

type NdjsonWriter = {
	append: (record: unknown) => Promise<void>;
	close: () => Promise<void>;
};

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

const errorMessage = (error: unknown): string =>
	error instanceof Error ? error.message : String(error);

const createNdjsonWriter = (path: string): NdjsonWriter => {
	const stream = createWriteStream(path, { flags: "a" });
	let pending = Promise.resolve();

	const writeLine = (line: string): Promise<void> =>
		new Promise((resolve, reject) => {
			stream.write(line, (error) => {
				if (error) {
					reject(error);
					return;
				}
				resolve();
			});
		});

	return {
		append: async (record) => {
			pending = pending.then(() => writeLine(`${JSON.stringify(record)}\n`));
			await pending;
		},
		close: async () => {
			await pending.catch(() => undefined);
			await new Promise<void>((resolve, reject) => {
				stream.end((error?: Error | null) => {
					if (error) {
						reject(error);
						return;
					}
					resolve();
				});
			});
		},
	};
};

const bodyToBytes = (body: Protocol.Network.GetResponseBodyResponse): Uint8Array => {
	if (body.base64Encoded) {
		return Buffer.from(body.body, "base64");
	}

	return Buffer.from(body.body, "utf8");
};

const textToBytes = (text: string): Uint8Array => Buffer.from(text, "utf8");

const createRunInfo = (
	runDirectory: string,
	cdpEndpoint: string,
	runTimestamp: string,
): RunInfo => ({
	cdpEndpoint,
	createdAt: runTimestamp,
	nodePlatform: process.platform,
	pid: process.pid,
	runDirectory,
	tool: TOOL_NAME,
	version: TOOL_VERSION,
});

const createStorage = async (
	runDirectory: string,
	cdpEndpoint: string,
	runTimestamp = new Date().toISOString(),
): Promise<LoggerStorage> => {
	const bodiesDirectory = join(runDirectory, "bodies");
	const requestsDirectory = join(runDirectory, "requests");
	await mkdir(bodiesDirectory, { recursive: true });
	await mkdir(requestsDirectory, { recursive: true });
	await Bun.write(
		join(runDirectory, "run.json"),
		`${JSON.stringify(createRunInfo(runDirectory, cdpEndpoint, runTimestamp), null, "\t")}\n`,
	);

	const metadata = createNdjsonWriter(join(runDirectory, "metadata.ndjson"));
	const errors = createNdjsonWriter(join(runDirectory, "errors.ndjson"));
	const websocket = createNdjsonWriter(join(runDirectory, "websocket.ndjson"));
	let bodyCounter = 0;
	let requestCounter = 0;

	const saveBytes = async (
		directory: string,
		timestamp: string,
		bytes: Uint8Array,
		counter: number,
		contentType?: string,
	): Promise<{ filename: string; sha256: string }> => {
		const digest = sha256(bytes);
		const filename = createBodyFilename(timestamp, digest, counter, contentType);
		await Bun.write(join(directory, filename), bytes);

		return { filename, sha256: digest };
	};

	const recordRequestBody = async (
		state: RequestState,
		postData: string,
	): Promise<RequestBodySaveResult> => {
		const source = state.requestPostData === postData ? "requestWillBeSent" : "getRequestPostData";

		try {
			const bytes = textToBytes(postData);
			requestCounter += 1;
			const { filename, sha256: bodySha256 } = await saveBytes(
				requestsDirectory,
				timestampForFile(),
				bytes,
				requestCounter,
				state.requestContentType,
			);

			return {
				bodyFile: join("requests", filename),
				bodyLength: bytes.byteLength,
				bodySaved: true,
				bodySha256,
				source,
			};
		} catch (error) {
			return {
				bodySaved: false,
				error: errorMessage(error),
				source,
			};
		}
	};

	const recordBody = async (
		state: RequestState,
		body: Protocol.Network.GetResponseBodyResponse,
	): Promise<BodySaveResult & { base64Encoded: boolean }> => {
		try {
			const bytes = bodyToBytes(body);
			bodyCounter += 1;
			const { filename, sha256: bodySha256 } = await saveBytes(
				bodiesDirectory,
				timestampForFile(),
				bytes,
				bodyCounter,
				state.response?.mimeType,
			);

			return {
				base64Encoded: body.base64Encoded,
				bodyFile: relativeBodyPath(filename),
				bodyLength: bytes.byteLength,
				bodySaved: true,
				bodySha256,
			};
		} catch (error) {
			return {
				base64Encoded: body.base64Encoded,
				bodySaved: false,
				error: errorMessage(error),
			};
		}
	};

	return {
		close: async () => {
			await Promise.all([metadata.close(), errors.close(), websocket.close()]);
		},
		recordRequestBody,
		recordBody,
		recordCompletedResponse: async (record: CompletedResponseMetadata) => {
			await metadata.append(record);
		},
		recordError: async (record: ErrorRecord) => {
			await errors.append(record);
		},
		recordWebSocketFrame: async (frame: WebSocketFrameRecord) => {
			await websocket.append(frame);
		},
		runDirectory,
		runTimestamp,
	};
};

export { bodyToBytes, createNdjsonWriter, createStorage, sha256 };
