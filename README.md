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

- response bodies from CDP `Network.getResponseBody`, or
  `Network.streamResourceContent` with `--stream-bodies`
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

## Install

Install the latest release with mise:

```sh
mise use -g github:risu729/kuebiko
```

## Quick Start

Launch mode is the recommended path. It starts a browser with the required CDP
and NetLog flags, uses a dedicated profile, and keeps capture files in one run
directory.

Run the logger and let it launch your browser:

```sh
kuebiko \
  --launch-browser \
  --browser-command google-chrome
```

Use another browser command or executable path when needed:

```powershell
kuebiko.exe `
  --launch-browser `
  --browser-command chrome.exe
```

```sh
kuebiko --launch-browser \
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
eventsource.ndjson
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

`run.json` records how the run was started. `--label <label>` (repeatable) and
`--note <text>` add `labels` and `note` fields so the run also records why it
was made. Both fields are omitted when the flags are not used. A
`captureCookies` boolean is always present so a capture directory says whether
`--capture-cookies` was on and it may therefore hold plaintext session cookies.
A `streamBodies` boolean is always present too, so the directory also says how
its bodies were retrieved.

`metadata.ndjson` contains one JSON object per completed response that passed
the filters. When available, the same metadata line links to both a saved
request payload and a saved response body.

`--capture-cookies` adds the raw wire headers to each metadata line as
`rawRequestHeaders` and `rawResponseHeaders`, taken from the CDP
`Network.requestWillBeSentExtraInfo` and `Network.responseReceivedExtraInfo`
events. They sit next to the refined `requestHeaders` and `responseHeaders`,
never in place of them. The raw sets are the only place `Cookie` appears at all,
and the only place `Set-Cookie` appears verbatim for every response, so a
capture made with the flag holds live session cookies in plaintext. A response
that could not store a cookie also records `blockedCookies` with the reason
Chrome rejected each one, which is usually the real answer when a session
breaks, plus `exemptedCookies` for cookies stored despite third-party
restrictions and `cookiePartitionKey` when partitioned cookies apply. All are
omitted when there is nothing to report. The flag is off by default, and without
it the logger never subscribes the ExtraInfo events. Plugin events keep the
refined headers only, so raw cookies stay inside the capture directory, and
`run.json` records `captureCookies` so the directory says whether it may hold
them.

`--stream-bodies` is experimental. By default a body is read back with
`Network.getResponseBody` once a request finishes, which depends on Chromium
still holding it in its resource buffer. With this flag the logger instead
enables `Network.streamResourceContent` on each response that passes the
filters, then assembles the body from the buffered prefix the call returns
followed by the streamed `Network.dataReceived` chunks. This recovers bodies the
buffer path can miss: streaming responses, service-worker and cached responses,
single responses above `maxResourceBufferSize`, and bodies dropped when a
navigation or target teardown clears the buffer mid-fetch. Enabling the stream
also moves the `--include` and `--exclude` decision earlier, to the response
event, to bound the overhead. If a stream cannot be enabled or the method is
unsupported, that request falls back to `Network.getResponseBody`, so nothing is
lost relative to the default. The first such failure of the run is recorded in
`errors.ndjson` as `Network.streamResourceContent`, and later ones are
suppressed so a Chromium without the method cannot flood the file. A stream that
finishes with no bytes at all, which happens on some service-worker and cached
paths, also falls back rather than saving an empty body.

Server-Sent Events responses are never streamed: the connection normally never
finishes, so its bytes would accumulate for the life of the page, and its
messages are already captured in `eventsource.ndjson`.

`--max-body-bytes` still guards the size, and it still compares the encoded wire
bytes: the running total is summed from the `encodedDataLength` of every
`Network.dataReceived` event of the request, which is what the buffer path's
`Network.loadingFinished` total counts as well. Past the limit the partial
buffer is freed and the body is recorded as a skip, marked in `errors.ndjson`
with the same `Network.getResponseBody.skipped` event the buffer path uses, even
though nothing was fetched with that call. Unlike the buffer path, the guard
cannot avoid the transfer, because an enabled stream cannot be turned off again;
it only avoids writing and hashing the body. Without `--max-body-bytes` a
default limit of `maxResourceBufferSize` applies to a streamed body, so a
response whose `Network.loadingFinished` never arrives cannot grow without
bound.

Every streamed body records `base64Encoded: true` in `metadata.ndjson` and in
plugin events, where the buffer path reports `false` for a text response. That
is only how CDP delivered the bytes; the saved file is byte-identical either
way, and `run.json` records `streamBodies`. The flag is off by default while
the CDP method is experimental.

A redirect chain reuses one CDP request ID, so it produces several metadata
lines. Each `3xx` hop is written when the browser follows it, with
`redirect: true` and a 0-based `redirectIndex`; the terminal response of the
same chain takes the next `redirectIndex` and carries no `redirect` field.
Requests that never redirected have neither field. Hops keep their own status,
`location`, and `set-cookie` response headers, and an inline request payload
when the browser reported one, but they never have a response body: redirects
carry none, and CDP would only return the final hop's body. Filters apply to
each hop URL, exactly as they apply to a terminal response. With
`--capture-cookies`, each hop keeps the raw headers of its own hop. Because the
whole chain shares one request ID, a hop's `responseReceivedExtraInfo` that
arrives only after the next hop started is dropped instead of being credited to
the wrong hop, leaving that hop with its refined headers and no
`rawResponseHeaders`.

`websocket.ndjson` contains one JSON object per WebSocket frame, in both
directions: `direction` is `"received"` for a server-to-browser frame and
`"sent"` for a client-to-server one. Each frame carries the socket `url`, taken
from the `Network.webSocketCreated` event of the socket its `requestId` belongs
to. A frame the logger sees without that event, because the socket was opened
before it attached or had already closed, is still recorded but has no `url`.

`eventsource.ndjson` contains one JSON object per Server-Sent Events message,
with the `eventName`, `eventId`, and `data` the browser parsed out of the
stream. An SSE connection normally stays open for the life of the page, so it
usually never reaches `Network.loadingFinished` and has no saved response body;
the messages are the capture. A stream the server ends, or the page closes, does
reach it and adds a normal `metadata.ndjson` record for the connection itself,
while the messages stay in `eventsource.ndjson` either way. Each message carries
the stream `url`, which is recoverable
because an `EventSource` connection does produce `Network.requestWillBeSent`,
unlike a WebSocket handshake. A message recorded after the logger lost that
request state, because the target detached or the stream started before it
attached, is still written but has no `url`.

`--include` and `--exclude` apply to response URLs only. They never gate
`websocket.ndjson`, because a frame without a URL could not be matched anyway,
and they never gate `eventsource.ndjson` either, even though its messages do
carry a URL: that is a deliberate choice, because filtering part of a live
stream would be more confusing than not filtering it at all.

`errors.ndjson` contains per-request capture failures. Individual CDP failures
do not stop the logger. WebSocket failures land here too: a frame the browser
could not decode or send is recorded as a `Network.webSocketFrameError` event,
since no frame line is written for it. As with frame records, it carries the
socket URL only while the logger has a mapping for that socket.

`netlog.json` is Chromium NetLog for network-stack debugging.

## Run Summary

When a run ends, the logger prints a summary to stdout so silent losses are
visible without opening `errors.ndjson`:

```text
summary responses=482 response_bytes=19203112 requests=37 request_bytes=8241
summary websocket_frames=126 eventsource_messages=18 redirects=54 errors=4
summary_errors host=example.test total=2 Network.getResponseBody=2
summary_errors host=cdn.example.test total=1 Network.loadingFailed=1
summary_errors host=plugin:json-api-mirror total=1 Plugin.onEvent=1
```

`responses` and `requests` count saved body files, and the byte totals are the
bytes written for them. `websocket_frames` counts every frame recorded, sent and
received together, and `eventsource_messages` counts every recorded SSE message.
`redirects` counts recorded redirect hops, which have no body
of their own and would otherwise be invisible in the totals. One
`summary_errors` line is printed per host with the `errors.ndjson` `event`
counts behind it, ordered by failure count. Only the top 20 hosts get a line;
the rest are collapsed into a final remainder line.

Plugin failures have no URL, so they are grouped under `plugin:<id>` instead of
a host. Host `unknown` collects failures whose URL the browser never delivered,
such as `Network.loadingFailed` for a request that started before the logger
attached to its target. Bodies dropped by a size limit are counted as
`Network.getResponseBody.skipped` so a size policy is not mistaken for a capture
failure, including a streamed body that never reached that call. Error counts
cover all observed traffic, while the saved-body counts only cover responses
that passed `--include` and `--exclude`.

## What Gets Saved

For completed responses, metadata includes request and response fields such as:

- URL, method, request ID, loader ID, target/session identifiers
- request headers and response headers
- status, status text, MIME type, protocol, remote IP/port
- cache/service-worker/prefetch flags where the browser provides them
- encoded data length
- response body path, byte length, SHA-256, and CDP `base64Encoded`
- request body path, byte length, SHA-256, and source when available
- `redirect` and `redirectIndex` for requests that went through a redirect chain
- `rawRequestHeaders`, `rawResponseHeaders`, `blockedCookies`,
  `exemptedCookies`, and `cookiePartitionKey` when `--capture-cookies` is used
- any capture error for body retrieval

Response bodies are saved exactly from CDP's body result:

- `base64Encoded: true` is decoded and written as bytes.
- `base64Encoded: false` is written as UTF-8 bytes.
- A `--stream-bodies` body is written from the assembled chunks as they are, and
  always reports `base64Encoded: true`.

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
- `websocket.frame.sent`
- `eventsource.message`
- `capture.error`

Hook events do not contain inline request or response bodies. Read saved files
with `ctx.resolveRunPath(event.response.bodyFile)` or the request-body path when
present. WebSocket frames and SSE messages have no saved body file of their own:
`websocket.frame.*` carries the frame in `event.frame` and `eventsource.message`
carries the message in `event.message`, exactly as written to the matching
NDJSON file.

Redirect hops publish `response.completed` like any other recorded response, so
plugins see the whole chain. Such an event has `response.redirect` set to `true`
and `response.bodyFile` unset. Plugins that only care about bodies already skip
it through the usual `event.response.bodyFile` check; plugins that follow login
flows can use `response.redirect` and `response.redirectIndex` instead.

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
  --capture-cookies        Also record raw wire headers, including live cookies
  --stream-bodies          Assemble bodies from Network.streamResourceContent
                           (experimental)
  --label <label>          Label recorded in run.json
  --note <text>            Free-form note recorded in run.json
  --config <path>          TS/JS logger config with plugin modules
  --no-plugins             Disable plugin loading from --config
  --launch-browser         Launch and own a local CDP browser process
  --browser-command <cmd>  Browser command for --launch-browser
  --browser-path <path>    Browser executable path for --launch-browser
  --browser-profile <dir>  Browser profile directory for --launch-browser
  --browser-arg <arg>      Extra browser arg for --launch-browser
  --cdp-port <port>        Local CDP port for --launch-browser
  --no-netlog              Disable netlog.json in --launch-browser mode
  --help, -h               Show help
  --version, -v            Show version
```

