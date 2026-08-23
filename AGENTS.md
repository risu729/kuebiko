# Repository Instructions

These instructions apply to agent work in this repository.

## Project Scope

This project is a local Chrome CDP/NetLog capture tool. Keep it focused on
saving raw request/response bodies, metadata, errors, WebSocket frames in both
directions, Server-Sent Events messages, and Chrome NetLog files.

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

- Keep `metadata.ndjson`, `errors.ndjson`, `websocket.ndjson`, and
  `eventsource.ndjson` append-only.
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
