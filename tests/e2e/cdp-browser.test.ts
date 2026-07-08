import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

type BrowserProcess = ReturnType<typeof Bun.spawn>;
type LoggerProcess = ReturnType<typeof Bun.spawn> & {
	stdout: ReadableStream<Uint8Array>;
};
type LoggerStdoutReader = {
	read: () => Promise<{ done: boolean; value?: Uint8Array | undefined }>;
};

type MetadataRecord = {
	bodyFile?: string | undefined;
	bodySaved?: boolean | undefined;
	requestBodyFile?: string | undefined;
	requestBodySaved?: boolean | undefined;
	requestMethod?: string | undefined;
	url?: string | undefined;
};

type CapturedApiRecord = MetadataRecord & {
	bodyFile: string;
	requestBodyFile: string;
};

type RunDirectories = {
	captureDirectory: string;
	profileDirectory: string;
	runRoot: string;
};

type TestContext = RunDirectories & {
	browser: BrowserProcess;
	cdpEndpoint: string;
	fixtureServer: ReturnType<typeof Bun.serve>;
	logger: LoggerProcess;
};

type WaitState = {
	deadline: number;
	lastError?: unknown;
};

const browserPath = process.env["E2E_BROWSER_PATH"];
const maybeIt = browserPath ? it : it.skip;
const e2eRoot = join(process.cwd(), ".e2e");
const cleanupPaths: string[] = [];

const requireBrowserPath = (): string => {
	if (!browserPath) {
		throw new Error("E2E_BROWSER_PATH is required for browser e2e tests.");
	}

	return browserPath;
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

const waitFor = async <T>(
	description: string,
	read: () => Promise<T | undefined>,
	state: WaitState = { deadline: Date.now() + 15_000 },
): Promise<T> => {
	if (Date.now() >= state.deadline) {
		throw new Error(`Timed out waiting for ${description}`, { cause: state.lastError });
	}

	try {
		const result = await read();
		if (result !== undefined) {
			return result;
		}
	} catch (error) {
		await Bun.sleep(250);
		return await waitFor(description, read, { ...state, lastError: error });
	}

	await Bun.sleep(250);
	return await waitFor(description, read, state);
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
	const profileDirectory = join(runRoot, "profile");
	cleanupPaths.push(runRoot);
	await mkdir(captureDirectory, { recursive: true });
	await mkdir(profileDirectory, { recursive: true });

	return { captureDirectory, profileDirectory, runRoot };
};

const startBrowser = (path: string, cdpPort: number, profileDirectory: string): BrowserProcess =>
	Bun.spawn(
		[
			path,
			"--headless=new",
			"--disable-gpu",
			"--no-first-run",
			"--no-default-browser-check",
			"--no-sandbox",
			`--user-data-dir=${profileDirectory}`,
			"--remote-debugging-address=127.0.0.1",
			`--remote-debugging-port=${cdpPort}`,
		],
		{
			stderr: "ignore",
			stdout: "ignore",
		},
	);

const startLogger = (cdpEndpoint: string, captureDirectory: string): LoggerProcess => {
	const process = Bun.spawn(
		["bun", "src/index.ts", "--cdp", cdpEndpoint, "--out", captureDirectory],
		{
			stderr: "ignore",
			stdout: "pipe",
		},
	);
	if (!(process.stdout instanceof ReadableStream)) {
		throw new Error("Logger stdout was not piped.");
	}

	return process as LoggerProcess;
};

const readUntilLoggerReady = async (reader: LoggerStdoutReader, seen = ""): Promise<void> => {
	const { done, value } = await reader.read();
	if (done) {
		throw new Error(`Logger exited before becoming ready. Output: ${seen}`);
	}

	const output = `${seen}${new TextDecoder().decode(value)}`;
	if (output.includes("logger running")) {
		return;
	}

	await readUntilLoggerReady(reader, output);
};

const waitForCdp = async (cdpEndpoint: string): Promise<void> => {
	await waitFor("CDP /json/version", async () => {
		const response = await fetch(`${cdpEndpoint}/json/version`);
		return response.ok ? true : undefined;
	});
};

const waitForLoggerReady = async (logger: LoggerProcess): Promise<void> => {
	await readUntilLoggerReady(logger.stdout.getReader() as unknown as LoggerStdoutReader);
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

const startContext = async (path: string): Promise<TestContext> => {
	const directories = await createRunDirectories();
	const fixtureServer = startFixtureServer();
	const cdpPort = reservePort();
	const cdpEndpoint = `http://127.0.0.1:${cdpPort}`;
	const browser = startBrowser(path, cdpPort, directories.profileDirectory);
	await waitForCdp(cdpEndpoint);
	const logger = startLogger(cdpEndpoint, directories.captureDirectory);
	await waitForLoggerReady(logger);

	return { ...directories, browser, cdpEndpoint, fixtureServer, logger };
};

const stopProcess = async (process: BrowserProcess | LoggerProcess): Promise<void> => {
	process.kill("SIGTERM");
	await process.exited.catch(() => undefined);
};

const closeContext = async (context: TestContext): Promise<void> => {
	context.fixtureServer.stop(true);
	await Promise.all([stopProcess(context.logger), stopProcess(context.browser)]);
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

describe("CDP browser e2e", () => {
	afterEach(async () => {
		await Promise.all(
			cleanupPaths.splice(0).map((path) => rm(path, { force: true, recursive: true })),
		);
	});

	maybeIt("captures a localhost JSON response and request payload from the CLI", async () => {
		const context = await startContext(requireBrowserPath());

		try {
			await openNewPage(context.cdpEndpoint, `http://127.0.0.1:${context.fixtureServer.port}/`);
			const metadata = await findCapturedApiRecord(context.captureDirectory);
			const bodies = await readCapturedBodies(context.captureDirectory, metadata);
			assertCapturedApi(metadata, bodies);
		} finally {
			await closeContext(context);
		}
	});
});
