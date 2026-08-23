import { describe, expect, it, mock } from "bun:test";

import type { Protocol } from "devtools-protocol";

import type { HookEvent, HookPublisher } from "./plugins";
import {
	MAX_DATABASES_PER_ORIGIN,
	MAX_ENTRIES_PER_OBJECT_STORE,
	captureStorageSnapshot,
	collectSnapshotOrigins,
} from "./storage-snapshot";
import type { SnapshotRun } from "./storage-snapshot";
import type { LoggerStorage, SessionInfo, StorageSnapshot } from "./types";

// The snapshot only ever sends raw commands and asks for the live target list.
class FakeClient {
	// Every CDP method the snapshot sends, in order.
	// It is also how the tests assert that no Runtime method is used at all.
	sent: { method: string; params?: object | undefined; sessionId?: string | undefined }[] = [];

	Target = {
		getTargets: mock(() => Promise.resolve({ targetInfos: [] })),
	};

	// Answers a raw send: an Error rejects, a function is called with the params.
	// Anything not listed resolves empty, the way a void CDP command does.
	sendReplies = new Map<string, unknown>();

	send = mock((method: string, params?: object, sessionId?: string) => {
		this.sent.push({ method, params, sessionId });
		const reply = this.sendReplies.get(method);
		if (reply instanceof Error) {
			return Promise.reject(reply);
		}

		return Promise.resolve(
			typeof reply === "function" ? (reply as (input: unknown) => unknown)(params) : (reply ?? {}),
		);
	});
}

// What the caller records for the snapshot, flattened the way an ErrorRecord holds it.
type RecordedError = { error: string; event: string; url?: string | undefined };

// The snapshot reaches the run directory, the run timestamp, and the snapshot writer.
// Nothing else of LoggerStorage is ever called, so the fake carries only those.
const createStorage = (): LoggerStorage & { snapshots: StorageSnapshot[] } => {
	const snapshots: StorageSnapshot[] = [];

	return {
		recordStorageSnapshot: mock((snapshot: StorageSnapshot) => {
			snapshots.push(snapshot);
			return Promise.resolve("storage-snapshot.json");
		}),
		runDirectory: "/captures/run",
		runTimestamp: "2026-07-06T12:34:56Z",
		snapshots,
	} as unknown as LoggerStorage & { snapshots: StorageSnapshot[] };
};

const createHooks = (): HookPublisher & { events: HookEvent[] } => {
	const events: HookEvent[] = [];

	return {
		close: mock(() => Promise.resolve()),
		events,
		publish: mock((event) => {
			events.push(event);
			return Promise.resolve();
		}),
	};
};

// Chrome answers IndexedDB.requestData with Runtime.RemoteObject shapes.
// The objectId is a live handle: resolving it would need the Runtime domain.
const REMOTE_OBJECT_ENTRY: Protocol.IndexedDB.DataEntry = {
	key: { description: "session", objectId: "key-handle-1", type: "string", value: "session" },
	primaryKey: { objectId: "pk-handle-1", type: "string", value: "session" },
	value: {
		className: "Object",
		description: "Object",
		objectId: "value-handle-1",
		preview: {
			description: "Object",
			overflow: false,
			properties: [{ name: "token", type: "string", value: "abc123" }],
			type: "object",
		},
		type: "object",
	},
};

const SNAPSHOT_COOKIE = {
	domain: "example.test",
	name: "session",
	path: "/",
	value: "abc",
} as unknown as Protocol.Network.Cookie;

const APP_DATABASE = {
	databaseWithObjectStores: {
		name: "app-cache",
		objectStores: [
			{ autoIncrement: false, indexes: [], keyPath: { type: "null" }, name: "sessions" },
		],
		version: 3,
	},
};

// The one attached page target every snapshot test reads storage from.
const APP_SESSION: SessionInfo = {
	sessionId: "session-1",
	targetId: "target-1",
	targetType: "page",
	targetUrl: "https://example.test/app",
};

const primeStorageReplies = (client: FakeClient): void => {
	client.sendReplies.set("Storage.getCookies", { cookies: [SNAPSHOT_COOKIE] });
	client.sendReplies.set("DOMStorage.getDOMStorageItems", (params: unknown) => ({
		entries: (params as { storageId: { isLocalStorage: boolean } }).storageId.isLocalStorage
			? [
					["theme", "dark"],
					["token", "abc123"],
				]
			: [["tab", "1"]],
	}));
	client.sendReplies.set("IndexedDB.requestDatabaseNames", { databaseNames: ["app-cache"] });
	client.sendReplies.set("IndexedDB.requestDatabase", APP_DATABASE);
	client.sendReplies.set("IndexedDB.requestData", {
		hasMore: false,
		objectStoreDataEntries: [REMOTE_OBJECT_ENTRY],
	});
};