## Releases

Successful pushes to `main` are released automatically from conventional commit
messages after CI passes. GitHub Releases contain archives for Windows x64,
Linux x64, and macOS arm64.

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
  responses, cached responses, service-worker cases, or after navigation races,
  because the default path reads them back from Chromium's retained resource
  buffer. `--stream-bodies` recovers many of these by assembling the body from
  `Network.streamResourceContent` instead, and falls back to the buffer path
  when a stream cannot be enabled, fails, or assembles nothing. It never streams
  a Server-Sent Events response, which `eventsource.ndjson` already covers.
- Redirect hops are recorded as metadata only. Their status, `location`, and
  `set-cookie` headers are saved, but no response body exists to save, and a
  hop the logger did not observe from its start is skipped. `redirectIndex`
  counts from the first hop the logger saw, so a chain joined mid-flight is
  numbered relative to attach time and may have no index-0 record.
- A redirect hop keeps only the request payload Chrome inlined in the event.
  When Chrome reports `hasPostData` without the data, usually for a large body,
  the hop records a request body error instead: refetching it would return the
  payload of the request that is already in flight.
- CDP may not expose every request payload. `Network.getRequestPostData` can
  fail after navigation races and does not include uploaded files for multipart
  form data.
- `--max-body-bytes` compares against CDP `encodedDataLength`; it is a skip
  guard, not a perfect final decoded-size predictor. With `--stream-bodies` it
  compares the same encoded bytes, summed per chunk, but it can only skip the
  write, not the transfer: an enabled stream cannot be turned off again.
