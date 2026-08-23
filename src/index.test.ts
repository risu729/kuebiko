import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
	DEFAULT_CDP_ENDPOINT,
	awaitShutdown,
	forceQuitOnSignal,
	parseArgs,
	renderHelp,
	stopRun,
} from "./index";
import { settlesWithin } from "./timeout";

describe("parseArgs", () => {
	it("uses defaults", () => {
		expect(parseArgs([])).toEqual({
			browserArgs: [],
			captureCookies: false,
			captureDownloads: false,
			cdp: DEFAULT_CDP_ENDPOINT,
			cdpPort: 9222,
			help: false,
			labels: [],
			launchBrowser: false,
			netlog: true,
			noPlugins: false,
			snapshotStorage: false,
			streamBodies: false,
			verbose: false,
			version: false,
		});
	});

	it("parses logger options", () => {
		const options = parseArgs([
			"--cdp",
			"http://127.0.0.1:9333",
			"--out",
			"C:\\captures\\run",
			"--verbose",
			"--config",
			"logger.config.ts",
			"--no-plugins",
			"--include",
			"api",
			"--exclude",
			"tracking",
			"--max-body-bytes",
			"123",
			"--cdp-port",
			"9333",
		]);

		expect(options.cdp).toBe("http://127.0.0.1:9333");
		expect(options.cdpPort).toBe(9333);
		expect(options.config).toBe("logger.config.ts");
		expect(options.noPlugins).toBe(true);
		expect(options.out).toBe("C:\\captures\\run");
		expect(options.verbose).toBe(true);
		expect(options.include?.test("https://example.test/api")).toBe(true);
		expect(options.exclude?.test("https://example.test/tracking")).toBe(true);
		expect(options.maxBodyBytes).toBe(123);
	});

	it("parses browser launch options", () => {
		const options = parseArgs([
			"--launch-browser",
			"--browser-command",
			"chrome.exe",
			"--browser-profile",
			"C:\\profile",
			"--browser-arg=--no-sandbox",
			"--browser-arg=--disable-dev-shm-usage",
			"--no-netlog",
		]);

		expect(options.launchBrowser).toBe(true);
		expect(options.browserArgs).toEqual(["--no-sandbox", "--disable-dev-shm-usage"]);
		expect(options.browserCommand).toBe("chrome.exe");
		expect(options.browserProfile).toBe("C:\\profile");
		expect(options.netlog).toBe(false);
	});

	it("parses repeated labels and a note", () => {
		const options = parseArgs([
			"--label",
			"account-a",
			"--label=billing",
			"--note",
			"manual sweep",
		]);

		expect(options.labels).toEqual(["account-a", "billing"]);
		expect(options.note).toBe("manual sweep");
	});

	it("rejects empty labels and notes", () => {
		expect(() => parseArgs(["--label", ""])).toThrow();
		expect(() => parseArgs(["--note", ""])).toThrow("--note must not be empty.");
	});

	it("parses the raw header opt-in", () => {
		expect(parseArgs(["--capture-cookies"]).captureCookies).toBe(true);
	});

	it("parses the download opt-in", () => {
		expect(parseArgs(["--capture-downloads"]).captureDownloads).toBe(true);
	});

	it("parses the storage snapshot opt-in", () => {
		expect(parseArgs(["--snapshot-storage"]).snapshotStorage).toBe(true);
	});

	it("rejects unknown flags", () => {
		expect(() => parseArgs(["--wat"])).toThrow("Unknown argument: --wat");
	});

	it("rejects launch mode without an explicit browser", () => {
		expect(() => parseArgs(["--launch-browser"])).toThrow(
			"--launch-browser requires --browser-command or --browser-path.",
		);
	});

	it("parses help and version flags", () => {
		expect(parseArgs(["--help"]).help).toBe(true);
		expect(parseArgs(["-v"]).version).toBe(true);
	});

	it("renders local help output", () => {
		expect(renderHelp()).toContain("kuebiko [options]");
		expect(renderHelp()).toContain("--no-plugins");
	});
});

