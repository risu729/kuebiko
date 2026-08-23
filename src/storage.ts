import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import type { Protocol } from "devtools-protocol";

import { DOWNLOADS_DIRECTORY, STORAGE_SNAPSHOT_FILE, TOOL_NAME, TOOL_VERSION } from "./constants";
import { createBodyFilename, relativeBodyPath, timestampForFile } from "./sanitize";
import { countStorageSnapshot, createCaptureSummary } from "./summary";
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
	StorageSnapshot,
	WebSocketFrameRecord,
} from "./types";

// What a writer has to say about itself once the run is over.
// A file that lost one line and kept recording is not a file that stopped.
// Reporting both the same way told the run its capture had ended when it had not.
type WriterFailure = {
	// The first failure this writer hit, kept so a loss stays visible after the run.
	message: string;
	// True when the writer's last write never reached the file, so it records nothing more.
	stopped: boolean;
};

type NdjsonWriter = {
	append: (record: unknown) => Promise<void>;
	close: () => Promise<void>;
	failure: () => WriterFailure | undefined;
};

// Only storage writes run.json, so its shape stays with the writer.
type RunInfo = {
	// Records whether the run may hold plaintext session cookies from --capture-cookies.
	captureCookies: boolean;
	// Records whether the browser was told to save downloads into this run directory.
	captureDownloads: boolean;
	cdpEndpoint: string;
	createdAt: string;
	// The --exclude source, so a directory with nothing from a host says which happened.
	// It says whether the site never asked for it or the filter dropped it.
	// Same for --include below.
	exclude?: string | undefined;
	include?: string | undefined;
	labels?: string[] | undefined;
	// The cap above which a body was never retrieved, so a missing body is explained.
	maxBodyBytes?: number | undefined;
	// Records whether a NetLog was written next to the capture, which needs launch mode.
	netlog: boolean;
	nodePlatform: NodeJS.Platform;
	note?: string | undefined;
	pid: number;
	runDirectory: string;
	// Records whether the run may hold a live session in storage-snapshot.json.
	snapshotStorage: boolean;
	// Records whether bodies came from Network.streamResourceContent.
	// That also explains why every streamed body line reports base64Encoded true.
	streamBodies: boolean;
	tool: string;
	version: string;
};

