import { describe, expect, it } from "bun:test";

import {
	DEFAULT_CDP_ENDPOINT,
	awaitShutdown,
	getRunAnnotations,
	parseArgs,
	renderHelp,
	stopRun,
} from "./index";

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

	// Every browser arg starts with a dash, so treating the value as a flag of its own
	// Replaced node:util's advice about the `--flag=-value` spelling with a wrong one.
	it("leaves a dashed flag value to node:util to diagnose", () => {
		expect(() => parseArgs(["--browser-arg", "--no-sandbox"])).toThrow(/ambiguous/u);
		expect(() => parseArgs(["--exclude", "-tracking"])).toThrow(/ambiguous/u);
		expect(() => parseArgs(["--note", "-note text"])).toThrow(/ambiguous/u);
		expect(() => parseArgs(["--browser-arg=--no-sandbox", "--wat"])).toThrow(
			"Unknown argument: --wat",
		);
	});

	// Blank silently disabled every plugin, and --out silently fell back to the default
	// Capture root, so a wrapper passing an unset variable lost either without a word.
	it("rejects a blank config path and capture directory", () => {
		expect(() => parseArgs(["--config", ""])).toThrow("--config must not be empty.");
		expect(() => parseArgs(["--out", ""])).toThrow("--out must not be empty.");
	});

	// The same unset variable in a wrapper script captured exactly the traffic --exclude
	// Named, lifted the body cap, and launched into the default browser profile.
	it("rejects a blank value for every flag that takes one", () => {
		for (const flag of [
			"--browser-command",
			"--browser-path",
			"--browser-profile",
			"--cdp-port",
			"--exclude",
			"--include",
			"--max-body-bytes",
		]) {
			expect(() => parseArgs([flag, ""])).toThrow(`${flag} must not be empty.`);
		}
	});

	// Launch mode connects to --cdp-port, so an endpoint given here was discarded and
	// Run.json recorded a port the invocation never named.
	// The flag is what conflicts, not the endpoint: comparing values accepted the default
	// Spelled out and rejected the one spelling that agrees with --cdp-port.
	it("rejects an endpoint given together with launch mode", () => {
		const launch = ["--launch-browser", "--browser-command", "chrome"];
		for (const endpoint of ["http://127.0.0.1:9999", "http://127.0.0.1:9222"]) {
			expect(() => parseArgs([...launch, "--cdp", endpoint])).toThrow(
				"Use --cdp-port instead of --cdp with --launch-browser.",
			);
		}
		expect(() =>
			parseArgs([...launch, "--cdp-port", "9333", "--cdp", "http://127.0.0.1:9333"]),
		).toThrow("Use --cdp-port instead of --cdp with --launch-browser.");
		// Attach mode still takes the flag, and launch mode without it still parses.
		expect(parseArgs([...launch, "--cdp-port", "9333"]).cdpPort).toBe(9333);
		expect(parseArgs(["--cdp", "http://127.0.0.1:9333"]).cdp).toBe("http://127.0.0.1:9333");
	});

	// Number() also accepts exponents, hex, and padding, so a typo became a silent cap.
	it("rejects integers that are not written in decimal", () => {
		for (const value of ["1e3", "0x10", " 12 ", "12.0"]) {
			expect(() => parseArgs(["--max-body-bytes", value])).toThrow(
				"--max-body-bytes must be an integer greater than or equal to 0.",
			);
		}
		expect(() => parseArgs(["--cdp-port", "0x10"])).toThrow(
			"--cdp-port must be an integer greater than or equal to 1.",
		);
		expect(parseArgs(["--max-body-bytes", "1000"]).maxBodyBytes).toBe(1_000);
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

	// The flag name was negated but its description was not, so help stated the opposite
	// Of what the flag does, and the widest flags pushed their descriptions out of line.
	it("describes negated flags by what turning them off does", () => {
		const lines = renderHelp().split("\n");
		const lineFor = (flag: string): string =>
			lines.find((line) => line.trimStart().startsWith(`${flag} `)) ?? "";

		expect(lineFor("--no-plugins")).toContain("Disable plugin loading from --config.");
		expect(lineFor("--no-netlog")).toContain("Disable netlog.json in --launch-browser mode.");
		expect(lineFor("--no-netlog")).not.toContain("Write netlog.json");

		// The width used to cut off at the flag, so the widest ones ran into their text.
		const described = lines.filter((line) => line.startsWith("  --"));
		const columns = new Set(
			described.map((line) => /^ {2}\S.*? {2,}(?=\S)/u.exec(line)?.[0].length),
		);
		expect(described.length).toBeGreaterThan(0);
		expect(columns.size).toBe(1);
		expect(columns.has(undefined)).toBe(false);
	});
});

describe("getRunAnnotations", () => {
	// A filtered run used to write a run.json byte-identical to an unfiltered one, so
	// Nothing in the directory said whether what is missing was ever requested.
	it("records the flags that decide how complete the capture is", () => {
		const options = parseArgs([
			"--include",
			"^https://api\\.",
			"--exclude",
			"tracking",
			"--max-body-bytes",
			"2048",
			"--launch-browser",
			"--browser-command",
			"chrome",
		]);

		expect(getRunAnnotations(options)).toMatchObject({
			exclude: "tracking",
			// RegExp.source escapes the separators, and it still recompiles as written.
			include: "^https:\\/\\/api\\.",
			maxBodyBytes: 2_048,
			netlog: true,
		});
	});

	// Only launch mode writes one, so the default --netlog alone must not claim it did.
	it("reports no NetLog for an attach-mode run", () => {
		expect(getRunAnnotations(parseArgs([]))).toMatchObject({ netlog: false });
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
