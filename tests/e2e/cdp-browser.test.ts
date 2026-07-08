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

describe("CDP browser e2e", () => {
	afterEach(cleanupRuns);

	maybeBrowserIt(
		"captures a localhost JSON response and request payload from the CLI",
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
		},
	);

	maybeBrowserIt("writes Chromium NetLog in the capture directory", async () => {
		const context = await startContext();

		try {
			await loadPageAndWaitForCapture(context);
		} finally {
			await closeContext(context);
		}

		assertNetLog(await readNetLog(context.netLogPath));
	});
});
