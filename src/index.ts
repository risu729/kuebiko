import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { startBrowser } from "./browser";
import type { StartedBrowser } from "./browser";
import { startCdpLogger } from "./cdp";
import {
	DEFAULT_CDP_ENDPOINT,
	READY_MESSAGE,
	TOOL_VERSION,
	cliArgs,
	normalizeArgs,
	parseArgs,
	renderHelp,
} from "./cli";
import { defineConfig } from "./config";
import type { LoggerConfig, LoggerPluginConfig } from "./config";
import { createPluginHost } from "./plugins";
import type { HookEvent, HookEventName, LoggerPlugin, PluginContext } from "./plugins";
import { getDefaultBaseDirectory, getDefaultCaptureDirectory } from "./sanitize";
import { createStorage } from "./storage";
import type { RunAnnotations } from "./storage";
import type { CliOptions } from "./types";

// The browser closing can win this race with both signal listeners still armed.
// Left installed they keep overriding the default signal handling.
// The first Ctrl-C during teardown would then only re-resolve a settled promise.
// They are removed as soon as the race is decided.
// That is what lets the force-quit handler below answer the next one.
const awaitShutdown = async (closed: Promise<void>): Promise<void> => {
	const { promise, resolve } = Promise.withResolvers<void>();
	const onSignal = (): void => {
		resolve();
	};
	const onMessage = (message: unknown): void => {
		if (message === "shutdown") {
			process.stdout.write("shutdown requested via IPC\n");
			resolve();
		}
	};

	process.on("SIGINT", onSignal);
	process.on("SIGTERM", onSignal);
	process.on("message", onMessage);
	try {
		await Promise.race([promise, closed]);
	} finally {
		process.removeListener("SIGINT", onSignal);
		process.removeListener("SIGTERM", onSignal);
		process.removeListener("message", onMessage);
	}
};

// Teardown drains capture work, which takes as long as it takes.
// A second signal is the user saying they are done waiting, so it leaves at once.
// Leaving aborts the writes still in flight, and the summary is never printed.
// The last line of an NDJSON file can therefore be a partial one.
// Writes are serialized per writer, so that is at most one trailing line per file.
const forceQuitOnSignal = (): (() => void) => {
	const onSignal = (): void => {
		process.stderr.write("shutdown interrupted; exiting now\n");
		process.exit(130);
	};

	process.on("SIGINT", onSignal);
	process.on("SIGTERM", onSignal);

	return () => {
		process.removeListener("SIGINT", onSignal);
		process.removeListener("SIGTERM", onSignal);
	};
};

const reportTeardownError = (error: unknown): void => {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
};

const getDefaultBrowserProfileDirectory = (): string =>
	join(getDefaultBaseDirectory(), "browser-profile");

const getLaunchProfileDirectory = (options: CliOptions): string =>
	options.browserProfile ?? getDefaultBrowserProfileDirectory();

const getLaunchNetLogPath = (out: string, options: CliOptions): string | undefined =>
	options.netlog ? join(out, "netlog.json") : undefined;

const startConfiguredBrowser = async (
	options: CliOptions,
	out: string,
): Promise<StartedBrowser | undefined> => {
	if (!options.launchBrowser) {
		return undefined;
	}

	const profileDirectory = getLaunchProfileDirectory(options);
	await mkdir(profileDirectory, { recursive: true });
	const browser = await startBrowser({
		browserArgs: options.browserArgs,
		browserCommand: options.browserCommand,
		browserPath: options.browserPath,
		cdpPort: options.cdpPort,
		netLogPath: getLaunchNetLogPath(out, options),
		profileDirectory,
		verbose: options.verbose,
	});
	process.stdout.write(`browser_profile=${profileDirectory}\n`);
	process.stdout.write(`netlog=${getLaunchNetLogPath(out, options) ?? "disabled"}\n`);
	return browser;
};

