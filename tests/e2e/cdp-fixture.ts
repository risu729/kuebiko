import { it } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { READY_MESSAGE } from "kuebiko";

import type { CapturedApiRecord } from "./assertions";
import waitFor from "./poll";

type LoggerProcess = ReturnType<typeof Bun.spawn> & {
	stdout: ReadableStream<Uint8Array>;
};

type LoggerStdout = {
	completed: Promise<string>;
	ready: Promise<void>;
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

const startFixtureServer = (): ReturnType<typeof Bun.serve> =>
	Bun.serve({
		fetch: async (request) => {
			const url = new URL(request.url);
			if (url.pathname === "/api/data") {
				return Response.json({
					ok: true,
					posted: JSON.parse(await request.text()) as unknown,
					source: "cdp-e2e",
				});
			}

			return new Response(
				`<!doctype html>
<meta charset="utf-8">
<script>
void fetch("/api/data", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ hello: "from-page" })
});
</script>`,
				{ headers: { "content-type": "text/html; charset=utf-8" } },
			);
		},
		hostname: "127.0.0.1",
		port: 0,
	});

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
	return { completed: consumeLoggerStdout(stdout, state), ready: state.readiness.promise };
};

const startLogger = (options: {
	browserPath: string;
	captureDirectory: string;
	cdpPort: number;
	profileDirectory: string;
}): { logger: LoggerProcess; stdout: LoggerStdout } => {
	const process = Bun.spawn(
		[
			"bun",
			"src/index.ts",
			"--launch-browser",
			"--browser-path",
			options.browserPath,
			"--browser-profile",
			options.profileDirectory,
			"--cdp-port",
			String(options.cdpPort),
			"--browser-arg=--no-sandbox",
			"--browser-arg=--disable-dev-shm-usage",
			"--out",
			options.captureDirectory,
		],
		{
			ipc: () => undefined,
			stderr: "inherit",
			stdout: "pipe",
		},
	);
	if (!(process.stdout instanceof ReadableStream)) {
		throw new Error("Logger stdout was not piped.");
	}
	const logger = process as LoggerProcess;
	return { logger, stdout: captureLoggerStdout(logger.stdout) };
};

const openNewPage = async (cdpEndpoint: string, url: string): Promise<void> => {
	const response = await fetch(`${cdpEndpoint}/json/new?${encodeURIComponent(url)}`, {
		method: "PUT",
	});
	if (!response.ok) {
		throw new Error(`Failed to open CDP page: ${response.status} ${await response.text()}`);
	}
};

const readMetadata = async (path: string): Promise<MetadataRecord[]> => {
	if (!(await Bun.file(path).exists())) {
		return [];
	}

	const text = await Bun.file(path).text();
	return text
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as MetadataRecord);
};

const isCapturedApiRecord = (record: MetadataRecord | undefined): record is CapturedApiRecord =>
	record?.bodyFile !== undefined && record.requestBodyFile !== undefined;

const findCapturedApiRecord = async (captureDirectory: string): Promise<CapturedApiRecord> =>
	await waitFor("captured API metadata", async () => {
		const records = await readMetadata(join(captureDirectory, "metadata.ndjson"));
		const apiRecord = records.find((record) => record.url?.includes("/api/data"));
		return isCapturedApiRecord(apiRecord) ? apiRecord : undefined;
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

	return { ...directories, cdpEndpoint, fixtureServer, logger, loggerStdout };
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
	await openNewPage(context.cdpEndpoint, `http://127.0.0.1:${context.fixtureServer.port}/`);
	await findCapturedApiRecord(context.captureDirectory);
};

export {
	cleanupRuns,
	closeContext,
	findCapturedApiRecord,
	loadPageAndWaitForCapture,
	maybeBrowserIt,
	startContext,
};
export type { TestContext };
