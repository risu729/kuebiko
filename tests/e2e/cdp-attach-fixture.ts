import { join } from "node:path";

import { cleanupRuns, createRunDirectories, startLoggerProcess } from "./cdp-fixture";
import type { TestContext } from "./cdp-fixture";
import { stopBrowser, stopProcess, waitForProcessExit } from "./cdp-process";
import type { BrowserProcess } from "./cdp-process";
import startFixtureServer from "./fixture-server";
import waitFor from "./poll";

type AttachTestContext = TestContext & {
	browser: BrowserProcess;
};

type AttachResources = Awaited<ReturnType<typeof createRunDirectories>> &
	Pick<AttachTestContext, "browser" | "cdpEndpoint" | "cdpPort" | "fixtureServer"> & {
		startupDeadline: number;
	};

type LoggerContext = ReturnType<typeof startLoggerProcess>;

type PendingAttachResources = {
	browser: BrowserProcess;
	directories: Awaited<ReturnType<typeof createRunDirectories>>;
	fixtureServer: ReturnType<typeof startFixtureServer>;
	startupDeadline: number;
};

const browserPath = process.env["E2E_BROWSER_PATH"];
const activeContexts = new Set<AttachTestContext>();
const CDP_FETCH_TIMEOUT_MS = 1_000;
const LOGGER_STOP_TIMEOUT_MS = 7_000;
const STARTUP_TIMEOUT_MS = 15_000;

const requireBrowserPath = (): string => {
	if (!browserPath) {
		throw new Error("E2E_BROWSER_PATH is required for browser e2e tests.");
	}

	return browserPath;
};

const startBrowser = (options: { browserPath: string; profileDirectory: string }): BrowserProcess =>
	Bun.spawn(
		[
			options.browserPath,
			"--no-sandbox",
			"--disable-dev-shm-usage",
			"--no-first-run",
			"--no-default-browser-check",
			"--no-startup-window",
			`--user-data-dir=${options.profileDirectory}`,
			"--remote-debugging-address=127.0.0.1",
			"--remote-debugging-port=0",
		],
		{
			stderr: "inherit",
			stdout: "ignore",
		},
	);

const browserExitedBeforeCdp = async (browser: BrowserProcess): Promise<never> => {
	const exitCode = await browser.exited;
	throw new Error(`Browser exited before exposing CDP with code ${exitCode}.`);
};

const raceBrowserReadiness = async <T>(
	browser: BrowserProcess,
	read: (signal: AbortSignal) => Promise<T>,
): Promise<T> => {
	const controller = new AbortController();
	try {
		return await Promise.race([read(controller.signal), browserExitedBeforeCdp(browser)]);
	} finally {
		controller.abort();
	}
};

const readBrowserCdpPort = async (profileDirectory: string): Promise<number | undefined> => {
	const portFile = Bun.file(join(profileDirectory, "DevToolsActivePort"));
	if (!(await portFile.exists())) {
		return undefined;
	}

	const port = Number((await portFile.text()).split(/\r?\n/u, 1)[0]);
	return Number.isSafeInteger(port) && port > 0 && port <= 65_535 ? port : undefined;
};

const waitForBrowserCdpPort = async (
	profileDirectory: string,
	browser: BrowserProcess,
	deadline: number,
): Promise<number> =>
	await raceBrowserReadiness(
		browser,
		async (signal) =>
			await waitFor("browser DevToolsActivePort", () => readBrowserCdpPort(profileDirectory), {
				deadline,
				signal,
			}),
	);

const waitForCdp = async (
	cdpEndpoint: string,
	browser: BrowserProcess,
	deadline: number,
): Promise<void> => {
	await raceBrowserReadiness(browser, async (signal) => {
		await waitFor(
			"browser CDP endpoint",
			async () => {
				const timeout = Math.max(1, Math.min(CDP_FETCH_TIMEOUT_MS, deadline - Date.now()));
				const response = await fetch(`${cdpEndpoint}/json/version`, {
					signal: AbortSignal.any([signal, AbortSignal.timeout(timeout)]),
				});
				return response.ok ? true : undefined;
			},
			{ deadline, signal },
		);
	});
};

