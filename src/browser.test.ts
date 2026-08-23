import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
	assertCdpEndpointFree,
	buildBrowserArgs,
	createCdpEndpoint,
	discardBrowserStderr,
	terminateBrowser,
	waitForExit,
} from "./browser";

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

const servePort = (server: ReturnType<typeof Bun.serve>): number => {
	const { port } = server;
	if (port === undefined) {
		throw new Error("Bun.serve did not allocate a port.");
	}

	return port;
};

const spawnHelper = (source: string): ReturnType<typeof Bun.spawn> =>
	Bun.spawn([process.execPath, "-e", source], { stderr: "pipe", stdout: "ignore" });

const waitForReady = async (child: ReturnType<typeof Bun.spawn>): Promise<void> => {
	if (!(child.stdout instanceof ReadableStream)) {
		throw new Error("The helper process was spawned without a stdout pipe.");
	}
	const reader = child.stdout.getReader();
	await reader.read();
	reader.releaseLock();
};

describe("waitForExit", () => {
	it("answers false once the deadline passes", async () => {
		const browser = spawnHelper("setInterval(() => {}, 1_000);");

		try {
			expect(await waitForExit(browser, 50)).toBe(false);
		} finally {
			browser.kill("SIGKILL");
			await browser.exited;
		}
	});

	// A pending Bun.sleep from the losing side of the race kept the whole process alive
	// For the rest of its deadline, so every launch-mode Ctrl-C printed the summary and
	// Then sat idle for seconds before returning to the shell.
	it("does not hold the process open after the browser exits", async () => {
		const moduleUrl = pathToFileURL(join(import.meta.dir, "browser.ts")).href;
		const script = `
			import { waitForExit } from ${JSON.stringify(moduleUrl)};

			const child = Bun.spawn([process.execPath, "-e", ""], { stderr: "pipe", stdout: "ignore" });
			await waitForExit(child, 10_000);
		`;
		const started = Date.now();
		const runner = spawnHelper(script);
		await runner.exited;

		expect(Date.now() - started).toBeLessThan(5_000);
	});
});

describe("terminateBrowser", () => {
	// SIGTERM is a request a browser may ignore, and the startup failure path used to
	// Wait for it with no deadline at all, hanging the run with a live browser.
	it("escalates to SIGKILL when the browser ignores SIGTERM", async () => {
		const browser = Bun.spawn(
			[
				process.execPath,
				"-e",
				"process.on('SIGTERM', () => {}); process.stdout.write('ready'); setInterval(() => {}, 1_000);",
			],
			{ stderr: "pipe", stdout: "pipe" },
		);
		// The handler is only installed once the child runs, so the signal waits for it.
		await waitForReady(browser);

		await terminateBrowser(browser, 50);
		await browser.exited;

		expect(browser.signalCode).toBe("SIGKILL");
	});

	it("returns as soon as SIGTERM is enough", async () => {
		const browser = spawnHelper("setInterval(() => {}, 1_000);");

		await terminateBrowser(browser, 5_000);
		await browser.exited;

		expect(browser.signalCode).toBe("SIGTERM");
	});
});

describe("discardBrowserStderr", () => {
	// Nothing reads the pipe once the browser is up, so the unread bytes used to pile up
	// In this process for the whole capture.
	it("consumes the stderr pipe until the browser exits", async () => {
		const browser = spawnHelper(
			"for (let index = 0; index < 2_000; index += 1) { process.stderr.write('noise'.repeat(100) + '\\n'); }",
		);

		await expect(discardBrowserStderr(browser)).resolves.toBeUndefined();
		await browser.exited;
	});
});

describe("assertCdpEndpointFree", () => {
	it("resolves when nothing is listening", async () => {
		const server = Bun.serve({ fetch: () => new Response("x"), hostname: "127.0.0.1", port: 0 });
		const port = servePort(server);
		server.stop(true);

		await expect(assertCdpEndpointFree(createCdpEndpoint(port))).resolves.toBeUndefined();
	});

	it("rejects when a browser already serves the debugging port", async () => {
		const server = Bun.serve({
			fetch: () => Response.json({ Browser: "Chrome/151.0.0.0" }),
			hostname: "127.0.0.1",
			port: 0,
		});

		try {
			await expect(assertCdpEndpointFree(createCdpEndpoint(servePort(server)))).rejects.toThrow(
				/already listening/u,
			);
		} finally {
			server.stop(true);
		}
	});

	it("rejects when a listener answers without being a CDP endpoint", async () => {
		const server = Bun.serve({
			fetch: () => new Response("<html>", { status: 404 }),
			hostname: "127.0.0.1",
			port: 0,
		});

		try {
			await expect(assertCdpEndpointFree(createCdpEndpoint(servePort(server)))).rejects.toThrow(
				/already listening/u,
			);
		} finally {
			server.stop(true);
		}
	});

	it("rejects instead of hanging when a listener never answers", async () => {
		const server = Bun.serve({
			fetch: async () => {
				await Bun.sleep(1_000);
				return new Response("too late");
			},
			hostname: "127.0.0.1",
			port: 0,
		});

		try {
			await expect(
				assertCdpEndpointFree(createCdpEndpoint(servePort(server)), 200),
			).rejects.toThrow(/already listening/u);
		} finally {
			server.stop(true);
		}
	});
});