const sentMethods = (client: FakeClient): string[] => client.sent.map((call) => call.method);

type SnapshotSetup = {
	client: FakeClient;
	errors: RecordedError[];
	hooks: ReturnType<typeof createHooks>;
	run: SnapshotRun;
	storage: ReturnType<typeof createStorage>;
};

// One run over one attached page target, which is what every test but the caps needs.
const setupSnapshot = (
	overrides: { sessions?: SessionInfo[]; timeoutMs?: number } = {},
): SnapshotSetup => {
	const client = new FakeClient();
	const errors: RecordedError[] = [];
	const hooks = createHooks();
	const storage = createStorage();

	return {
		client,
		errors,
		hooks,
		run: {
			client: client as never,
			hooks,
			// The caller builds the error record, so the test keeps only what it holds.
			recordError: (event: string, error: unknown, url?: string) => {
				errors.push({ error: error instanceof Error ? error.message : String(error), event, url });
				return Promise.resolve();
			},
			sessions: overrides.sessions ?? [APP_SESSION],
			storage,
			timeoutMs: overrides.timeoutMs,
		},
		storage,
	};
};

describe("collectSnapshotOrigins", () => {
	it("keeps one entry per http(s) page or iframe origin", () => {
		expect(
			collectSnapshotOrigins([
				{
					sessionId: "session-1",
					targetId: "target-1",
					targetType: "page",
					targetUrl: "https://example.test/app",
				},
				// The same origin in a second tab reuses the first session.
				{
					sessionId: "session-2",
					targetId: "target-2",
					targetType: "page",
					targetUrl: "https://example.test/other",
				},
				{
					sessionId: "session-3",
					targetId: "target-3",
					targetType: "iframe",
					targetUrl: "https://cdn.test/frame",
				},
				// Storage is not reachable on any of the rest.
				{
					sessionId: "session-4",
					targetId: "target-4",
					targetType: "service_worker",
					targetUrl: "https://example.test/sw.js",
				},
				{
					sessionId: "session-5",
					targetId: "target-5",
					targetType: "page",
					targetUrl: "about:blank",
				},
				{
					sessionId: "session-6",
					targetId: "target-6",
					targetType: "page",
					targetUrl: "chrome://newtab",
				},
				{ sessionId: "session-7", targetId: "target-7", targetType: "page" },
			]),
		).toEqual([
			{ securityOrigin: "https://example.test", sessionId: "session-1", targetId: "target-1" },
			{ securityOrigin: "https://cdn.test", sessionId: "session-3", targetId: "target-3" },
		]);
	});

	// A page target attaches on about:blank and navigates afterwards.
	it("prefers the live target URL over the one the session attached with", () => {
		expect(
			collectSnapshotOrigins(
				[
					{
						sessionId: "session-1",
						targetId: "target-1",
						targetType: "page",
						targetUrl: "about:blank",
					},
				],
				new Map([["target-1", "https://example.test/app"]]),
			),
		).toEqual([
			{ securityOrigin: "https://example.test", sessionId: "session-1", targetId: "target-1" },
		]);
	});
});

