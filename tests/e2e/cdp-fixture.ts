import { it } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { READY_MESSAGE } from "kuebiko";

import type {
	CapturedApiRecord,
	CapturedDownload,
	CapturedEventSourceMessage,
	CapturedStorageChange,
	CapturedWebSocketFrame,
} from "./assertions";
import openNewPage from "./cdp-page";
import startFixtureServer from "./fixture-server";
import waitFor from "./poll";

type LoggerProcess = ReturnType<typeof Bun.spawn> & {
	stdout: ReadableStream<Uint8Array>;
};

type LoggerStdout = {
	completed: Promise<string>;
	ready: Promise<void>;
	waitFor: (text: string) => Promise<void>;
};

type LoggerStdoutState = {
	decoder: TextDecoder;
	output: string;
	readiness: PromiseWithResolvers<void>;
	ready: boolean;
};

type MetadataRecord = {
	bodyFile?: string | undefined;
	requestBodyFile?: string | undefined;
	url?: string | undefined;
};

type RunDirectories = {
	captureDirectory: string;
	netLogPath: string;
	profileDirectory: string;
	runRoot: string;
};

type TestContext = RunDirectories & {
	cdpEndpoint: string;
	cdpPort: number;
	fixtureServer: ReturnType<typeof Bun.serve>;
	logger: LoggerProcess;
	loggerStdout: LoggerStdout;
};

const browserPath = process.env["E2E_BROWSER_PATH"];
const e2eRoot = join(process.cwd(), ".e2e");
const cleanupPaths: string[] = [];

const maybeBrowserIt = browserPath ? it : it.skip;

const requireBrowserPath = (): string => {
	if (!browserPath) {
		throw new Error("E2E_BROWSER_PATH is required for browser e2e tests.");
	}

	return browserPath;
};

const cleanupRuns = async (): Promise<void> => {
	await Promise.all(
		cleanupPaths.splice(0).map((path) => rm(path, { force: true, recursive: true })),
	);
};

const reservePort = (): number => {
	const server = Bun.serve({
		fetch: () => new Response("reserved"),
		hostname: "127.0.0.1",
		port: 0,
	});
	const { port } = server;
	server.stop(true);
	if (port === undefined) {
		throw new Error("Bun.serve did not allocate a port.");
	}

	return port;
};

const createRunDirectories = async (): Promise<RunDirectories> => {
	await mkdir(e2eRoot, { recursive: true });
	const runRoot = join(e2eRoot, `${Date.now()}-${Math.random().toString(16).slice(2)}`);
	const captureDirectory = join(runRoot, "capture");
	const netLogPath = join(captureDirectory, "netlog.json");
	const profileDirectory = join(runRoot, "profile");
	cleanupPaths.push(runRoot);
	await mkdir(captureDirectory, { recursive: true });
	await mkdir(profileDirectory, { recursive: true });

	return { captureDirectory, netLogPath, profileDirectory, runRoot };
};

const consumeLoggerStdout = async (
	stdout: ReadableStream<Uint8Array>,
	state: LoggerStdoutState,
): Promise<string> => {
	try {
		await stdout.pipeTo(
			new WritableStream<Uint8Array>({
				write: (chunk) => {
					process.stdout.write(chunk);
					state.output += state.decoder.decode(chunk, { stream: true });
					if (!state.ready && state.output.split(/\r?\n/u).includes(READY_MESSAGE)) {
						state.ready = true;
						state.readiness.resolve();
					}
				},
			}),
		);
	} catch (error) {
		state.readiness.reject(error);
		throw error;
	}

	state.output += state.decoder.decode();
	if (!state.ready) {
		state.readiness.reject(
			new Error(`Logger exited before becoming ready. Output: ${state.output}`),
		);
	}
	return state.output;
};

const captureLoggerStdout = (stdout: ReadableStream<Uint8Array>): LoggerStdout => {
	const state: LoggerStdoutState = {
		decoder: new TextDecoder(),
		output: "",
		readiness: Promise.withResolvers<void>(),
		ready: false,
	};
	return {
		completed: consumeLoggerStdout(stdout, state),
		ready: state.readiness.promise,
		waitFor: async (text) => {
			await waitFor(`logger output containing ${text}`, () =>
				Promise.resolve(state.output.includes(text) ? true : undefined),
			);
		},
	};
};

const startLoggerProcess = (args: string[]): { logger: LoggerProcess; stdout: LoggerStdout } => {
	const process = Bun.spawn(["bun", "src/index.ts", ...args], {
		ipc: () => undefined,
		stderr: "inherit",
		stdout: "pipe",
	});
	if (!(process.stdout instanceof ReadableStream)) {
		process.kill("SIGKILL");
		throw new Error("Logger stdout was not piped.");
	}
	const logger = process as LoggerProcess;
	return { logger, stdout: captureLoggerStdout(logger.stdout) };
};

const startLogger = (options: {
	browserPath: string;
	captureDirectory: string;
	cdpPort: number;
	profileDirectory: string;
}): { logger: LoggerProcess; stdout: LoggerStdout } =>
	startLoggerProcess([
		"--launch-browser",
		"--browser-path",
		options.browserPath,
		"--browser-profile",
		options.profileDirectory,
		"--cdp-port",
		String(options.cdpPort),
		"--browser-arg=--no-sandbox",
		"--browser-arg=--disable-dev-shm-usage",
		"--browser-arg=--no-first-run",
		"--browser-arg=--no-default-browser-check",
		"--capture-cookies",
		"--capture-downloads",
		"--snapshot-storage",
		"--track-storage",
		"--out",
		options.captureDirectory,
	]);

