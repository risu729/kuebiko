# Chrome CDP Response Logger

Local Chrome network logger for Windows. It launches Chrome with a dedicated
profile, connects to Chrome's local DevTools Protocol endpoint, and saves
request/response bodies plus metadata while you browse manually.

This tool is intentionally narrow. It does not use mitmproxy, `SSLKEYLOGFILE`,
packet capture, request interception, browser automation, login automation,
analytics, parsers, dashboards, or HAR viewers.

## What This Is For

Use this when you want raw local capture files from normal manual browsing in a
throwaway Chrome profile:

- response bodies from CDP `Network.getResponseBody`
- request payloads that Chrome exposes through CDP
- request/response metadata in append-only NDJSON
- Chrome NetLog in the same run directory

The logger is written in TypeScript for Bun. Development can happen in WSL, but
the clean runtime target is Windows: run Chrome and the logger on Windows so the
logger connects to `http://127.0.0.1:9222`.

## Why Websites Usually Cannot Notice It

The logger observes Chrome locally. The website does not receive a header,
cookie, JavaScript variable, or protocol message saying that CDP logging is
enabled.

The launcher and logger are deliberately passive:

- CDP is bound to `127.0.0.1`.
- The logger uses the CDP `Network` domain to observe completed browser network
  activity and fetch stored bodies.
- Chrome NetLog writes a local debugging file from Chrome's network stack.
- There is no `Fetch.enable`, request pausing, request rewriting, or response
  rewriting.
- There is no `Runtime.evaluate`, script injection, extension injection, or
  Debugger-domain attachment.
- The launcher does not use `--headless`, `--enable-automation`, or
  `--remote-debugging-port=0`.
- The launcher does not use `--disable-quic`; Chrome's network behavior is kept
  close to normal.
- After enabling Network on an attached popup, iframe, or worker target, the
  logger sends `Runtime.runIfWaitingForDebugger` for that target session; it
  does not otherwise use the Runtime domain.

That means a destination site should see ordinary Chrome requests from the
dedicated profile, not an explicit "logger enabled" signal.

This is not a stealth or evasion guarantee. A site may still notice ordinary
environment differences, such as a fresh profile, missing old cookies, different
cache state, different permissions, no usual extensions, or local timing changes
from heavy logging. Some sites also use broad anti-debugging or automation
heuristics. This project avoids the obvious automation and interception signals;
it does not promise undetectability.

## Quick Start

From WSL, prepare the repository and build/deploy the Windows executable:

```sh
mise trust
mise install
mise run build-windows-from-wsl
```

On Windows, start Chrome and the logger together:

```powershell
& "$env:LOCALAPPDATA\ChromeCdpResponseLogger\bin\start-capture.ps1"
```

Chrome opens with a dedicated profile. Log in manually inside that profile and
browse normally. Capture files are written under:

```text
%LOCALAPPDATA%\ChromeCdpResponseLogger\captures\<run>
```

## Dedicated Profile

Chrome is launched with:

```text
%LOCALAPPDATA%\ChromeCdpResponseLogger\chrome-profile
```

The tool does not attach to your default Chrome profile and does not depend on
it. Treat this profile as a separate browser identity. If a website needs login,
log in manually inside this Chrome window.

## Output Layout

Each run creates a timestamped directory:

```text
%LOCALAPPDATA%\ChromeCdpResponseLogger\captures\2026-07-06T12-34-56
```

The run directory contains:

```text
run.json
metadata.ndjson
errors.ndjson
websocket.ndjson
bodies\
requests\
plugins\
netlog.json
```

`bodies\` contains saved response bodies. `requests\` contains request payloads
that Chrome exposes through CDP. Filenames are generated from timestamp,
SHA-256, counter, and MIME-derived extension; URLs are not placed into
filenames.

`plugins\` is created when configured plugins write per-plugin output. The core
logger still only writes raw capture files; plugins are trusted local extension
code you opt into with `--config`.

`metadata.ndjson` contains one JSON object per completed response that passed
the filters. When available, the same metadata line links to both a saved
request payload and a saved response body.

`errors.ndjson` contains per-request capture failures. Individual CDP failures
do not stop the logger.

`netlog.json` is Chrome NetLog for network-stack debugging.

## What Gets Saved

For completed responses, metadata includes request and response fields such as:

- URL, method, request ID, loader ID, target/session identifiers
- request headers and response headers
- status, status text, MIME type, protocol, remote IP/port
- cache/service-worker/prefetch flags where Chrome provides them
- encoded data length
- response body path, byte length, SHA-256, and CDP `base64Encoded`
- request body path, byte length, SHA-256, and source when available
- any capture error for body retrieval

Response bodies are saved exactly from CDP's body result:

- `base64Encoded: true` is decoded and written as bytes.
- `base64Encoded: false` is written as UTF-8 bytes.

Request payloads are written as UTF-8 bytes from CDP strings. The logger first
uses inline `request.postData` from `Network.requestWillBeSent` when present. If
Chrome only reports `hasPostData`, the logger tries
`Network.getRequestPostData`. This is suitable for JSON, forms, GraphQL, and
other text request bodies. It is not raw upload byte capture, and arbitrary
non-UTF-8 uploads may not round-trip exactly.

CDP bodies are not raw wire bytes. For exact network-stack debugging, use the
companion `netlog.json`.

## Plugins

Plugins let trusted local TypeScript or JavaScript modules react to completed
captures in real time without duplicating the CDP logger. The logger saves
request/response files and metadata first. Plugins then receive small immutable
events containing metadata and relative file paths.

Plugins run in the logger process. They are not sandboxed third-party code. A
bad plugin cannot mutate requests through the logger API, but it can still use
normal local runtime APIs, CPU, and memory. Plugin failures and queue overflows
are written to `errors.ndjson`; capture continues.

Create a config file:

```ts
import { defineConfig } from "chrome-network-logger";

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

