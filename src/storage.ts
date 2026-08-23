import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import type { Protocol } from "devtools-protocol";

import { DOWNLOADS_DIRECTORY, TOOL_NAME, TOOL_VERSION } from "./constants";
import { createBodyFilename, relativeBodyPath, timestampForFile } from "./sanitize";
import { createCaptureSummary } from "./summary";
import type { CaptureSummary } from "./summary";
import type {
	BodySaveResult,
	CompletedResponseMetadata,
	DownloadRecord,
	ErrorRecord,
	EventSourceMessageRecord,
	LoggerStorage,
	RequestState,
	RequestBodySaveResult,
	WebSocketFrameRecord,
} from "./types";

type NdjsonWriter = {
	append: (record: unknown) => Promise<void>;
	close: () => Promise<void>;
};

// Only storage writes run.json, so its shape stays with the writer.
type RunInfo = {
	// Records whether the run may hold plaintext session cookies from --capture-cookies.
	captureCookies: boolean;
	// Records whether the browser was told to save downloads into this run directory.
	captureDownloads: boolean;
	cdpEndpoint: string;
	createdAt: string;
	labels?: string[] | undefined;
	nodePlatform: NodeJS.Platform;
	note?: string | undefined;
	pid: number;
	runDirectory: string;
	// Records whether bodies came from Network.streamResourceContent.
	// That also explains why every streamed body line reports base64Encoded true.
	streamBodies: boolean;
	tool: string;
	version: string;
};

// How the run was started: the owner's free-form description plus capture settings.
type RunAnnotations = Pick<RunInfo, "labels" | "note"> & {
	captureCookies?: boolean | undefined;
	captureDownloads?: boolean | undefined;
	streamBodies?: boolean | undefined;
};

// Only the run owner reads the summary, so it stays off the LoggerStorage contract.
type RunStorage = LoggerStorage & {
	summary: CaptureSummary;
};

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

// A download can be far larger than a response body, so it is hashed in chunks.
// Reading it whole the way a saved body is read would not bound the memory it takes.
const sha256File = async (path: string): Promise<string> => {
	const hash = createHash("sha256");
	for await (const chunk of Bun.file(path).stream()) {
		hash.update(chunk);
	}

	return hash.digest("hex");
};

const errorMessage = (error: unknown): string =>
	error instanceof Error ? error.message : String(error);

const createNdjsonWriter = (path: string): NdjsonWriter => {
	const stream = createWriteStream(path, { flags: "a" });
	// A failing write both rejects the write callback and emits "error".
	// The callback is what append() and close() already report through.
	// The event only needs a listener so it cannot take the capture down.
	stream.on("error", () => undefined);
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
	annotations: RunAnnotations,
): RunInfo => ({
	// Always present, so a capture directory self-describes its cookie sensitivity.
	captureCookies: annotations.captureCookies ?? false,
	// Always present too, so the directory says whether browser behavior was changed.
	captureDownloads: annotations.captureDownloads ?? false,
	cdpEndpoint,
	createdAt: runTimestamp,
	// JSON.stringify drops undefined, so unlabelled runs keep the original run.json shape.
	labels: annotations.labels?.length ? annotations.labels : undefined,
	nodePlatform: process.platform,
	note: annotations.note?.trim() ? annotations.note : undefined,
	pid: process.pid,
	runDirectory,
	// Always present too, so the directory says how its bodies were retrieved.
	streamBodies: annotations.streamBodies ?? false,
	tool: TOOL_NAME,
	version: TOOL_VERSION,
});