// How the run was started: the owner's free-form description plus capture settings.
type RunAnnotations = Pick<RunInfo, "exclude" | "include" | "labels" | "maxBodyBytes" | "note"> & {
	captureCookies?: boolean | undefined;
	captureDownloads?: boolean | undefined;
	netlog?: boolean | undefined;
	snapshotStorage?: boolean | undefined;
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

// Chromium identifies a download by a UUID, which is all this path segment may be.
const DOWNLOAD_GUID_PATTERN = /^[0-9A-Fa-f-]{36}$/u;

const errorMessage = (error: unknown): string =>
	error instanceof Error ? error.message : String(error);

const createNdjsonWriter = (path: string): NdjsonWriter => {
	// A failing write both rejects the write callback and emits "error".
	// The callback is what append() and close() already report through.
	// The event only needs a listener so it cannot take the capture down.
	const open = (): ReturnType<typeof createWriteStream> => {
		// Append mode is what lets a reopened stream keep adding to the same file.
		const opened = createWriteStream(path, { flags: "a" });
		opened.on("error", () => undefined);
		return opened;
	};
	let stream = open();
	// Never rejects: a failed append must not become the error every later one reports.
	let pending = Promise.resolve();
	let failure: string | undefined = undefined;
	// Tracks the last write rather than any write, so a recovered file is not called dead.
	let stopped = false;
	// Set by close(), which is what keeps a late append from reopening a finished file.
	let closed = false;

	const writeLine = (line: string): Promise<void> => {
		// A record appended after close() would land in a file the summary already reported.
		// Reopening for it is invisible loss, so a closed writer refuses the record instead.
		// The refusal is a lost record, not a dead file: the file itself closed cleanly.
		if (closed) {
			failure ??= `Record appended after ${path} was closed.`;
			return Promise.reject(new Error(`Cannot append to ${path} after it was closed.`));
		}
		// A write error destroys the stream, so the file needs a new one to stay recording.
		// Without this the first failure would end this file for the rest of the run.
		if (stream.destroyed) {
			stream = open();
		}
		const target = stream;

		return new Promise((resolve, reject) => {
			target.write(line, (error) => {
				if (error) {
					failure ??= errorMessage(error);
					stopped = true;
					reject(error);
					return;
				}
				// The reopen worked, so the file is recording again whatever it lost before.
				stopped = false;
				resolve();
			});
		});
	};

	return {
		append: async (record) => {
			// Serialized before the chain, so an unserializable record fails only its own append.
			// The writes of every record that follows it are untouched.
			const line = `${JSON.stringify(record)}\n`;
			const result = pending.then(async () => await writeLine(line));
			// The chain keeps the file's line order; the swallowed copy keeps it usable.
			pending = result.then(
				() => undefined,
				() => undefined,
			);
			await result;
		},
		close: async () => {
			// Closed before the drain, so an append racing this close is refused outright.
			// It can neither reopen the stream being ended nor fail with "write after end".
			closed = true;
			await pending;
			// A destroyed stream is already closed, and ending it again only errors.
			if (stream.destroyed) {
				return;
			}
			await new Promise<void>((resolve, reject) => {
				stream.end((error?: Error | null) => {
					if (error) {
						failure ??= errorMessage(error);
						// Whatever the stream still held never reached the file, and nothing follows it.
						stopped = true;
						reject(error);
						return;
					}
					resolve();
				});
			});
		},
		failure: () => (failure === undefined ? undefined : { message: failure, stopped }),
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
	// How complete the capture is.
	// An unfiltered run and a filtered one used to write the same run.json.
	// Nothing said whether what is missing was ever requested.
	exclude: annotations.exclude,
	include: annotations.include,
	// JSON.stringify drops undefined, so unlabelled runs keep the original run.json shape.
	labels: annotations.labels?.length ? annotations.labels : undefined,
	maxBodyBytes: annotations.maxBodyBytes,
	// Always present too, so the directory says whether a NetLog belongs beside it.
	netlog: annotations.netlog ?? false,
	nodePlatform: process.platform,
	note: annotations.note?.trim() ? annotations.note : undefined,
	pid: process.pid,
	runDirectory,
	// Always present too, so the directory says whether it holds a storage snapshot.
	snapshotStorage: annotations.snapshotStorage ?? false,
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
	// Named so a writer that failed can be reported by the file it was recording into.
	const writers: [string, NdjsonWriter][] = [
		["metadata", metadata],
		["errors", errors],
		["websocket", websocket],
		["eventsource", eventSource],
		["downloads", downloads],
	];
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
	// The GUID is browser-supplied and ends up in a path that plugins resolve.
	// Anything that is not the UUID Chromium sends is rejected before it is joined.
	const hashDownload = async (
		guid: string,
	): Promise<Pick<DownloadRecord, "error" | "file" | "sha256">> => {
		if (!DOWNLOAD_GUID_PATTERN.test(guid)) {
			return { error: `Download guid ${guid} is not a download identifier.` };
		}

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
			const results = await Promise.allSettled(writers.map(([, writer]) => writer.close()));
			// A settled rejection is discarded unless it is read.
			// A writer that lost a record mid-run never rejects here at all.
			// Both are reported, so the run itself says what a file is missing.
			for (const [index, [name, writer]] of writers.entries()) {
				const result = results[index];
				const failure = writer.failure();
				const error =
					result?.status === "rejected" ? errorMessage(result.reason) : failure?.message;
				if (error === undefined) {
					continue;
				}
				const stopped = failure?.stopped ?? true;
				const what = stopped ? "stopped recording" : "lost a record";
				process.stderr.write(`writer ${name}.ndjson ${what}: ${error}\n`);
				summary.recordWriterFailure(name, stopped);
			}
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
		// A point-in-time document, not a stream of events.
		// It is therefore written whole once instead of appended to line by line.
		// The summary counts only what the file holds, so a failed write prints no
		// Snapshot line for a file that does not exist.
		recordStorageSnapshot: async (snapshot: StorageSnapshot) => {
			await Bun.write(
				join(runDirectory, STORAGE_SNAPSHOT_FILE),
				`${JSON.stringify(snapshot, null, "\t")}\n`,
			);
			summary.recordStorageSnapshot(countStorageSnapshot(snapshot));

			return STORAGE_SNAPSHOT_FILE;
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
