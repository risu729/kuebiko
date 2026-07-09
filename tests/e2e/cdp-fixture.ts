import { it } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

import type { CapturedApiRecord } from "./assertions";
import waitFor from "./poll";

type LoggerProcess = ReturnType<typeof Bun.spawn> & {
	stderr: ReadableStream<Uint8Array>;
	stdout: ReadableStream<Uint8Array>;
};
type LoggerStdoutReader = {
	read: () => Promise<{ done: boolean; value?: Uint8Array | undefined }>;
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
};

const browserPath = process.env["E2E_BROWSER_PATH"];
const e2eRoot = join(process.cwd(), ".e2e");
const cleanupPaths: string[] = [];
const LOGGER_STOP_TIMEOUT_MS = 60_000;

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

const startLogger = (options: {
	browserPath: string;
	captureDirectory: string;
	cdpPort: number;
	profileDirectory: string;
}): LoggerProcess => {
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
			stderr: "pipe",
			stdout: "pipe",
		},
	);
	if (!(process.stdout instanceof ReadableStream)) {
		throw new Error("Logger stdout was not piped.");
	}
	if (!(process.stderr instanceof ReadableStream)) {
		throw new Error("Logger stderr was not piped.");
	}

	return process as LoggerProcess;
};

const readLoggerStderr = async (logger: LoggerProcess): Promise<string> => {
	await logger.exited.catch(() => undefined);
	return await new Response(logger.stderr).text();
};

const readUntilLoggerReady = async (
	logger: LoggerProcess,
	reader: LoggerStdoutReader,
	seen = "",
): Promise<void> => {
	const { done, value } = await reader.read();
	if (done) {
		const stderr = await readLoggerStderr(logger);
		throw new Error(`Logger exited before becoming ready. Output: ${seen}\nStderr: ${stderr}`);
	}

	const output = `${seen}${new TextDecoder().decode(value)}`;
	if (output.includes("logger running")) {
		return;
	}

	await readUntilLoggerReady(logger, reader, output);
};

const waitForLoggerReady = async (logger: LoggerProcess): Promise<void> => {
	await readUntilLoggerReady(logger, logger.stdout.getReader() as unknown as LoggerStdoutReader);
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
	const logger = startLogger({
		browserPath: path,
		captureDirectory: directories.captureDirectory,
		cdpPort,
		profileDirectory: directories.profileDirectory,
	});
	await waitForLoggerReady(logger);

	return { ...directories, cdpEndpoint, fixtureServer, logger };
};

const waitForLoggerExit = async (logger: LoggerProcess): Promise<boolean> =>
	await Promise.race([
		logger.exited.then(() => true),
		Bun.sleep(LOGGER_STOP_TIMEOUT_MS).then(() => false),
	]).catch(() => true);

const stopLogger = async (logger: LoggerProcess): Promise<void> => {
	logger.kill("SIGTERM");
	if (await waitForLoggerExit(logger)) {
		return;
	}

	logger.kill("SIGKILL");
	await logger.exited.catch(() => undefined);
	const stderr = await readLoggerStderr(logger);
	throw new Error(
		`Logger did not exit within ${LOGGER_STOP_TIMEOUT_MS}ms after SIGTERM. Stderr: ${stderr}`,
	);
};

const closeContext = async (context: TestContext): Promise<void> => {
	context.fixtureServer.stop(true);
	await stopLogger(context.logger);
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