const createStorage = async (
	runDirectory: string,
	cdpEndpoint: string,
	annotations: RunAnnotations = {},
	runTimestamp = new Date().toISOString(),
): Promise<RunStorage> => {
	const bodiesDirectory = join(runDirectory, "bodies");
	const requestsDirectory = join(runDirectory, "requests");
	await mkdir(bodiesDirectory, { recursive: true });
	await mkdir(requestsDirectory, { recursive: true });
	// Only the browser writes here, so the directory exists only when downloads are captured.
	if (annotations.captureDownloads) {
		await mkdir(join(runDirectory, DOWNLOADS_DIRECTORY), { recursive: true });
	}
	await Bun.write(
		join(runDirectory, "run.json"),
		`${JSON.stringify(createRunInfo(runDirectory, cdpEndpoint, runTimestamp, annotations), null, "\t")}\n`,
	);

	const metadata = createNdjsonWriter(join(runDirectory, "metadata.ndjson"));
	const errors = createNdjsonWriter(join(runDirectory, "errors.ndjson"));
	const websocket = createNdjsonWriter(join(runDirectory, "websocket.ndjson"));
	const eventSource = createNdjsonWriter(join(runDirectory, "eventsource.ndjson"));
	const downloads = createNdjsonWriter(join(runDirectory, "downloads.ndjson"));
	const summary = createCaptureSummary();
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
			summary.recordSavedRequestBody(bytes.byteLength);

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

	// A streamed body is assembled as bytes already.
	// Saving them here avoids re-encoding to base64 only to decode it again.
	const recordBodyBytes = async (
		state: RequestState,
		bytes: Uint8Array,
	): Promise<BodySaveResult> => {
		try {
			bodyCounter += 1;
			const { filename, sha256: bodySha256 } = await saveBytes(
				bodiesDirectory,
				timestampForFile(),
				bytes,
				bodyCounter,
				state.response?.mimeType,
			);
			summary.recordSavedResponseBody(bytes.byteLength);

			return {
				bodyFile: relativeBodyPath(filename),
				bodyLength: bytes.byteLength,
				bodySaved: true,
				bodySha256,
			};
		} catch (error) {
			return {
				bodySaved: false,
				error: errorMessage(error),
			};
		}
	};

	// Under Browser.setDownloadBehavior "allowAndName" the browser names the file by GUID.
	// The file keeps that name: renaming it would race the browser's own writes.
	// This record is what maps the GUID back to the suggested filename instead.
	const hashDownload = async (
		guid: string,
	): Promise<Pick<DownloadRecord, "error" | "file" | "sha256">> => {
		const relativePath = join(DOWNLOADS_DIRECTORY, guid);
		try {
			return { file: relativePath, sha256: await sha256File(join(runDirectory, relativePath)) };
		} catch (error) {
			// A completed download whose file is gone is a loss, not a reason to stop capturing.
			return { error: errorMessage(error) };
		}
	};

	// How CDP delivered the body is recorded verbatim, saved or not.
	const recordBody = async (
		state: RequestState,
		body: Protocol.Network.GetResponseBodyResponse,
	): Promise<BodySaveResult & { base64Encoded: boolean }> => ({
		...(await recordBodyBytes(state, bodyToBytes(body))),
		base64Encoded: body.base64Encoded,
	});

	return {
		close: async () => {
			// Shutdown runs from a finally block, where a rejection becomes an unhandled one.
			// Settle them all so a writer that already failed cannot stop the others closing.
			await Promise.allSettled([
				metadata.close(),
				errors.close(),
				websocket.close(),
				eventSource.close(),
				downloads.close(),
			]);
		},
		recordRequestBody,
		recordBody,
		recordBodyBytes,
		recordCompletedResponse: async (record: CompletedResponseMetadata) => {
			if (record.redirect === true) {
				summary.recordRedirectHop();
			}
			await metadata.append(record);
		},
		// A canceled download is appended as it stands, so the loss stays in the record file.
		recordDownload: async (download: DownloadRecord) => {
			const record: DownloadRecord =
				download.state === "completed"
					? { ...download, ...(await hashDownload(download.guid)) }
					: download;
			summary.recordDownload();
			await downloads.append(record);

			return record;
		},
		recordError: async (record: ErrorRecord) => {
			// Count before the write so a failing errors.ndjson still shows up in the summary.
			summary.recordError(record);
			await errors.append(record);
		},
		recordEventSourceMessage: async (message: EventSourceMessageRecord) => {
			summary.recordEventSourceMessage();
			await eventSource.append(message);
		},
		recordWebSocketFrame: async (frame: WebSocketFrameRecord) => {
			summary.recordWebSocketFrame();
			await websocket.append(frame);
		},
		runDirectory,
		runTimestamp,
		summary,
	};
};

export { bodyToBytes, createNdjsonWriter, createStorage, sha256 };
export type { RunAnnotations, RunInfo };