describe("awaitShutdown", () => {
	// The listeners used to stay installed after the race, overriding the default handling.
	// The first Ctrl-C during teardown therefore did nothing at all.
	it("removes its listeners when the logger closes first", async () => {
		const before = {
			message: process.listenerCount("message"),
			sigint: process.listenerCount("SIGINT"),
			sigterm: process.listenerCount("SIGTERM"),
		};

		await awaitShutdown(Promise.resolve());

		expect(process.listenerCount("SIGINT")).toBe(before.sigint);
		expect(process.listenerCount("SIGTERM")).toBe(before.sigterm);
		expect(process.listenerCount("message")).toBe(before.message);
	});

	it("removes its listeners when the shutdown request wins", async () => {
		const before = process.listenerCount("SIGINT");
		const never = Promise.withResolvers<void>();
		const shutdown = awaitShutdown(never.promise);

		process.emit("message", "shutdown");
		await shutdown;

		expect(process.listenerCount("SIGINT")).toBe(before);
	});
});

describe("stopRun", () => {
	// The snapshot needs both the browser and the CDP connection, which the steps
	// After it take away, so its place in this order is the whole design.
	it("snapshots storage before the plugins stop and the browser closes", async () => {
		const calls: string[] = [];
		const record = (name: string) => (): Promise<void> => {
			calls.push(name);
			return Promise.resolve();
		};

		await stopRun({
			browser: { close: record("browser.close") },
			logger: {
				close: record("logger.close"),
				closeBrowser: record("logger.closeBrowser"),
				snapshotStorage: record("logger.snapshotStorage"),
			},
			plugins: { close: record("plugins.close"), stopping: record("plugins.stopping") },
			storage: { close: record("storage.close"), summary: { render: () => "summary responses=0" } },
		} as unknown as Parameters<typeof stopRun>[0]);

		expect(calls).toEqual([
			"logger.snapshotStorage",
			"plugins.stopping",
			"browser.close",
			"logger.close",
			"plugins.close",
			"storage.close",
		]);
	});

	// A teardown step that throws is reported, not rethrown, so the rest still runs.
	it("keeps stopping after a failing snapshot", async () => {
		const calls: string[] = [];
		const record = (name: string) => (): Promise<void> => {
			calls.push(name);
			return Promise.resolve();
		};

		await stopRun({
			logger: {
				close: record("logger.close"),
				closeBrowser: record("logger.closeBrowser"),
				snapshotStorage: () => Promise.reject(new Error("snapshot failed")),
			},
			plugins: { close: record("plugins.close"), stopping: record("plugins.stopping") },
		} as unknown as Parameters<typeof stopRun>[0]);

		expect(calls).toEqual(["plugins.stopping", "logger.close", "plugins.close"]);
	});
});

// Long enough that a slow machine never trips it, short enough to land before the test timeout.
const EXIT_TIMEOUT_MS = 3_000;

describe("forceQuitOnSignal", () => {
	// Teardown takes as long as the browser makes it take, so a second signal leaves at once.
	// That drops the summary and aborts the writes in flight, which is the trade asked for.
	// The trade only holds if the handler really does exit.
	it("exits on the next signal instead of waiting for teardown", async () => {
		const moduleUrl = pathToFileURL(join(import.meta.dir, "index.ts")).href;
		const script = `
			import { forceQuitOnSignal } from ${JSON.stringify(moduleUrl)};

			forceQuitOnSignal();
			process.stdout.write("armed");
			setInterval(() => {}, 1_000);
		`;
		const child = Bun.spawn([process.execPath, "-e", script], {
			stderr: "pipe",
			stdout: "pipe",
		});
		if (!(child.stdout instanceof ReadableStream) || !(child.stderr instanceof ReadableStream)) {
			throw new Error("The helper process was spawned without pipes.");
		}
		// A handler that stopped exiting would hang this wait forever.
		// So would a platform that never delivers the signal at all.
		// Bounding the wait fails the assertion instead of taking the test process down.
		try {
			const reader = child.stdout.getReader();
			await reader.read();
			reader.releaseLock();

			child.kill("SIGINT");

			expect(await settlesWithin(child.exited, EXIT_TIMEOUT_MS)).toBe(true);
			// 130 is the shell's own code for a process ended by SIGINT.
			expect(child.exitCode).toBe(130);
			await expect(new Response(child.stderr).text()).resolves.toContain(
				"shutdown interrupted; exiting now",
			);
		} finally {
			// A helper left running would outlive the suite whatever the assertions did.
			child.kill("SIGKILL");
		}
	});

	// The handler is removed once teardown is over.
	// A signal after the run then behaves the way it does in any other process.
	it("removes its listeners when teardown finishes", () => {
		const before = process.listenerCount("SIGINT");

		forceQuitOnSignal()();

		expect(process.listenerCount("SIGINT")).toBe(before);
	});
});
