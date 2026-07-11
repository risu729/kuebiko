# Kuebiko

Kuebiko is a passive, extensible network capture tool for browsers that expose
the Chrome DevTools Protocol (CDP). It can launch a dedicated browser profile or
attach to an existing local CDP endpoint, then saves request/response bodies
plus metadata while you browse manually. Trusted local plugins can react to
completed captures without changing browser traffic.

This tool is intentionally narrow. It does not use mitmproxy, `SSLKEYLOGFILE`,
packet capture, request interception, browser automation, login automation,
analytics, parsers, dashboards, or HAR viewers.

## What This Is For

Use this when you want raw local capture files from normal manual browsing in a
throwaway browser profile:

- response bodies from CDP `Network.getResponseBody`
- request payloads that the browser exposes through CDP
- request/response metadata in append-only NDJSON
- Chromium NetLog in the same run directory when using browser launch mode

The logger is written in TypeScript for Bun and runs on Windows, Linux, and
macOS. Run the logger on the same OS as the browser whenever possible so it can
connect to `http://127.0.0.1:9222` without cross-VM networking assumptions.

## Why Websites Usually Cannot Notice It

The logger observes the browser locally. The website does not receive a header,
cookie, JavaScript variable, or protocol message saying that CDP logging is
enabled.

Launch mode and the logger are deliberately passive:

- CDP is bound to `127.0.0.1`.
- The logger uses the CDP `Network` domain to observe completed browser network
  activity and fetch stored bodies.
- NetLog writes a local debugging file from the Chromium network stack.
- There is no `Fetch.enable`, request pausing, request rewriting, or response
  rewriting.
- There is no `Runtime.evaluate`, script injection, extension injection, or
  Debugger-domain attachment.
- Launch mode does not use `--headless`, `--enable-automation`, or
  `--remote-debugging-port=0`.
- Launch mode does not use `--disable-quic`; browser network behavior is kept
  close to normal.
- After enabling Network on an attached popup, iframe, or worker target, the
  logger sends `Runtime.runIfWaitingForDebugger` for that target session; it
  does not otherwise use the Runtime domain.

That means a destination site should see ordinary browser requests from the
dedicated profile, not an explicit "logger enabled" signal.

This is not a stealth or evasion guarantee. A site may still notice ordinary
environment differences, such as a fresh profile, missing old cookies, different
cache state, different permissions, no usual extensions, or local timing changes
from heavy logging. Some sites also use broad anti-debugging or automation
heuristics. This project avoids the obvious automation and interception signals;
it does not promise undetectability.

## Quick Start

Launch mode is the recommended path. It starts a browser with the required CDP
and NetLog flags, uses a dedicated profile, and keeps capture files in one run
directory.

Prepare the repository and build the binary:

```sh
mise trust
mise install
mise run compile
```

Run the logger and let it launch your browser:

```sh
dist/kuebiko-linux-x64 \
  --launch-browser \
  --browser-command google-chrome
```

Use another browser command or executable path when needed:

```powershell
.\dist\kuebiko-windows-x64.exe `
  --launch-browser `
  --browser-command chrome.exe
```

```sh
dist/kuebiko-linux-x64 --launch-browser --browser-command chromium
```

```sh
bun src/index.ts --launch-browser \
  --browser-path "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
```

The browser opens with a dedicated profile, CDP bound to `127.0.0.1:9222`, and
NetLog writing to the same capture directory. Log in manually inside that
profile and browse normally.

## Dedicated Profile

Launch mode uses a dedicated profile under the platform default base directory:

- Windows:
  `%LOCALAPPDATA%\Kuebiko\browser-profile`
- macOS:
  `~/Library/Application Support/Kuebiko/browser-profile`
- Linux:
  `${XDG_STATE_HOME:-~/.local/state}/Kuebiko/browser-profile`

The tool does not attach to your default browser profile and does not depend on
it. Treat this profile as a separate browser identity. If a website needs login,
log in manually inside this browser window.

## Output Layout

Each run creates a timestamped directory under the platform capture root:

```text
Kuebiko/captures/2026-07-06T12-34-56
```

The run directory contains:

