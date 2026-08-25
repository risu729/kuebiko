# Repository Instructions

These instructions apply to agent work in this repository.

## Project Scope

This project is a local Chrome CDP/NetLog capture tool. Keep it focused on
saving raw request/response bodies, metadata, errors, WebSocket frames in both
directions, Server-Sent Events messages, browser downloads, an opt-in end-of-run
cookie and web storage snapshot, an opt-in append-only stream of web storage and
IndexedDB changes, and Chrome NetLog files.

Do not add analytics, parser UIs, dashboards, HAR viewers, browser automation,
login automation, stealth/evasion code, request interception, packet capture,
mitmproxy support, or `SSLKEYLOGFILE` workflows unless explicitly requested.

## Runtime And Platform

This is a Bun-only TypeScript project. Do not preserve Node.js runtime
compatibility for the logger or plugin runtime unless a task explicitly asks for
it.

The primary runtime target is Windows:

- Chrome runs on Windows.
- The logger should run on Windows and connect to `127.0.0.1:9222`.
- Development can happen in WSL.
- WSL-to-Windows builds should use `mise run compile --target windows-x64`.

Use the persistent Windows folders documented in the README. Do not introduce
temporary capture output under `%TEMP%` or WSL `/tmp`.

## Bun API Preference

Prefer Bun runtime APIs when they are the clearest fit:

- Use `Bun.write` for whole-file writes.
- Use `Bun.file` for whole-file reads and file copying.
- Use `bun test` for tests.
- Use `bun build --compile` for binaries.

Keep Node-compatible standard modules where they remain the better abstraction:

- Use `node:crypto` when it makes hashing code simpler than `Bun.CryptoHasher`.
- Use `node:path` for path handling, especially Windows path behavior.
- Use `node:fs` streams for append-only NDJSON writers.
- Use `node:fs/promises` for directory operations such as `mkdir` and
  `mkdtemp`.

## Tooling

Use `mise` tasks for repository workflows. Do not add npm/package scripts unless
explicitly requested.

Common commands:

- `mise run test`
- `mise run check --lint`
- `mise run compile`

The repository uses `hk`, `oxlint`, `oxfmt`, `tombi`, `rumdl`, YAML tooling,
`typos`, and GitHub Actions linters through `mise`. Keep config changes
compatible with `hk fix` and `hk check`.

## Dependencies

Prefer Bun and standard runtime APIs over adding small dependencies.

Keep existing focused dependencies when they carry real value:

- `chrome-remote-interface` for CDP connection/session plumbing.
- `devtools-protocol` for CDP types.
- `zod` for config and plugin validation.
- `mime-types` for MIME-to-extension mapping.
- TypeScript and the shared tsconfig for typechecking.

Do not remove typechecking just because Bun can execute TypeScript.

## Capture Behavior

Keep CDP use passive by default:

- Use the `Network` and `Target` domains for observing browser network activity.
- Do not enable `Fetch` or request pausing by default.
- Do not inject page scripts.
- Do not add Runtime or Debugger usage unless there is a narrow, documented
  reason.
- Keep anything that changes browser behavior behind an explicit off-by-default
  flag, and say so in the README. `--capture-downloads` is the only such flag:
  it sets `Browser.setDownloadBehavior` and subscribes the browser-wide
  `Browser` download events, and it restores the default behavior on shutdown.
- `--snapshot-storage` is off by default too, and it adds the `Storage`,
  `DOMStorage`, and `IndexedDB` domains. They read from the browser process and
  change no browser behavior. `DOMStorage` and `IndexedDB` are enabled per
  target session only for the moment the snapshot reads them, at the end of the
  run. Do not implement any part of that snapshot through `Runtime.evaluate` or
  `Runtime.enable`: leave a gap and document it instead.
- `--track-storage` is off by default too, and it reads the same three domains.
  It differs from `--snapshot-storage` in holding them open: `DOMStorage` is
  enabled on a page or iframe session once that target reaches an `http(s)`
  origin, and `Storage.trackIndexedDBForOrigin` stays in place for the run. The
  same `Runtime` prohibition applies. Do not add a timer: storage is followed
  through CDP events, never sampled on an interval.

Preserve normal browser behavior in launch mode:

- Use a dedicated profile.
- Do not attach to the default Chrome profile.
- Do not use headless mode.
- Do not use `--enable-automation`.
- Do not disable QUIC without a clear reason.

## Storage Rules

Saved capture data may contain credentials, private content, and API responses.
Treat it as sensitive.

Keep output append-only and durable enough for long captures:

- Keep `metadata.ndjson`, `errors.ndjson`, `websocket.ndjson`,
  `eventsource.ndjson`, `downloads.ndjson`, and `storage.ndjson` append-only.
- `storage-snapshot.json` is the one exception: a single point-in-time document
  written whole, once, at the end of a run. It holds live session cookies and
  web storage, so it is the most sensitive file the tool writes.
- `storage.ndjson` holds every value web storage took during the run rather than
  only the last one, so treat it as being as sensitive as the snapshot.
- Do not keep all completed metadata in memory.
- Clean up active request state after completion or failure.
- Do not put URL text directly in filenames.

## Plugin Rules

Plugins are trusted local modules loaded by explicit config. They run in the
logger process and are not sandboxed.

Keep plugin events path-based. Do not put captured bodies inline in hook events.
The logger should save files first, then publish events with metadata and
relative paths.

If plugin behavior fails, times out, or overflows its queue, record that in
`errors.ndjson` and keep capture running.

## Code Style

Follow the existing module layout and keep changes focused.

Prefer small helpers over broad abstractions. Add abstractions only when they
remove real duplication or clarify a shared contract.

Use structured APIs and typed data instead of ad hoc string parsing where
reasonable.

Use `apply_patch` for manual edits. Avoid broad formatting churn outside
formatting-only PRs.

## Validation

For most code changes, run:

```sh
mise run test
mise run check --lint
```

For runtime, CLI, storage, or build changes, also run:

```sh
mise run compile
```

If a check cannot run, explain exactly why in the PR or final response.

## Git And PRs

Keep PRs focused and draft by default. Use semantic titles and commit messages,
for example:

- `feat: add ...`
- `fix: ...`
- `chore: ...`
- `style: ...`

Do not force-push unless clearly necessary. Do not rewrite unrelated history.
