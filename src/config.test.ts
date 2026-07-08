import { describe, expect, it } from "bun:test";

import { defineConfig } from "./config";

describe("defineConfig", () => {
	it("returns a typed logger config", () => {
		const config = defineConfig({
			plugins: [
				{
					enabled: true,
					module: "./plugins/json-api-mirror.ts",
					options: { directory: "json" },
					queueSize: 10,
					timeoutMs: 500,
				},
			],
		});

		expect(config.plugins?.[0]?.module).toBe("./plugins/json-api-mirror.ts");
	});

	it("validates plugin entries at definition time", () => {
		expect(() =>
			defineConfig({
				plugins: [{ module: "./plugin.ts", timeoutMs: 0 }],
			}),
		).toThrow();
	});

	it("rejects unknown config keys", () => {
		expect(() =>
			defineConfig({
				plugins: [{ module: "./plugin.ts" }],
				typo: true,
			} as never),
		).toThrow();
	});
});
