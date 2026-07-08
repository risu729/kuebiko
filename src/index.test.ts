import { describe, expect, it } from "bun:test";

import { DEFAULT_CDP_ENDPOINT, parseArgs, renderHelp } from "./index";

describe("parseArgs", () => {
	it("uses defaults", () => {
		expect(parseArgs([])).toEqual({
			browserArgs: [],
			cdp: DEFAULT_CDP_ENDPOINT,
			cdpPort: 9222,
			help: false,
			launchBrowser: false,
			netlog: true,
			noPlugins: false,
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
		expect(renderHelp()).toContain("cdp-response-logger [options]");
		expect(renderHelp()).toContain("--no-plugins");
	});
});
