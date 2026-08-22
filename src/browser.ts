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
	const response = await fetch(`${cdpEndpoint}/json/version`);
	if (!response.ok) {
		throw new Error(`CDP version endpoint returned ${response.status}.`);
	}

	return (await response.json()) as BrowserVersion;
};

// Chrome hands off and exits when another browser already holds the profile.
// The browser already there keeps serving the port, so waitForCdp still succeeds.
// Capture would then run against a browser this process does not own, and the
// NetLog it asked for would never be written.
const assertCdpEndpointFree = async (cdpEndpoint: string): Promise<void> => {
	try {
		await fetchBrowserVersion(cdpEndpoint);
	} catch {
		return;
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

const waitForExit = async (browser: BrowserProcess, timeout?: number): Promise<boolean> =>
	await Promise.race([
		browser.exited.then(() => true),
		...(timeout === undefined ? [] : [Bun.sleep(timeout).then(() => false)]),
	]);

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

const timeoutOutcome = async (): Promise<BrowserCloseOutcome> => {
	await Bun.sleep(BROWSER_STOP_TIMEOUT_MS);
	return "timeout";
};

const beginBrowserClose = async (
	browser: BrowserProcess,
	requestClose?: () => Promise<void>,
): Promise<boolean> => {
	if (!requestClose) {
		browser.kill("SIGTERM");
		return false;
	}

	const outcome = await Promise.race([
		requestCloseOutcome(requestClose),
		exitOutcome(browser),
		timeoutOutcome(),
	]);
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

	browser.kill("SIGTERM");
	if (await waitForExit(browser, BROWSER_STOP_TIMEOUT_MS)) {
		return;
	}

	browser.kill("SIGKILL");
	browser.unref();
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
		browser.kill("SIGTERM");
		await waitForExit(browser);
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

	return {
		cdpEndpoint,
		close: async (requestClose) => {
			await closeBrowser(browser, requestClose);
		},
	};
};

export { assertCdpEndpointFree, buildBrowserArgs, createCdpEndpoint, startBrowser };
export type { BrowserLaunchOptions, StartedBrowser };