import type { LoggerPlugin } from "chrome-network-logger";

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
cdp-response-logger --config C:\path\logger.config.ts --out <capture-dir>
```

Disable configured plugins for a run:

```powershell
cdp-response-logger --config C:\path\logger.config.ts `
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

```powershell
$capture = Get-ChildItem "$env:LOCALAPPDATA\ChromeCdpResponseLogger\captures" |
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

## Build And Deploy From WSL

The WSL workflow builds a Windows executable and copies it plus the PowerShell
scripts into the persistent Windows bin folder:

```sh
mise run build-windows-from-wsl
```

Expected deployed path:

```text
%LOCALAPPDATA%\ChromeCdpResponseLogger\bin\cdp-response-logger.exe
```

The script detects Windows `%LOCALAPPDATA%` through `cmd.exe` and `wslpath`. If
detection fails, pass the Windows username:

```sh
mise run build-windows-from-wsl --windows-user YourWindowsUser
```

If Bun cross-compilation from WSL fails, build on Windows instead:

```powershell
mise install
$out = "$env:LOCALAPPDATA\ChromeCdpResponseLogger\bin\cdp-response-logger.exe"
mise run compile --target windows-x64
Copy-Item dist\cdp-response-logger-windows-x64.exe $out
```

You can also run the TypeScript entrypoint directly on Windows with Bun:

```powershell
bun src/index.ts --cdp http://127.0.0.1:9222 --out <capture-dir>
```

## Scripts

Start only Chrome with CDP and NetLog:

```powershell
& "$env:LOCALAPPDATA\ChromeCdpResponseLogger\bin\start-chrome-cdp.ps1"
```

Start only the logger:

```powershell
& "$env:LOCALAPPDATA\ChromeCdpResponseLogger\bin\run-logger.ps1"
```

Start both with the same capture directory:

```powershell
& "$env:LOCALAPPDATA\ChromeCdpResponseLogger\bin\start-capture.ps1"
```

Start both with plugins:

```powershell
& "$env:LOCALAPPDATA\ChromeCdpResponseLogger\bin\start-capture.ps1" `
  -Config C:\path\logger.config.ts
```

The Chrome launcher:

- creates the persistent folders
- finds stable Chrome in standard `Program Files` locations, falling back to
  Chrome Beta if stable Chrome is unavailable
- starts Chrome with `--user-data-dir`, `--remote-debugging-address=127.0.0.1`,
  `--remote-debugging-port=9222`, `--log-net-log`, and
  `--net-log-capture-mode=Everything`

## Chrome NetLog Warning

Chrome may show this banner after startup:

```text
You are using an unsupported command-line flag: --log-net-log=<path>. Stability
and security will suffer.
```

This is expected when NetLog is enabled from the command line. `--log-net-log`
is the Chromium-documented startup flag for writing a NetLog file, but Chrome's
security warning UI can still flag diagnostic command-line switches as
potentially dangerous.

The warning does not mean that NetLog failed or that Chrome ignored the flag.
Verify capture by checking that `netlog.json` exists and grows in the run
folder. The warning is meaningful: NetLog captures sensitive network metadata,
and `--net-log-capture-mode=Everything` can include more private debugging
detail than the default browser behavior.

## Debugger Paused Banner

Chrome may otherwise show this banner when a page opens a popup or another
window while CDP is attached:

```text
Debugger paused in another tab, click to switch to that tab.
```

The logger does not enable the CDP `Debugger` or `Fetch` domains and does not
intentionally pause scripts. Chrome can still create an auto-attached popup,
iframe, or worker target in a debugger-waiting state. For each attached
inspectable target, the logger enables `Network` first, then calls
`Runtime.runIfWaitingForDebugger` for that target session.

This Runtime call only tells a target to continue if Chrome has it waiting for a
debugger. It is not request interception, script injection, browser automation,
or general Runtime evaluation.

## CLI

```text
cdp-response-logger [options]

Options:
  --cdp <url>              CDP endpoint (default: http://127.0.0.1:9222)
  --out <capture-dir>      Capture directory
  --verbose                Print verbose status logs
  --include <regex>        Only persist matching response URLs
  --exclude <regex>        Do not persist matching response URLs
  --max-body-bytes <num>   Skip body retrieval above encoded byte length
  --config <path>          TS/JS logger config with plugin modules
  --no-plugins             Disable plugin loading from --config
  --help                   Show help
```

If `--out` is omitted, the logger creates a new timestamped capture folder under
`%LOCALAPPDATA%\ChromeCdpResponseLogger\captures`. When running outside Windows
without `LOCALAPPDATA`, pass `--out` explicitly.

## Persistent Windows Folders

```text
%LOCALAPPDATA%\ChromeCdpResponseLogger
%LOCALAPPDATA%\ChromeCdpResponseLogger\chrome-profile
%LOCALAPPDATA%\ChromeCdpResponseLogger\captures
%LOCALAPPDATA%\ChromeCdpResponseLogger\bin
```

Nothing is intentionally written under `%TEMP%` or WSL `/tmp` during normal
capture.

## Development

```sh
mise install
mise run test
mise run check --lint
mise run compile
```

`mise run compile` builds both Linux and Windows Bun executables into `dist/`.
Use `mise run compile --target windows-x64` to build only the Windows binary.

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