// How the run was started, recorded in run.json next to the capture files.
const getRunAnnotations = (options: CliOptions): RunAnnotations => ({
	captureCookies: options.captureCookies,
	captureDownloads: options.captureDownloads,
	labels: options.labels,
	note: options.note,
	snapshotStorage: options.snapshotStorage,
	streamBodies: options.streamBodies,
});

type RunParts = {
	browser?: StartedBrowser | undefined;
	logger?: Awaited<ReturnType<typeof startCdpLogger>> | undefined;
	plugins?: Awaited<ReturnType<typeof createPluginHost>> | undefined;
	storage?: Awaited<ReturnType<typeof createStorage>> | undefined;
};

// Every teardown step is reported instead of thrown so the summary is always printed.
// The storage snapshot goes first because it is the last capture work of the run.
// It needs both the browser and the CDP connection, which the next two steps remove.
const stopRun = async ({ browser, logger, plugins, storage }: RunParts): Promise<void> => {
	await logger?.snapshotStorage().catch(reportTeardownError);
	await plugins?.stopping().catch(reportTeardownError);
	const requestBrowserClose = logger ? () => logger.closeBrowser() : undefined;
	// Close the browser first: closing the CDP client rejects Browser.close in flight.
	await browser?.close(requestBrowserClose).catch(reportTeardownError);
	await logger?.close().catch(reportTeardownError);
	await plugins?.close().catch(reportTeardownError);
	await storage?.close().catch(reportTeardownError);
	if (storage) {
		process.stdout.write(`${storage.summary.render()}\n`);
	}
};

const runLogger = async (options: CliOptions): Promise<void> => {
	const out = options.out ?? getDefaultCaptureDirectory();
	await mkdir(out, { recursive: true });
	const browser = await startConfiguredBrowser(options, out);
	const cdp = browser?.cdpEndpoint ?? options.cdp;
	let storage: undefined | Awaited<ReturnType<typeof createStorage>>;
	let logger: undefined | Awaited<ReturnType<typeof startCdpLogger>>;
	let plugins: undefined | Awaited<ReturnType<typeof createPluginHost>>;
	try {
		storage = await createStorage(out, cdp, getRunAnnotations(options));
		process.stdout.write(`capture_dir=${storage.runDirectory}\ncdp=${cdp}\n`);

		plugins = await createPluginHost({
			configPath: options.config,
			disabled: options.noPlugins,
			storage,
			verbose: options.verbose,
		});
		logger = await startCdpLogger({
			captureCookies: options.captureCookies,
			captureDownloads: options.captureDownloads,
			cdp,
			exclude: options.exclude,
			hooks: plugins,
			include: options.include,
			maxBodyBytes: options.maxBodyBytes,
			snapshotStorage: options.snapshotStorage,
			storage,
			streamBodies: options.streamBodies,
			verbose: options.verbose,
		});
		process.stdout.write(`${READY_MESSAGE}\n`);
		await awaitShutdown(logger.closed);
	} finally {
		const stopForceQuit = forceQuitOnSignal();
		try {
			await stopRun({ browser, logger, plugins, storage });
		} finally {
			stopForceQuit();
		}
	}
};

const main = async (argv = process.argv.slice(2)): Promise<void> => {
	const options = parseArgs(argv);
	if (options.help) {
		process.stdout.write(renderHelp());
		return;
	}
	if (options.version) {
		process.stdout.write(`${TOOL_VERSION}\n`);
		return;
	}

	await runLogger(options);
};

if (import.meta.main) {
	await main();
}

export {
	DEFAULT_CDP_ENDPOINT,
	READY_MESSAGE,
	awaitShutdown,
	cliArgs,
	defineConfig,
	forceQuitOnSignal,
	getRunAnnotations,
	main,
	normalizeArgs,
	parseArgs,
	renderHelp,
	runLogger,
	stopRun,
};
export type {
	HookEvent,
	HookEventName,
	LoggerConfig,
	LoggerPlugin,
	LoggerPluginConfig,
	PluginContext,
};