```text
run.json
metadata.ndjson
errors.ndjson
websocket.ndjson
bodies/
requests/
plugins/
netlog.json
```

`bodies/` contains saved response bodies. `requests/` contains request payloads
that the browser exposes through CDP. Filenames are generated from timestamp,
SHA-256, counter, and MIME-derived extension; URLs are not placed into
filenames.

`plugins/` is created when configured plugins write per-plugin output. The core
logger still only writes raw capture files; plugins are trusted local extension
code you opt into with `--config`.

`metadata.ndjson` contains one JSON object per completed response that passed
the filters. When available, the same metadata line links to both a saved
request payload and a saved response body.

`errors.ndjson` contains per-request capture failures. Individual CDP failures
do not stop the logger.

`netlog.json` is Chromium NetLog for network-stack debugging.

## What Gets Saved

For completed responses, metadata includes request and response fields such as:

- URL, method, request ID, loader ID, target/session identifiers
- request headers and response headers
- status, status text, MIME type, protocol, remote IP/port
- cache/service-worker/prefetch flags where the browser provides them
- encoded data length
- response body path, byte length, SHA-256, and CDP `base64Encoded`
- request body path, byte length, SHA-256, and source when available
- any capture error for body retrieval

Response bodies are saved exactly from CDP's body result:

- `base64Encoded: true` is decoded and written as bytes.
- `base64Encoded: false` is written as UTF-8 bytes.

Request payloads are written as UTF-8 bytes from CDP strings. The logger first
uses inline `request.postData` from `Network.requestWillBeSent` when present. If
the browser only reports `hasPostData`, the logger tries
`Network.getRequestPostData`. This is suitable for JSON, forms, GraphQL, and
other text request bodies. It is not raw upload byte capture, and arbitrary
non-UTF-8 uploads may not round-trip exactly.

CDP bodies are not raw wire bytes. For exact network-stack debugging, use the
companion `netlog.json`.

## Plugins

The plugin system is a core part of Kuebiko. It lets trusted local TypeScript
or JavaScript modules react to completed captures in real time without
duplicating the CDP logger. The logger saves request/response files and metadata
first. Plugins then receive small immutable events containing metadata and
relative file paths.

Plugins run in the logger process. They are not sandboxed third-party code. A
bad plugin cannot mutate requests through the logger API, but it can still use
normal local runtime APIs, CPU, and memory. Plugin failures and queue overflows
are written to `errors.ndjson`; capture continues.

Create a config file:

```ts
import { defineConfig } from "kuebiko";

export default defineConfig({
	plugins: [
		{
			module: "./plugins/json-api-mirror.ts",
			enabled: true,
			timeoutMs: 5000,
			queueSize: 1000,
		},
	],
});
```

`defineConfig` provides TypeScript context and validates plugin config entries
when the config module is evaluated.

Plugin module paths are resolved relative to the config file.

Example plugin:

```ts
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
		if (event.event !== "response.completed") return;
		if (!event.response.bodyFile) return;
		if (!event.response.mimeType?.includes("json")) return;

		const source = ctx.resolveRunPath(event.response.bodyFile);
		const requestIdPattern = /[^A-Za-z0-9._-]/gu;
		const safeRequestId = event.request.requestId.replace(requestIdPattern, "_");
		const output = ctx.resolvePluginPath(`${safeRequestId}.json`);

		await mkdir(dirname(output), { recursive: true });
		await Bun.write(output, Bun.file(source));
	},
} satisfies LoggerPlugin;
```

Run with plugins:

```powershell
kuebiko --config C:\path\logger.config.ts --out <capture-dir>
```

Disable configured plugins for a run:

```powershell
kuebiko --config C:\path\logger.config.ts `
  --no-plugins --out <capture-dir>
```

Supported plugin events are:

- `run.started`
- `run.stopping`
- `run.stopped`
- `response.completed`
- `websocket.frame.received`
- `capture.error`

Hook events do not contain inline request or response bodies. Read saved files
with `ctx.resolveRunPath(event.response.bodyFile)` or the request-body path when
present.

## Verify A Capture

After browsing, check the latest run directory:

```sh
state_home="${XDG_STATE_HOME:-$HOME/.local/state}"
base="${KUEBIKO_BASE_DIR:-$state_home/Kuebiko}"
capture="$(find "$base/captures" -mindepth 1 -maxdepth 1 -type d |
  sort |
  tail -1)"
