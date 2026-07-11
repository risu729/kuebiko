import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import type { LoggerPlugin } from "kuebiko";

export default {
	id: "json-api-mirror",
	name: "JSON API Mirror",
	version: "0.1.0",
	events: ["response.completed"],

	async setup(ctx) {
		await mkdir(ctx.pluginDirectory, { recursive: true });
	},

	async onEvent(event, ctx) {
		if (event.event !== "response.completed") {
			return;
		}

		if (!event.response.bodyFile || !event.response.mimeType?.includes("json")) {
			return;
		}

		const source = ctx.resolveRunPath(event.response.bodyFile);
		const safeRequestId = event.request.requestId.replace(/[^A-Za-z0-9._-]/gu, "_");
		const output = ctx.resolvePluginPath(`${safeRequestId}.json`);
		await mkdir(dirname(output), { recursive: true });
		await Bun.write(output, Bun.file(source));
	},
} satisfies LoggerPlugin;
