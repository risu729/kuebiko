import { finishesWithin, resolvesWithin } from "./timeout";

type BrowserProcess = ReturnType<typeof Bun.spawn>;

type BrowserVersion = {
	webSocketDebuggerUrl?: string | undefined;
};

type BrowserCloseOutcome = "exited" | "failed" | "requested" | "timeout";

type BrowserLaunchOptions = {
	browserArgs: string[];
	browserCommand?: string | undefined;
	browserPath?: string | undefined;
	cdpPort: number;
	netLogPath?: string | undefined;
	profileDirectory: string;
	verbose: boolean;
};

type StartedBrowser = {
	cdpEndpoint: string;
	close: (requestClose?: () => Promise<void>) => Promise<void>;
};

const BROWSER_STOP_TIMEOUT_MS = 5_000;
const CDP_READY_TIMEOUT_MS = 15_000;
const CDP_READY_POLL_MS = 100;
// Bound every probe so a stalled peer cannot hang startup past its deadline.
const CDP_PROBE_TIMEOUT_MS = 2_000;

const createCdpEndpoint = (port: number): string => `http://127.0.0.1:${port}`;

const getBrowserExecutable = (options: BrowserLaunchOptions): string => {
	const executable = options.browserPath ?? options.browserCommand;
	if (!executable) {
		throw new Error("--launch-browser requires --browser-command or --browser-path.");
	}

	return executable;
};

const buildBrowserArgs = (options: BrowserLaunchOptions): string[] => {
	const args = [
		...options.browserArgs,
		`--user-data-dir=${options.profileDirectory}`,
		"--remote-debugging-address=127.0.0.1",
		`--remote-debugging-port=${options.cdpPort}`,
	];

	if (options.netLogPath) {
		args.push(`--log-net-log=${options.netLogPath}`, "--net-log-capture-mode=Everything");
	}

	return args;
};

const fetchBrowserVersion = async (cdpEndpoint: string): Promise<BrowserVersion> => {
	const response = await fetch(`${cdpEndpoint}/json/version`, {
		signal: AbortSignal.timeout(CDP_PROBE_TIMEOUT_MS),
	});
	if (!response.ok) {
		throw new Error(`CDP version endpoint returned ${response.status}.`);
	}

	return (await response.json()) as BrowserVersion;
};

// Chrome hands off and exits when another browser already holds the profile.
// The browser already there keeps serving the port, so waitForCdp still succeeds.
// Capture would then run against a browser this process does not own, and the
// NetLog it asked for would never be written.
//
// Any answer means the port is taken, so fetchBrowserVersion is not reused here.
// A peer replying 404, serving HTML, or stalling still owns that port.
// Only a connection that cannot be established is evidence the port is free.
// An unrecognized transport failure therefore falls through to spawning.
const assertCdpEndpointFree = async (
	cdpEndpoint: string,
	timeoutMs = CDP_PROBE_TIMEOUT_MS,
): Promise<void> => {
	try {
		await fetch(`${cdpEndpoint}/json/version`, { signal: AbortSignal.timeout(timeoutMs) });
	} catch (error) {
		if ((error as { name?: string }).name !== "TimeoutError") {
			return;
		}
	}

	throw new Error(
		`A browser is already listening on ${cdpEndpoint}. Launch mode needs a port of its own; ` +
			`stop that browser, pass a different --cdp-port, or attach to it with --cdp ${cdpEndpoint}.`,
	);
};

const waitForCdp = async (
	cdpEndpoint: string,
	deadline = Date.now() + CDP_READY_TIMEOUT_MS,
): Promise<void> => {
	try {
		await fetchBrowserVersion(cdpEndpoint);
	} catch (error) {
		if (Date.now() >= deadline) {
			throw new Error(`Browser did not expose CDP at ${cdpEndpoint}.`, { cause: error });
		}
		await Bun.sleep(CDP_READY_POLL_MS);
		await waitForCdp(cdpEndpoint, deadline);
	}
};

const exited = async (browser: BrowserProcess): Promise<boolean> => {
	await browser.exited;
	return true;
};

// Bounded on a timer rather than a sleep: a sleep left pending once the browser has
// Exited keeps this process alive for the rest of its deadline, long after the run.
const waitForExit = async (browser: BrowserProcess, timeout: number): Promise<boolean> =>
	await resolvesWithin(exited(browser), timeout, false);

