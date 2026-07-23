import {
	cleanupRuns,
	createRunDirectories,
	reservePort,
	startFixtureServer,
	startLoggerProcess,
} from "./cdp-fixture";
import type { TestContext } from "./cdp-fixture";
import waitFor from "./poll";

type BrowserProcess = ReturnType<typeof Bun.spawn>;

type AttachTestContext = TestContext & {
	browser: BrowserProcess;
};

type AttachResources = Awaited<ReturnType<typeof createRunDirectories>> &
	Pick<AttachTestContext, "browser" | "cdpEndpoint" | "fixtureServer">;

type LoggerContext = ReturnType<typeof startLoggerProcess>;

const browserPath = process.env["E2E_BROWSER_PATH"];
const activeContexts = new Set<AttachTestContext>();
const LOGGER_READY_TIMEOUT_MS = 15_000;
const PROCESS_STOP_TIMEOUT_MS = 5_000;

const requireBrowserPath = (): string => {
	if (!browserPath) {
		throw new Error("E2E_BROWSER_PATH is required for browser e2e tests.");
	}

	return browserPath;
};

const startBrowser = (options: {
	browserPath: string;
	cdpPort: number;
	profileDirectory: string;
}): BrowserProcess =>
	Bun.spawn(
		[
			options.browserPath,
			"--no-sandbox",
			"--disable-dev-shm-usage",
			"--no-startup-window",
			`--user-data-dir=${options.profileDirectory}`,
			"--remote-debugging-address=127.0.0.1",
			`--remote-debugging-port=${options.cdpPort}`,
		],
		{
			stderr: "inherit",
			stdout: "ignore",
		},
	);

const waitForCdp = async (cdpEndpoint: string): Promise<void> => {
	await waitFor("browser CDP endpoint", async () => {
		const response = await fetch(`${cdpEndpoint}/json/version`);
		return response.ok ? true : undefined;
	});
};

const waitForProcessExit = async (
	process: ReturnType<typeof Bun.spawn>,
	timeout = PROCESS_STOP_TIMEOUT_MS,
): Promise<boolean> =>
	await Promise.race([process.exited.then(() => true), Bun.sleep(timeout).then(() => false)]);

const stopProcess = async (process: ReturnType<typeof Bun.spawn>): Promise<void> => {
	if (process.exitCode !== null) {
		await process.exited;
		return;
	}

	process.kill("SIGTERM");
	if (await waitForProcessExit(process)) {
		return;
	}

	process.kill("SIGKILL");
	await process.exited;
};

const stopFailedLogger = async (loggerContext: LoggerContext): Promise<void> => {
	await stopProcess(loggerContext.logger);
	await loggerContext.stdout.completed.catch(() => undefined);
};

const stopAttachLogger = async (context: AttachTestContext): Promise<void> => {
	if (context.logger.exitCode === null) {
		context.logger.send("shutdown");
	}
	if (!(await waitForProcessExit(context.logger))) {
		await stopProcess(context.logger);
	}
	await context.loggerStdout.completed;
};

const startAttachResources = async (path: string): Promise<AttachResources> => {
	const directories = await createRunDirectories();
	const fixtureServer = startFixtureServer();
	const cdpPort = reservePort();
	const cdpEndpoint = `http://127.0.0.1:${cdpPort}`;

	try {
		const browser = startBrowser({
			browserPath: path,
			cdpPort,
			profileDirectory: directories.profileDirectory,
		});
		return { ...directories, browser, cdpEndpoint, fixtureServer };
	} catch (error) {
		fixtureServer.stop(true);
		throw error;
	}
};

const loggerReadyTimeout = async (): Promise<never> => {
	await Bun.sleep(LOGGER_READY_TIMEOUT_MS);
	throw new Error("Timed out waiting for logger readiness.");
};

const startReadyLogger = async (resources: AttachResources): Promise<LoggerContext> => {
	const loggerContext = startLoggerProcess([
		"--cdp",
		resources.cdpEndpoint,
		"--out",
		resources.captureDirectory,
	]);
	try {
		await Promise.race([loggerContext.stdout.ready, loggerReadyTimeout()]);
		return loggerContext;
	} catch (error) {
		await stopFailedLogger(loggerContext);
		throw error;
	}
};

const registerContext = (
	resources: AttachResources,
	loggerContext: LoggerContext,
): AttachTestContext => {
	const context = {
		...resources,
		logger: loggerContext.logger,
		loggerStdout: loggerContext.stdout,
	};
	activeContexts.add(context);
	return context;
};

const startAttachContext = async (path = requireBrowserPath()): Promise<AttachTestContext> => {
	const resources = await startAttachResources(path);

	try {
		await waitForCdp(resources.cdpEndpoint);
		const loggerContext = await startReadyLogger(resources);
		return registerContext(resources, loggerContext);
	} catch (error) {
		resources.fixtureServer.stop(true);
		await stopProcess(resources.browser);
		throw error;
	}
};

const closeAttachContext = async (context: AttachTestContext): Promise<void> => {
	if (!activeContexts.has(context)) {
		return;
	}

	context.fixtureServer.stop(true);
	try {
		await stopAttachLogger(context);
	} finally {
		await stopProcess(context.browser);
		activeContexts.delete(context);
	}
};

const cleanupAttachRuns = async (): Promise<void> => {
	try {
		await Promise.all([...activeContexts].map(closeAttachContext));
	} finally {
		await cleanupRuns();
	}
};

export { cleanupAttachRuns, closeAttachContext, startAttachContext };
export type { AttachTestContext };