- WebSocket messages are not normal HTTP response bodies. Both directions are
  written to `websocket.ndjson` as individual frames, not reassembled messages,
  and a frame on a socket the logger never saw open has no `url`.
- Server-Sent Events are captured as individual messages in
  `eventsource.ndjson`, not as a response body. The connection normally stays
  open for the life of the page, so CDP usually has no body to return for it,
  and a message recorded after the logger lost the stream's request state has no
  `url`.
- This tool does not parse, analyze, classify, or display responses.
- Plugins are trusted local code running in the logger process. They are useful
  for local real-time consumers, but they are not sandboxed.
- Logs can contain sensitive data, including private API requests, private API
  responses, submitted form content, and cookies-adjacent content. Treat every
  capture directory as secret.
- With `--capture-cookies`, `metadata.ndjson` holds the raw `Cookie` and
  `Set-Cookie` headers exactly as they went over the wire. Such a capture
  contains live session cookies in plaintext and is enough to resume the
  sessions it recorded. The flag is off by default; turn it on only when the raw
  headers, or the `blockedCookies` reasons behind a broken session, are what you
  are debugging, and delete those runs as soon as you are done.
- Store capture directories somewhere private, avoid syncing them to cloud
  drives by default, delete runs you no longer need, and share only minimized
  redacted samples.