printf '%s\n' "$capture"
find "$capture/bodies" -type f | wc -l
find "$capture/requests" -type f | wc -l
wc -c "$capture/metadata.ndjson" "$capture/netlog.json"
```

On Windows PowerShell:

```powershell
$capture = Get-ChildItem "$env:LOCALAPPDATA\Kuebiko\captures" |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 1

$capture.FullName
(Get-ChildItem "$($capture.FullName)\bodies" -File -Recurse).Count
(Get-ChildItem "$($capture.FullName)\requests" -File -Recurse).Count
(Get-Item "$($capture.FullName)\metadata.ndjson").Length
(Get-Item "$($capture.FullName)\netlog.json").Length
```

You should see `metadata.ndjson` grow while the logger is running. Normal CDP
misses are recorded in `errors.ndjson`.

## Build

Build the configured binaries:

```sh
mise install
mise run compile
```

Build one target:

```sh
mise run compile --target linux-x64
mise run compile --target windows-x64
```

The output files are:

```text
dist/kuebiko-linux-x64
dist/kuebiko-windows-x64.exe
```

You can also run the TypeScript entrypoint directly with Bun:

```sh
bun src/index.ts --launch-browser --browser-command google-chrome
```

## Browser Modes

Use launch mode first. It is easier to get right because the logger owns the
browser process and supplies the CDP, dedicated-profile, and NetLog flags.

Use attach mode only when you specifically need to connect to a browser you
started yourself, such as an existing profile. That is harder in practice: the
browser must already have been started with `--remote-debugging-port`, and
Chromium-family browsers often reuse an existing profile process instead of
applying new flags. You may need to fully close that profile first or use a
separate profile directory.

### Launch Mode

Launch mode starts the browser, owns the dedicated profile for that run, enables
CDP, writes NetLog by default, starts capture, and closes the browser when the
logger exits.

Use a browser command from `PATH`:

```sh
kuebiko --launch-browser --browser-command google-chrome
```

Or use an explicit browser executable:

```sh
kuebiko --launch-browser \
  --browser-path "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
```

```powershell
kuebiko --launch-browser `
  --browser-path "C:\Program Files\Google\Chrome\Application\chrome.exe"
```

Use an explicit capture directory:

```sh
kuebiko --launch-browser --browser-command google-chrome \
  --out "$HOME/captures/manual-run"
```

Disable NetLog for a run:

```sh
kuebiko --launch-browser --browser-command google-chrome --no-netlog
```

The logger intentionally does not auto-discover browsers. Pass either
`--browser-command` or `--browser-path`. Launch mode uses these browser flags by
default:

```text
--user-data-dir=<profile-dir>
--remote-debugging-address=127.0.0.1
--remote-debugging-port=<port>
--log-net-log=<capture-dir>\netlog.json
--net-log-capture-mode=Everything
```

The NetLog flags are omitted when `--no-netlog` is set.

Pass repeated `--browser-arg=<arg>` values only when your local browser
environment requires them. For example, CI Chrome sometimes requires
`--browser-arg=--no-sandbox`. These extra args are explicit and are not added by
default.

### Attach Mode

Attach mode is for externally launched browsers. Start the browser yourself with
CDP enabled, then run:

```sh
kuebiko --cdp http://127.0.0.1:9222 --out <capture-dir>
```

Attach mode does not launch a browser or write NetLog by itself. It only
connects to the CDP endpoint you provide. If you also need NetLog in attach
mode, the browser must have been started with `--log-net-log=<path>` before the
logger connects.

## NetLog Warning

Chrome and other Chromium-family browsers may show this banner after startup:

```text
You are using an unsupported command-line flag: --log-net-log=<path>. Stability
and security will suffer.
```

This is expected when NetLog is enabled from the command line. `--log-net-log`
is the Chromium-documented startup flag for writing a NetLog file, but browser
security warning UI can still flag diagnostic command-line switches as
potentially dangerous.

