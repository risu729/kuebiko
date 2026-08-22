import { describe, expect, it } from "bun:test";

import { assertCdpEndpointFree, buildBrowserArgs, createCdpEndpoint } from "./browser";

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
