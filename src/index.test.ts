import { describe, expect, it } from "bun:test";

import { DEFAULT_CDP_ENDPOINT, awaitShutdown, parseArgs, renderHelp, stopRun } from "./index";

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
	// The listeners used to stay installed after the race, overriding the default signal
	// Disposition, so the first Ctrl-C during teardown did nothing at all.
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