describe("captureStorageSnapshot", () => {
	it("snapshots the origin a page navigated to after it attached", async () => {
		const { client, run, storage } = setupSnapshot({
			sessions: [{ ...APP_SESSION, targetUrl: "about:blank" }],
		});
		primeStorageReplies(client);
		client.Target.getTargets.mockResolvedValueOnce({
			targetInfos: [{ targetId: "target-1", type: "page", url: "https://example.test/app" }],
		} as never);

		await captureStorageSnapshot(run);

		expect(storage.snapshots[0]?.origins.map((origin) => origin.securityOrigin)).toEqual([
			"https://example.test",
		]);
	});

	it("snapshots cookies, both DOM storage areas, and IndexedDB per attached origin", async () => {
		const { client, errors, run, storage } = setupSnapshot();
		primeStorageReplies(client);

		await captureStorageSnapshot(run);

		expect(errors).toEqual([]);
		expect(storage.snapshots).toHaveLength(1);
		const [snapshot] = storage.snapshots;
		expect(snapshot?.cookies).toEqual([SNAPSHOT_COOKIE]);
		expect(snapshot?.runTimestamp).toBe("2026-07-06T12:34:56Z");
		expect(snapshot?.truncated).toBeUndefined();
		expect(snapshot?.origins).toHaveLength(1);
		expect(snapshot?.origins[0]).toMatchObject({
			localStorage: { theme: "dark", token: "abc123" },
			securityOrigin: "https://example.test",
			sessionStorage: { tab: "1" },
			targetId: "target-1",
		});
		const store = snapshot?.origins[0]?.databases[0]?.objectStores[0];
		expect(snapshot?.origins[0]?.databases[0]).toMatchObject({ name: "app-cache", version: 3 });
		expect(store).toMatchObject({ autoIncrement: false, hasMore: false, name: "sessions" });
		// The live handle is dropped; the preview CDP already materialized is kept.
		expect(store?.entries[0]?.value).toEqual({
			className: "Object",
			deepSerializedValue: undefined,
			description: "Object",
			preview: REMOTE_OBJECT_ENTRY.value.preview,
			subtype: undefined,
			type: "object",
			unserializableValue: undefined,
			value: undefined,
		});
		expect(JSON.stringify(snapshot)).not.toContain("objectId");
		expect(JSON.stringify(snapshot)).not.toContain("value-handle-1");
	});

	it("never sends a Runtime method", async () => {
		const { client, run } = setupSnapshot();
		primeStorageReplies(client);

		await captureStorageSnapshot(run);

		expect(sentMethods(client)).not.toContain("Runtime.evaluate");
		expect(sentMethods(client)).not.toContain("Runtime.enable");
		expect(sentMethods(client).filter((method) => method.startsWith("Runtime."))).toEqual([]);
		expect(sentMethods(client)).toEqual(
			expect.arrayContaining([
				"Storage.getCookies",
				"DOMStorage.enable",
				"DOMStorage.getDOMStorageItems",
				"IndexedDB.enable",
				"IndexedDB.requestDatabaseNames",
				"IndexedDB.requestDatabase",
				"IndexedDB.requestData",
			]),
		);
	});

	it("publishes a path-based hook event with counts and no contents", async () => {
		const { client, hooks, run } = setupSnapshot();
		primeStorageReplies(client);

		await captureStorageSnapshot(run);

		const published = hooks.events.filter((event) => event.event === "storage.snapshot");
		expect(published).toEqual([
			expect.objectContaining({
				counts: { cookies: 1, databases: 1, entries: 1, items: 3, origins: 1 },
				event: "storage.snapshot",
				file: "storage-snapshot.json",
				run: { runDirectory: "/captures/run", runTimestamp: "2026-07-06T12:34:56Z" },
				truncated: false,
				version: 1,
			}),
		]);
		expect(JSON.stringify(published)).not.toContain("abc123");
	});

	// A snapshot is best-effort: a domain the browser refuses must not lose the rest.
	it("records a failing storage call and still writes the snapshot", async () => {
		const { client, errors, hooks, run, storage } = setupSnapshot();
		primeStorageReplies(client);
		client.sendReplies.set("Storage.getCookies", new Error("Storage domain unavailable"));
		client.sendReplies.set("IndexedDB.requestDatabaseNames", new Error("no storage key"));

		await captureStorageSnapshot(run);

		expect(errors).toEqual([
			expect.objectContaining({ error: "Storage domain unavailable", event: "Storage.getCookies" }),
			expect.objectContaining({
				error: "no storage key",
				event: "IndexedDB.requestDatabaseNames",
				url: "https://example.test",
			}),
		]);
		expect(storage.snapshots).toHaveLength(1);
		expect(storage.snapshots[0]?.cookies).toEqual([]);
		expect(storage.snapshots[0]?.origins[0]).toMatchObject({
			databases: [],
			localStorage: { theme: "dark", token: "abc123" },
		});
		expect(hooks.events.map((event) => event.event)).toContain("storage.snapshot");
	});

	it("marks the snapshot truncated when an origin holds more databases than the cap", async () => {
		const { client, run, storage } = setupSnapshot();
		primeStorageReplies(client);
		client.sendReplies.set("IndexedDB.requestDatabaseNames", {
			databaseNames: Array.from(
				{ length: MAX_DATABASES_PER_ORIGIN + 3 },
				(_, index) => `db-${index}`,
			),
		});

		await captureStorageSnapshot(run);

		const origin = storage.snapshots[0]?.origins[0];
		expect(origin?.databases).toHaveLength(MAX_DATABASES_PER_ORIGIN);
		expect(origin?.truncatedDatabases).toBe(3);
		expect(storage.snapshots[0]?.truncated).toBe(true);
	});

	// A store bigger than the page size is read once and reported as incomplete.
	it("reads one page per object store and keeps the CDP hasMore flag", async () => {
		const { client, run, storage } = setupSnapshot();
		primeStorageReplies(client);
		client.sendReplies.set("IndexedDB.requestData", {
			hasMore: true,
			objectStoreDataEntries: [REMOTE_OBJECT_ENTRY],
		});

		await captureStorageSnapshot(run);

		// Sending indexName at all, even empty, makes Chrome look for an index instead.
		expect(client.sent.filter((call) => call.method === "IndexedDB.requestData")).toEqual([
			expect.objectContaining({
				params: {
					databaseName: "app-cache",
					objectStoreName: "sessions",
					pageSize: MAX_ENTRIES_PER_OBJECT_STORE,
					securityOrigin: "https://example.test",
					skipCount: 0,
				},
				sessionId: "session-1",
			}),
		]);
		expect(storage.snapshots[0]?.origins[0]?.databases[0]?.objectStores[0]?.hasMore).toBe(true);
		expect(storage.snapshots[0]?.truncated).toBe(true);
	});

	it("stops at the deadline and still writes the partial snapshot", async () => {
		const { client, errors, hooks, run, storage } = setupSnapshot({ timeoutMs: 5 });
		primeStorageReplies(client);
		// A call the browser never answers is exactly what the deadline exists for.
		client.sendReplies.set("Storage.getCookies", () => Promise.withResolvers<never>().promise);

		await captureStorageSnapshot(run);

		expect(storage.snapshots).toHaveLength(1);
		expect(storage.snapshots[0]?.truncated).toBe(true);
		expect(storage.snapshots[0]?.origins).toEqual([]);
		expect(errors).toEqual([
			expect.objectContaining({ error: "Snapshot stopped after 5ms.", event: "Storage.snapshot" }),
		]);
		expect(hooks.events.map((event) => event.event)).toContain("storage.snapshot");
	});

	// A browser that is connected but wedged answers Target.getTargets never.
	// That call runs before the reader, so without a bound of its own it would hold
	// Up plugin shutdown, the browser close, and the run summary forever.
	it("stops waiting for the live target list at the deadline", async () => {
		const { client, errors, hooks, run, storage } = setupSnapshot({ timeoutMs: 5 });
		primeStorageReplies(client);
		client.Target.getTargets.mockReturnValueOnce(Promise.withResolvers<never>().promise);

		await captureStorageSnapshot(run);

		expect(errors.map((error) => error.event)).toContain("Target.getTargets");
		expect(storage.snapshots).toHaveLength(1);
		expect(storage.snapshots[0]?.truncated).toBe(true);
		expect(storage.snapshots[0]?.origins).toEqual([]);
		expect(hooks.events.map((event) => event.event)).toContain("storage.snapshot");
	});

	// The race only abandons the read, so the reader has to stop itself.
	// A record written after the deadline would reach a storage writer already closed.
	it("sends and records nothing more once the deadline abandoned the read", async () => {
		const { client, errors, run, storage } = setupSnapshot({ timeoutMs: 5 });
		primeStorageReplies(client);
		// An origin checks the deadline only where it starts, so a DOM storage read that
		// Answers after it used to leave the whole IndexedDB half of that origin running.
		client.sendReplies.set("DOMStorage.getDOMStorageItems", async () => {
			await Bun.sleep(50);
			throw new Error("answered after the deadline");
		});

		await captureStorageSnapshot(run);
		const sentAtDeadline = sentMethods(client);
		await Bun.sleep(100);

		expect(sentMethods(client)).toEqual(sentAtDeadline);
		expect(sentMethods(client)).not.toContain("IndexedDB.enable");
		expect(errors.map((error) => error.event)).toEqual(["Storage.snapshot"]);
		expect(storage.snapshots).toHaveLength(1);
		expect(storage.snapshots[0]?.origins[0]).toMatchObject({
			databases: [],
			securityOrigin: "https://example.test",
		});
	});
});