// The logger appends to the NDJSON files while this polls them, so a read can land mid-line.
// Bun.JSONL.parse drops an incomplete trailing value instead of throwing on it.
const readNdjson = async <Record>(path: string): Promise<Record[]> => {
	const file = Bun.file(path);
	if (!(await file.exists())) {
		return [];
	}

	return Bun.JSONL.parse(await file.bytes()) as Record[];
};

const isCapturedApiRecord = (record: MetadataRecord | undefined): record is CapturedApiRecord =>
	record?.bodyFile !== undefined && record.requestBodyFile !== undefined;

const findCapturedApiRecord = async (captureDirectory: string): Promise<CapturedApiRecord> =>
	await waitFor("captured API metadata", async () => {
		const records = await readNdjson<MetadataRecord>(join(captureDirectory, "metadata.ndjson"));
		const apiRecord = records.find((record) => record.url?.includes("/api/data"));
		return isCapturedApiRecord(apiRecord) ? apiRecord : undefined;
	});

// The page sends one frame and the fixture echoes it, so both directions must land.
const findWebSocketFrames = async (captureDirectory: string): Promise<CapturedWebSocketFrame[]> =>
	await waitFor("captured WebSocket frames", async () => {
		const frames = await readNdjson<CapturedWebSocketFrame>(
			join(captureDirectory, "websocket.ndjson"),
		);
		const directions = new Set(frames.map((frame) => frame.direction));
		return directions.has("sent") && directions.has("received") ? frames : undefined;
	});

// The fixture pushes two events over one stream, so both must land before asserting.
const findEventSourceMessages = async (
	captureDirectory: string,
): Promise<CapturedEventSourceMessage[]> =>
	await waitFor("captured EventSource messages", async () => {
		const messages = await readNdjson<CapturedEventSourceMessage>(
			join(captureDirectory, "eventsource.ndjson"),
		);
		return messages.length >= 2 ? messages : undefined;
	});

// The page announces its IndexedDB write with a request of its own.
// Only after that request is there anything for the snapshot to read back.
const waitForStorageWrites = async (captureDirectory: string): Promise<void> => {
	await waitFor("page storage writes", async () => {
		const records = await readNdjson<MetadataRecord>(join(captureDirectory, "metadata.ndjson"));
		return records.some((record) => record.url?.includes("/api/storage-ready")) ? true : undefined;
	});
};

// The page writes both web storage areas and one IndexedDB store, so all three must
// Reach storage.ndjson before asserting. A write that happened before the logger
// Reached the origin lands as a baseline, and a later one as its own change, so the
// Assertion waits for the area rather than for a particular change.
const findStorageChanges = async (captureDirectory: string): Promise<CapturedStorageChange[]> =>
	await waitFor("captured storage changes", async () => {
		const changes = await readNdjson<CapturedStorageChange>(
			join(captureDirectory, "storage.ndjson"),
		);
		const areas = new Set(changes.map((change) => change.area));
		return areas.has("localStorage") && areas.has("sessionStorage") && areas.has("indexedDB")
			? changes
			: undefined;
	});

// The page clicks one download link, so exactly one terminal record must land.
const findDownloads = async (captureDirectory: string): Promise<CapturedDownload[]> =>
	await waitFor("captured downloads", async () => {
		const downloads = await readNdjson<CapturedDownload>(
			join(captureDirectory, "downloads.ndjson"),
		);
		return downloads.length >= 1 ? downloads : undefined;
	});

const startContext = async (path = requireBrowserPath()): Promise<TestContext> => {
	const directories = await createRunDirectories();
	const fixtureServer = startFixtureServer();
	const cdpPort = reservePort();
	const cdpEndpoint = `http://127.0.0.1:${cdpPort}`;
	const { logger, stdout: loggerStdout } = startLogger({
		browserPath: path,
		captureDirectory: directories.captureDirectory,
		cdpPort,
		profileDirectory: directories.profileDirectory,
	});
	await loggerStdout.ready;

	return { ...directories, cdpEndpoint, cdpPort, fixtureServer, logger, loggerStdout };
};

const stopLogger = async (context: TestContext): Promise<void> => {
	context.logger.send("shutdown");
	await Promise.all([context.logger.exited.catch(() => undefined), context.loggerStdout.completed]);
};

const closeContext = async (context: TestContext): Promise<void> => {
	context.fixtureServer.stop(true);
	await stopLogger(context);
};

const loadPageAndWaitForCapture = async (context: TestContext): Promise<void> => {
	await openNewPage(context, `http://127.0.0.1:${context.fixtureServer.port}/`);
	await findCapturedApiRecord(context.captureDirectory);
};

export {
	cleanupRuns,
	closeContext,
	createRunDirectories,
	findCapturedApiRecord,
	findDownloads,
	findEventSourceMessages,
	findStorageChanges,
	findWebSocketFrames,
	loadPageAndWaitForCapture,
	maybeBrowserIt,
	reservePort,
	startContext,
	startLoggerProcess,
	waitForStorageWrites,
};
export type { TestContext };
