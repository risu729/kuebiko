import { expect } from "bun:test";
import { join } from "node:path";

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

const readNetLog = async (path: string): Promise<NetLogRecord> => {
	const file = Bun.file(path);
	if (!(await file.exists())) {
		throw new Error(`NetLog file does not exist: ${path}`);
	}

	const contents = (await file.text()).trim();
	if (!contents) {
		throw new Error(`NetLog file is empty and may not have been finalized: ${path}`);
	}

	try {
		return JSON.parse(contents) as NetLogRecord;
	} catch (error) {
		throw new Error(`NetLog file contains incomplete or invalid JSON: ${path}`, {
			cause: error,
		});
	}
};

const assertNetLog = (netLog: NetLogRecord): void => {
	expect(netLog.constants).toBeDefined();
	expect(Array.isArray(netLog.events)).toBe(true);
};

export { assertCapturedApi, assertNetLog, readCapturedBodies, readNetLog };
export type { CapturedApiRecord };