The warning does not mean that NetLog failed or that the browser ignored the
flag. Verify capture by checking that `netlog.json` exists and grows in the run
folder. The warning is meaningful: NetLog captures sensitive network metadata,
and `--net-log-capture-mode=Everything` can include more private debugging
detail than the default browser behavior.

## Debugger Paused Banner

Chromium-family browsers may otherwise show this banner when a page opens a
popup or another window while CDP is attached:

```text
Debugger paused in another tab, click to switch to that tab.
```

The logger does not enable the CDP `Debugger` or `Fetch` domains and does not
intentionally pause scripts. The browser can still create an auto-attached
popup, iframe, or worker target in a debugger-waiting state. For each attached
inspectable target, the logger enables `Network` first, then calls
`Runtime.runIfWaitingForDebugger` for that target session.

This Runtime call only tells a target to continue if the browser has it waiting
for a debugger. It is not request interception, script injection, browser
automation, or general Runtime evaluation.

## CLI

```text
kuebiko [options]

Options:
  --cdp <url>              CDP endpoint (default: http://127.0.0.1:9222)
  --out <capture-dir>      Capture directory
  --verbose                Print verbose status logs
  --include <regex>        Only persist matching response URLs
  --exclude <regex>        Do not persist matching response URLs
  --max-body-bytes <num>   Skip body retrieval above encoded byte length
  --config <path>          TS/JS logger config with plugin modules
  --no-plugins             Disable plugin loading from --config
  --launch-browser         Launch and own a local CDP browser process
  --browser-command <cmd>  Browser command for --launch-browser
  --browser-path <path>    Browser executable path for --launch-browser
  --browser-profile <dir>  Browser profile directory for --launch-browser
  --browser-arg <arg>      Extra browser arg for --launch-browser
  --cdp-port <port>        Local CDP port for --launch-browser
  --no-netlog              Disable netlog.json in --launch-browser mode
  --help                   Show help
```

If `--out` is omitted, the logger creates a new timestamped capture folder under
the platform default capture root:

- Windows:
  `%LOCALAPPDATA%\Kuebiko\captures`
- macOS:
  `~/Library/Application Support/Kuebiko/captures`
- Linux:
  `${XDG_STATE_HOME:-~/.local/state}/Kuebiko/captures`

Set `KUEBIKO_BASE_DIR` to override the base directory on any platform.

## Default Folders

- Windows:
  `%LOCALAPPDATA%\Kuebiko`
- macOS:
  `~/Library/Application Support/Kuebiko`
- Linux:
  `${XDG_STATE_HOME:-~/.local/state}/Kuebiko`

Each base directory contains `browser-profile`, `captures`, and plugin output
created by configured plugins. Nothing is intentionally written under `%TEMP%`,
`/tmp`, or WSL `/tmp` during normal capture.

## Development

```sh
mise install
mise run test
E2E_BROWSER_PATH=/path/to/chrome-or-chromium mise run test-e2e
mise run check --lint
mise run compile
```

`mise run compile` builds the configured Bun executables into `dist/`. Use
`mise run compile --target <target>` to build only one target.

## Known Limitations

- CDP may fail to return bodies for downloads, streaming responses, very large
  responses, redirects, cached responses, service-worker cases, or after
  navigation races.
- CDP may not expose every request payload. `Network.getRequestPostData` can
  fail after navigation races and does not include uploaded files for multipart
  form data.
- `--max-body-bytes` compares against CDP `encodedDataLength`; it is a skip
  guard, not a perfect final decoded-size predictor.
- WebSocket messages are not normal HTTP response bodies. This tool writes
  server-to-browser WebSocket frames to `websocket.ndjson`; it does not write
  client-to-server frames.
- This tool does not parse, analyze, classify, or display responses.
- Plugins are trusted local code running in the logger process. They are useful
  for local real-time consumers, but they are not sandboxed.
- Logs can contain sensitive data, including private API requests, private API
  responses, submitted form content, and cookies-adjacent content. Treat every
  capture directory as secret.
- Store capture directories somewhere private, avoid syncing them to cloud
  drives by default, delete runs you no longer need, and share only minimized
  redacted samples.
