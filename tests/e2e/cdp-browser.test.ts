import { afterEach, describe } from "bun:test";

import {
	assertCapturedApi,
	assertCapturedEventSourceMessages,
	assertCapturedRawHeaders,
	assertCapturedWebSocketFrames,
	assertNetLog,
	assertRunSummary,
	readCapturedBodies,
	readNetLog,
} from "./assertions";
import {
	cleanupRuns,
	closeContext,
	findCapturedApiRecord,
	findEventSourceMessages,
	findWebSocketFrames,
	loadPageAndWaitForCapture,
	maybeBrowserIt,
	startContext,
} from "./cdp-fixture";
import type { TestContext } from "./cdp-fixture";

const BROWSER_E2E_TIMEOUT_MS = 30_000;

const assertCapturedTraffic = async (context: TestContext): Promise<void> => {
	const metadata = await findCapturedApiRecord(context.captureDirectory);
	assertCapturedApi(metadata, await readCapturedBodies(context.captureDirectory, metadata));
	assertCapturedRawHeaders(metadata);
	assertCapturedWebSocketFrames(
		await findWebSocketFrames(context.captureDirectory),
		`ws://127.0.0.1:${context.fixtureServer.port}/socket`,
	);
	assertCapturedEventSourceMessages(
		await findEventSourceMessages(context.captureDirectory),
		`http://127.0.0.1:${context.fixtureServer.port}/events`,
	);
};

describe("CDP launch-mode browser e2e", () => {
	afterEach(cleanupRuns);

	maybeBrowserIt(
		"captures localhost payloads and writes Chromium NetLog from the CLI",
		async () => {
			const context = await startContext();

			try {
				await loadPageAndWaitForCapture(context);
				await assertCapturedTraffic(context);
			} finally {
				await closeContext(context);
			}

			assertRunSummary(await context.loggerStdout.completed);
			assertNetLog(await readNetLog(context.netLogPath));
		},
		BROWSER_E2E_TIMEOUT_MS,
	);
});
