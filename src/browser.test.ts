import { describe, expect, it } from "bun:test";

import { buildBrowserArgs, createCdpEndpoint } from "./browser";

describe("buildBrowserArgs", () => {
	it("uses only profile, local CDP, and NetLog flags", () => {
		expect(
			buildBrowserArgs({
				browserArgs: [],
				browserCommand: "chrome.exe",
				cdpPort: 9222,
				netLogPath: "C:\\captures\\run\\netlog.json",
				profileDirectory: "C:\\profile",
				verbose: false,
			}),
		).toEqual([
			"--user-data-dir=C:\\profile",
			"--remote-debugging-address=127.0.0.1",
			"--remote-debugging-port=9222",
			"--log-net-log=C:\\captures\\run\\netlog.json",
			"--net-log-capture-mode=Everything",
		]);
	});

	it("omits NetLog flags when disabled", () => {
		expect(
			buildBrowserArgs({
				browserArgs: [],
				browserCommand: "chrome",
				cdpPort: 9333,
				profileDirectory: "/profile",
				verbose: false,
			}),
		).toEqual([
			"--user-data-dir=/profile",
			"--remote-debugging-address=127.0.0.1",
			"--remote-debugging-port=9333",
		]);
	});

	it("prepends explicit extra browser args", () => {
		expect(
			buildBrowserArgs({
				browserArgs: ["--no-sandbox"],
				browserCommand: "chrome",
				cdpPort: 9333,
				profileDirectory: "/profile",
				verbose: false,
			}),
		).toEqual([
			"--no-sandbox",
			"--user-data-dir=/profile",
			"--remote-debugging-address=127.0.0.1",
			"--remote-debugging-port=9333",
		]);
	});
});

describe("createCdpEndpoint", () => {
	it("binds to loopback", () => {
		expect(createCdpEndpoint(9223)).toBe("http://127.0.0.1:9223");
	});
});
