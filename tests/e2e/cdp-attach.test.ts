import { afterEach, describe } from "bun:test";

import { assertCapturedApi, readCapturedBodies } from "./assertions";
import { cleanupAttachRuns, closeAttachContext, startAttachContext } from "./cdp-attach-fixture";
import { findCapturedApiRecord, loadPageAndWaitForCapture, maybeBrowserIt } from "./cdp-fixture";

const BROWSER_E2E_TIMEOUT_MS = 30_000;

describe("CDP attach-mode browser e2e", () => {
	afterEach(cleanupAttachRuns);

	maybeBrowserIt(
		"captures localhost payloads from a separately started browser",
		async () => {
			const context = await startAttachContext();

			try {
				await loadPageAndWaitForCapture(context);
				const metadata = await findCapturedApiRecord(context.captureDirectory);
				const bodies = await readCapturedBodies(context.captureDirectory, metadata);
				assertCapturedApi(metadata, bodies);
			} finally {
				await closeAttachContext(context);
			}
		},
		BROWSER_E2E_TIMEOUT_MS,
	);
});