const stopFailedLogger = async (loggerContext: LoggerContext): Promise<void> => {
	await stopProcess(loggerContext.logger);
	await loggerContext.stdout.completed.catch(() => undefined);
};

const stopAttachLogger = async (context: AttachTestContext): Promise<void> => {
	if (context.logger.exitCode === null) {
		context.logger.send("shutdown");
	}
	if (!(await waitForProcessExit(context.logger, LOGGER_STOP_TIMEOUT_MS))) {
		context.logger.kill("SIGKILL");
		await context.logger.exited;
	}
	await context.loggerStdout.completed;
};

const completeAttachResources = async (
	pending: PendingAttachResources,
): Promise<AttachResources> => {
	const { browser, directories, fixtureServer, startupDeadline } = pending;
	const cdpPort = await waitForBrowserCdpPort(
		directories.profileDirectory,
		browser,
		startupDeadline,
	);
	const cdpEndpoint = `http://127.0.0.1:${cdpPort}`;
	await waitForCdp(cdpEndpoint, browser, startupDeadline);
	return {
		...directories,
		browser,
		cdpEndpoint,
		cdpPort,
		fixtureServer,
		startupDeadline,
	};
};

const startBrowserWithFixtureCleanup = (
	path: string,
	profileDirectory: string,
	fixtureServer: ReturnType<typeof startFixtureServer>,
): BrowserProcess => {
	try {
		return startBrowser({ browserPath: path, profileDirectory });
	} catch (error) {
		fixtureServer.stop(true);
		throw error;
	}
};

const startAttachResources = async (path: string): Promise<AttachResources> => {
	const directories = await createRunDirectories();
	const fixtureServer = startFixtureServer();
	const browser = startBrowserWithFixtureCleanup(path, directories.profileDirectory, fixtureServer);
	const startupDeadline = Date.now() + STARTUP_TIMEOUT_MS;

	try {
		return await completeAttachResources({
			browser,
			directories,
			fixtureServer,
			startupDeadline,
		});
	} catch (error) {
		fixtureServer.stop(true);
		await stopProcess(browser);
		throw error;
	}
};

const waitForLoggerReady = async (
	loggerContext: LoggerContext,
	startupDeadline: number,
): Promise<void> => {
	const timeout = Promise.withResolvers<void>();
	const timeoutId = setTimeout(
		() => timeout.reject(new Error("Timed out waiting for logger readiness.")),
		Math.max(0, startupDeadline - Date.now()),
	);
	try {
		await Promise.race([loggerContext.stdout.ready, timeout.promise]);
	} finally {
		clearTimeout(timeoutId);
	}
};

const startReadyLogger = async (resources: AttachResources): Promise<LoggerContext> => {
	const loggerContext = startLoggerProcess([
		"--cdp",
		resources.cdpEndpoint,
		"--out",
		resources.captureDirectory,
	]);
	try {
		await waitForLoggerReady(loggerContext, resources.startupDeadline);
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
		const loggerContext = await startReadyLogger(resources);
		return registerContext(resources, loggerContext);
	} catch (error) {
		resources.fixtureServer.stop(true);
		await stopBrowser(resources.browser, resources.cdpPort);
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
		try {
			await stopBrowser(context.browser, context.cdpPort);
		} finally {
			activeContexts.delete(context);
		}
	}
};

const cleanupAttachRuns = async (): Promise<void> => {
	const results = await Promise.allSettled([...activeContexts].map(closeAttachContext));
	await cleanupRuns();
	const errors = results.flatMap((result) =>
		result.status === "rejected" ? [result.reason as unknown] : [],
	);
	if (errors.length > 0) {
		throw new AggregateError(errors, "Attach-mode cleanup failed.");
	}
};

export { cleanupAttachRuns, closeAttachContext, startAttachContext };
export type { AttachTestContext };
