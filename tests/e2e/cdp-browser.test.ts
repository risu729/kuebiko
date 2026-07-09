import { afterEach, describe } from "bun:test";

import { assertCapturedApi, assertNetLog, readCapturedBodies, readNetLog } from "./assertions";
import {
	cleanupRuns,
	closeContext,
	findCapturedApiRecord,
	loadPageAndWaitForCapture,
	maybeBrowserIt,
	startContext,
} from "./cdp-fixture";

const BROWSER_E2E_TIMEOUT_MS = 120_000;

describe("CDP browser e2e", () => {
	afterEach(cleanupRuns);

	maybeBrowserIt(
		"captures localhost payloads and writes Chromium NetLog from the CLI",
		async () => {
			const context = await startContext();

			try {
				await loadPageAndWaitForCapture(context);
				const metadata = await findCapturedApiRecord(context.captureDirectory);
				const bodies = await readCapturedBodies(context.captureDirectory, metadata);
				assertCapturedApi(metadata, bodies);
			} finally {
				await closeContext(context);
			}

			assertNetLog(await readNetLog(context.netLogPath));
		},
		BROWSER_E2E_TIMEOUT_MS,
	);
});
