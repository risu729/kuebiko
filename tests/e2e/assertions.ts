import { expect } from "bun:test";
import { join } from "node:path";

import waitFor from "./poll";

type CapturedApiRecord = {
	bodyFile: string;
	bodySaved?: boolean | undefined;
	requestBodyFile: string;
	requestBodySaved?: boolean | undefined;
	requestMethod?: string | undefined;
};

type NetLogRecord = {
	constants?: unknown;
	events?: unknown;
};

const NETLOG_READ_TIMEOUT_MS = 30_000;

const readCapturedBodies = async (
	captureDirectory: string,
	metadata: CapturedApiRecord,
): Promise<{ requestBody: string; responseBody: string }> => ({
	requestBody: await Bun.file(join(captureDirectory, metadata.requestBodyFile)).text(),
	responseBody: await Bun.file(join(captureDirectory, metadata.bodyFile)).text(),
});

const assertCapturedApi = (
	metadata: CapturedApiRecord,
	bodies: { requestBody: string; responseBody: string },
): void => {
	expect(metadata.bodySaved).toBe(true);
	expect(metadata.requestBodySaved).toBe(true);
	expect(metadata.requestMethod).toBe("POST");
	expect(JSON.parse(bodies.responseBody)).toEqual({
		ok: true,
		posted: { hello: "from-page" },
		source: "cdp-e2e",
	});
	expect(JSON.parse(bodies.requestBody)).toEqual({ hello: "from-page" });
};

const readNetLog = async (path: string): Promise<NetLogRecord> =>
	await waitFor(
		"complete NetLog JSON",
		async () => {
			const file = Bun.file(path);
			if (!(await file.exists()) || file.size === 0) {
				return undefined;
			}

			const content = await file.text();
			return content.trim() ? (JSON.parse(content) as NetLogRecord) : undefined;
		},
		{ deadline: Date.now() + NETLOG_READ_TIMEOUT_MS },
	);

const assertNetLog = (netLog: NetLogRecord): void => {
	expect(netLog.constants).toBeDefined();
	expect(Array.isArray(netLog.events)).toBe(true);
};

export { assertCapturedApi, assertNetLog, readCapturedBodies, readNetLog };
export type { CapturedApiRecord };