const requestCloseOutcome = async (
	requestClose: () => Promise<void>,
): Promise<BrowserCloseOutcome> => {
	try {
		await requestClose();
		return "requested";
	} catch {
		return "failed";
	}
};

const exitOutcome = async (browser: BrowserProcess): Promise<BrowserCloseOutcome> => {
	await browser.exited;
	return "exited";
};

const beginBrowserClose = async (
	browser: BrowserProcess,
	requestClose?: () => Promise<void>,
): Promise<boolean> => {
	if (!requestClose) {
		browser.kill("SIGTERM");
		return false;
	}

	const outcome = await resolvesWithin<BrowserCloseOutcome>(
		Promise.race([requestCloseOutcome(requestClose), exitOutcome(browser)]),
		BROWSER_STOP_TIMEOUT_MS,
		"timeout",
	);
	if (outcome !== "exited" && outcome !== "requested") {
		browser.kill("SIGTERM");
	}

	return outcome === "exited";
};

const readBrowserStderr = async (browser: BrowserProcess): Promise<string> => {
	if (!(browser.stderr instanceof ReadableStream)) {
		return "";
	}

	return await new Response(browser.stderr).text();
};

// Every wait on a browser this process owns is bounded, and SIGTERM is a request a
// Browser may ignore, so the escalation to SIGKILL belongs to each path that sends it.
const terminateBrowser = async (
	browser: BrowserProcess,
	timeout = BROWSER_STOP_TIMEOUT_MS,
): Promise<void> => {
	browser.kill("SIGTERM");
	if (await waitForExit(browser, timeout)) {
		return;
	}

	browser.kill("SIGKILL");
	browser.unref();
};

// The stderr pipe exists for the startup failure path, and nothing reads it once the
// Browser is up. Bun keeps the unread bytes in this process, so a capture running for
// Hours would accumulate every diagnostic Chrome writes. They are discarded instead.
const discardBrowserStderr = async (browser: BrowserProcess): Promise<void> => {
	if (!(browser.stderr instanceof ReadableStream)) {
		return;
	}

	try {
		await browser.stderr.pipeTo(new WritableStream());
	} catch {
		// The stream ends with the browser process, which is not a capture failure.
	}
};

const closeBrowser = async (
	browser: BrowserProcess,
	requestClose?: () => Promise<void>,
): Promise<void> => {
	if (await beginBrowserClose(browser, requestClose)) {
		return;
	}

	if (await waitForExit(browser, BROWSER_STOP_TIMEOUT_MS)) {
		return;
	}

	await terminateBrowser(browser);
};

const spawnBrowser = (options: BrowserLaunchOptions): BrowserProcess => {
	const executable = getBrowserExecutable(options);
	const args = buildBrowserArgs(options);

	return Bun.spawn([executable, ...args], {
		stderr: "pipe",
		stdout: options.verbose ? "inherit" : "ignore",
	});
};

const waitForStartedBrowser = async (
	browser: BrowserProcess,
	cdpEndpoint: string,
): Promise<void> => {
	try {
		await waitForCdp(cdpEndpoint);
	} catch (error) {
		// A browser that never exposed CDP may also ignore SIGTERM, and an unbounded wait
		// Here would hang the run with no error, no summary, and a live browser process.
		await terminateBrowser(browser);
		const stderr = await readBrowserStderr(browser);
		throw new Error(`Browser failed to expose CDP at ${cdpEndpoint}. Stderr: ${stderr}`, {
			cause: error,
		});
	}
};

const startBrowser = async (options: BrowserLaunchOptions): Promise<StartedBrowser> => {
	const cdpEndpoint = createCdpEndpoint(options.cdpPort);
	await assertCdpEndpointFree(cdpEndpoint);
	const browser = spawnBrowser(options);
	await waitForStartedBrowser(browser, cdpEndpoint);
	const discarding = discardBrowserStderr(browser);

	return {
		cdpEndpoint,
		close: async (requestClose) => {
			await closeBrowser(browser, requestClose);
			// The stream ends with the process; the bound is for a pipe that somehow does not.
			await finishesWithin(discarding, BROWSER_STOP_TIMEOUT_MS);
		},
	};
};

export {
	assertCdpEndpointFree,
	buildBrowserArgs,
	createCdpEndpoint,
	discardBrowserStderr,
	startBrowser,
	terminateBrowser,
	waitForExit,
};
export type { BrowserLaunchOptions, StartedBrowser };
