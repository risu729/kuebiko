import type CDP from "chrome-remote-interface";
import type { Protocol } from "devtools-protocol";

import { createStorageSnapshotHookEvent } from "./plugins";
import type { HookPublisher } from "./plugins";
import { countStorageSnapshot } from "./summary";
import { finishesWithin, resolvesWithin } from "./timeout";
import type {
	IndexedDbDatabaseSnapshot,
	IndexedDbEntrySnapshot,
	IndexedDbObjectStoreSnapshot,
	LoggerStorage,
	OriginStorageSnapshot,
	SessionInfo,
	StorageSnapshot,
	StorageSnapshotValue,
} from "./types";

// One end-of-run pass over the storage domains, run before the browser is closed.
// It is a lifecycle phase of its own: the request path never touches these domains.
// What the phase needs from the run is stated here and nothing else is reachable.
type SnapshotRun = {
	client: CDP.Client;
	hooks?: HookPublisher | undefined;
	// A snapshot record never has a session or a request id, so it names only the origin.
	// Building the record itself is left to the caller, so every field stays in one place.
	recordError: (event: string, error: unknown, url?: string) => Promise<void>;
	sessions: Iterable<SessionInfo>;
	storage: LoggerStorage;
	timeoutMs?: number | undefined;
};

// Bounds for one end-of-run storage snapshot, so shutdown cannot hang on a big store.
// Every cap that drops something sets `truncated` on the snapshot it cut.
// A short read is therefore visible in the file, not left looking like empty storage.
const MAX_SNAPSHOT_ORIGINS = 20;
const MAX_DATABASES_PER_ORIGIN = 20;
const MAX_OBJECT_STORES_PER_DATABASE = 20;
const MAX_ENTRIES_PER_OBJECT_STORE = 500;
const MAX_SNAPSHOT_ENTRIES = 5_000;
const SNAPSHOT_TIMEOUT_MS = 15_000;

// Web storage belongs to a browsing context, so only page-like targets are asked.
// A worker session answers neither DOMStorage nor a frame-scoped IndexedDB read.
const STORAGE_TARGET_TYPES = new Set(["page", "iframe"]);

// The client types send() to the command names its bundled protocol copy knows.
// The snapshot builds its method names from a domain, so it uses a widened view.
type RawSend = (method: string, params?: object, sessionId?: string) => Promise<unknown>;

// One origin to snapshot, together with the attached session it is read on.
type SnapshotOrigin = {
	securityOrigin: string;
	sessionId: string;
	targetId?: string | undefined;
};

const nowIso = (): string => new Date().toISOString();

// Sequential mapping without a loop, so a snapshot never fans out over every store.
const mapSequential = async <Item, Result>(
	items: readonly Item[],
	map: (item: Item) => Promise<Result>,
): Promise<Result[]> =>
	await items.reduce<Promise<Result[]>>(
		async (previous, item) => [...(await previous), await map(item)],
		Promise.resolve([]),
	);

// Web storage is keyed by origin, so only an http(s) target has any to read.
// Targets on about:, chrome:, devtools:, and extension schemes are left out.
const storageOriginOf = (url: string | undefined): string | undefined => {
	const parsed = url === undefined ? null : URL.parse(url);
	if (parsed === null || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) {
		return undefined;
	}

	return parsed.origin;
};

// The origins snapshotted are the ones the run actually attached to.
// They are never guessed from a URL seen on the wire.
// A third-party request origin has no session to ask on, and no reachable storage.
// Each origin is read on its own target session.
// That is what makes the sessionStorage answer belong to the tab it came from.
// The first session seen for an origin wins, so an origin open twice is read once.
// A session only recorded the URL its target had when it attached.
// For a page that is usually about:blank, so live target URLs take precedence.
const collectSnapshotOrigins = (
	sessions: Iterable<SessionInfo>,
	currentUrls: ReadonlyMap<string, string> = new Map(),
): SnapshotOrigin[] => {
	const origins = new Map<string, SnapshotOrigin>();
	for (const session of sessions) {
		const current = session.targetId === undefined ? undefined : currentUrls.get(session.targetId);
		const securityOrigin = storageOriginOf(current ?? session.targetUrl);
		if (
			securityOrigin === undefined ||
			!STORAGE_TARGET_TYPES.has(session.targetType ?? "") ||
			origins.has(securityOrigin)
		) {
			continue;
		}

		origins.set(securityOrigin, {
			securityOrigin,
			sessionId: session.sessionId,
			targetId: session.targetId,
		});
	}

	return [...origins.values()];
};

// CDP answers with a live-object handle beside a bounded preview.
// That handle is meaningless once the run is over, and resolving it would need the
// Runtime domain, so it is dropped.
// Whatever CDP already materialized is recorded exactly as it arrived.
const snapshotValue = (value: Protocol.Runtime.RemoteObject): StorageSnapshotValue => ({
	className: value.className,
	deepSerializedValue: value.deepSerializedValue,
	description: value.description,
	preview: value.preview,
	subtype: value.subtype,
	type: value.type,
	unserializableValue: value.unserializableValue,
	value: value.value as unknown,
});

const snapshotEntry = (entry: Protocol.IndexedDB.DataEntry): IndexedDbEntrySnapshot => ({
	key: snapshotValue(entry.key),
	primaryKey: snapshotValue(entry.primaryKey),
	value: snapshotValue(entry.value),
});

// A send that already knows its session and how to record its own failure.
// Both callers of the read below hold that knowledge; neither shares the other's.
type BoundedCall = <Result>(method: string, params: object, fallback: Result) => Promise<Result>;

// What one bounded page of an object store holds, whatever the caller does with it.
type ObjectStorePage = {
	entries: IndexedDbEntrySnapshot[];
	error?: string | undefined;
	// True when the store still holds entries past the ones read.
	hasMore: boolean;
};

// One page from one object store, never paged further.
// The end-of-run snapshot walks every store through here, and --track-storage reads
// The one store again each time Chrome says its contents changed.
// Keeping the read in one place is what keeps those two answering the same shape.
const readObjectStorePage = async (
	call: BoundedCall,
	request: {
		databaseName: string;
		objectStoreName: string;
		pageSize: number;
		securityOrigin: string;
	},
): Promise<ObjectStorePage> => {
	// No indexName is sent, which is what asks for the object store itself.
	// Chrome reads an empty one as a request for an index and fails the call.
	const params: Protocol.IndexedDB.RequestDataRequest = {
		databaseName: request.databaseName,
		objectStoreName: request.objectStoreName,
		pageSize: request.pageSize,
		securityOrigin: request.securityOrigin,
		skipCount: 0,
	};
	const data = await call<Protocol.IndexedDB.RequestDataResponse | undefined>(
		"IndexedDB.requestData",
		params,
		undefined,
	);
	if (data === undefined) {
		return { entries: [], error: "IndexedDB.requestData failed.", hasMore: false };
	}

	// A store CDP answered for without entries reads as empty, not as a failed call.
	return {
		entries: (data.objectStoreDataEntries ?? []).map(snapshotEntry),
		hasMore: data.hasMore ?? false,
	};
};

// DOMStorage answers with [key, value] pairs; a malformed pair is skipped.
const toStorageItems = (entries: Protocol.DOMStorage.Item[]): Record<string, string> =>
	Object.fromEntries(
		entries.flatMap((entry) => {
			const [key, value] = entry;
			return key === undefined ? [] : [[key, value ?? ""] as [string, string]];
		}),
	);

// Reads the browser-process storage domains into one snapshot object.
// Nothing here executes page script: Storage, DOMStorage, and IndexedDB all answer
// From the browser side, and no Runtime method is ever sent.
// Each read answers with a fallback instead of throwing, so one failed origin
// Cannot lose the rest of the file.
class StorageSnapshotReader {
	// Set when the caller's deadline race gave up on this reader.
	// Only some steps watch the deadline, so an abandoned read would otherwise keep
	// Enabling domains and recording errors on a storage writer the run has closed.
	#aborted = false;
	readonly #deadline: number;
	// Entries read so far across the whole snapshot, against MAX_SNAPSHOT_ENTRIES.
	#entries = 0;
	readonly #recordError: (event: string, error: unknown, origin?: SnapshotOrigin) => Promise<void>;
	readonly #send: RawSend;
	readonly #snapshot: StorageSnapshot;

	constructor(
		client: CDP.Client,
		snapshot: StorageSnapshot,
		deadline: number,
		recordError: (event: string, error: unknown, origin?: SnapshotOrigin) => Promise<void>,
	) {
		this.#deadline = deadline;
		this.#recordError = recordError;
		this.#send = client.send.bind(client) as unknown as RawSend;
		this.#snapshot = snapshot;
	}

	async read(origins: SnapshotOrigin[]): Promise<void> {
		await this.#readCookies();
		const wanted = origins.slice(0, MAX_SNAPSHOT_ORIGINS);
		if (origins.length > wanted.length) {
			this.#snapshot.truncated = true;
		}

		await mapSequential(wanted, async (origin) => {
			await this.#readOrigin(origin);
		});
	}

	// Stops the reader from sending or recording anything else.
	// The caller calls this once its own race around read() has been decided.
	abort(): void {
		this.#aborted = true;
	}

	#expired(): boolean {
		if (Date.now() < this.#deadline) {
			return false;
		}
		this.#snapshot.truncated = true;

		return true;
	}

	// The CDP method name doubles as the errors.ndjson event, as everywhere else.
	async #call<Result>(
		method: string,
		params: object,
		origin: SnapshotOrigin | undefined,
		fallback: Result,
	): Promise<Result> {
		if (this.#aborted) {
			return fallback;
		}

		try {
			return (await this.#send(method, params, origin?.sessionId)) as Result;
		} catch (error) {
			if (!this.#aborted) {
				await this.#recordError(method, error, origin);
			}
			return fallback;
		}
	}

	// Enabling is deferred to here, so these domains are only ever open for the moment
	// They are read.
	// A run without the flag never enables them at all.
	async #enable(domain: string, origin: SnapshotOrigin): Promise<boolean> {
		if (this.#aborted) {
			return false;
		}

		const method = `${domain}.enable`;
		try {
			await this.#send(method, {}, origin.sessionId);
			return true;
		} catch (error) {
			if (!this.#aborted) {
				await this.#recordError(method, error, origin);
			}
			return false;
		}
	}

	// Cookies are browser-wide, so this is one call on the browser connection.
	// No browserContextId is passed, which means the default context.
	// Nothing narrows the answer to the origins below: a stored session usually needs
	// Cookies of an API host that was never navigated to, which has no target at all.
	async #readCookies(): Promise<void> {
		// Every request below is annotated with its protocol type, because the widened
		// Send() would otherwise accept a misspelled parameter until it reached Chrome.
		const params: Protocol.Storage.GetCookiesRequest = {};
		const { cookies } = await this.#call<Protocol.Storage.GetCookiesResponse>(
			"Storage.getCookies",
			params,
			undefined,
			{ cookies: [] },
		);
		this.#snapshot.cookies = cookies;
	}

	async #readOrigin(origin: SnapshotOrigin): Promise<void> {
		if (this.#expired()) {
			return;
		}

		const record: OriginStorageSnapshot = {
			databases: [],
			securityOrigin: origin.securityOrigin,
			targetId: origin.targetId,
		};
		this.#snapshot.origins.push(record);
		await this.#readDomStorage(origin, record);
		await this.#readIndexedDb(origin, record);
	}

	// Both areas are read on the session of the target that owns them.
	// A cross-origin frame therefore answers for itself, not for the page embedding it.
	async #readDomStorage(origin: SnapshotOrigin, record: OriginStorageSnapshot): Promise<void> {
		if (!(await this.#enable("DOMStorage", origin))) {
			return;
		}

		record.localStorage = await this.#readDomStorageArea(origin, true);
		record.sessionStorage = await this.#readDomStorageArea(origin, false);
	}

	// An undefined area is one CDP refused; an empty one is an area with no keys.
	async #readDomStorageArea(
		origin: SnapshotOrigin,
		isLocalStorage: boolean,
	): Promise<Record<string, string> | undefined> {
		const params: Protocol.DOMStorage.GetDOMStorageItemsRequest = {
			storageId: { isLocalStorage, securityOrigin: origin.securityOrigin },
		};
		const entries = await this.#call<Protocol.DOMStorage.GetDOMStorageItemsResponse | undefined>(
			"DOMStorage.getDOMStorageItems",
			params,
			origin,
			undefined,
		);

		return entries === undefined ? undefined : toStorageItems(entries.entries);
	}

	async #readIndexedDb(origin: SnapshotOrigin, record: OriginStorageSnapshot): Promise<void> {
		if (!(await this.#enable("IndexedDB", origin))) {
			return;
		}

		const params: Protocol.IndexedDB.RequestDatabaseNamesRequest = {
			securityOrigin: origin.securityOrigin,
		};
		const { databaseNames } = await this.#call<Protocol.IndexedDB.RequestDatabaseNamesResponse>(
			"IndexedDB.requestDatabaseNames",
			params,
			origin,
			{ databaseNames: [] },
		);
		const wanted = databaseNames.slice(0, MAX_DATABASES_PER_ORIGIN);
		if (databaseNames.length > wanted.length) {
			record.truncatedDatabases = databaseNames.length - wanted.length;
			this.#snapshot.truncated = true;
		}

		record.databases = await mapSequential(
			wanted,
			async (name) => await this.#readDatabase(origin, name),
		);
	}

	async #readDatabase(
		origin: SnapshotOrigin,
		databaseName: string,
	): Promise<IndexedDbDatabaseSnapshot> {
		const params: Protocol.IndexedDB.RequestDatabaseRequest = {
			databaseName,
			securityOrigin: origin.securityOrigin,
		};
		const database = await this.#call<Protocol.IndexedDB.RequestDatabaseResponse | undefined>(
			"IndexedDB.requestDatabase",
			params,
			origin,
			undefined,
		);
		if (database === undefined) {
			return { error: "IndexedDB.requestDatabase failed.", name: databaseName, objectStores: [] };
		}

		const stores = database.databaseWithObjectStores.objectStores;
		const wanted = stores.slice(0, MAX_OBJECT_STORES_PER_DATABASE);
		if (stores.length > wanted.length) {
			this.#snapshot.truncated = true;
		}

		return {
			name: database.databaseWithObjectStores.name,
			objectStores: await mapSequential(
				wanted,
				async (store) => await this.#readObjectStore(origin, databaseName, store),
			),
			truncatedObjectStores:
				stores.length > wanted.length ? stores.length - wanted.length : undefined,
			version: database.databaseWithObjectStores.version,
		};
	}

	// One page per store, never paged further.
	// The caps are what keeps a huge store from stalling shutdown.
	// A store with more entries than the page holds reports `hasMore` instead.
	async #readObjectStore(
		origin: SnapshotOrigin,
		databaseName: string,
		store: Protocol.IndexedDB.ObjectStore,
	): Promise<IndexedDbObjectStoreSnapshot> {
		const shape = { autoIncrement: store.autoIncrement, keyPath: store.keyPath, name: store.name };
		const pageSize = Math.min(MAX_ENTRIES_PER_OBJECT_STORE, MAX_SNAPSHOT_ENTRIES - this.#entries);
		if (pageSize <= 0 || this.#expired()) {
			this.#snapshot.truncated = true;
			return { ...shape, entries: [], hasMore: true };
		}

		const page = await readObjectStorePage(
			async (method, params, fallback) => await this.#call(method, params, origin, fallback),
			{
				databaseName,
				objectStoreName: store.name,
				pageSize,
				securityOrigin: origin.securityOrigin,
			},
		);
		this.#entries += page.entries.length;
		if (page.hasMore) {
			this.#snapshot.truncated = true;
		}

		return { ...shape, ...page };
	}
}

// A session only ever recorded the URL its target had when it attached.
// A page target usually attaches on about:blank and navigates afterwards.
// The live target list is therefore what says which origin each session is on now.
// A browser that is connected but wedged answers this call never, and it runs before
// The reader's deadline guards anything, so it carries the same bound itself.
// Timing out leaves the map empty, exactly like a failure does.
const currentTargetUrls = async (
	run: SnapshotRun,
	timeout: number,
): Promise<Map<string, string>> => {
	const urls = await resolvesWithin<Map<string, string> | undefined>(
		requestTargetUrls(run),
		timeout,
		undefined,
	);
	if (urls !== undefined) {
		return urls;
	}
	await run.recordError("Target.getTargets", `Target.getTargets stopped after ${timeout}ms.`);

	return new Map();
};

// A failure leaves the map empty, so the attach-time URLs answer instead.
const requestTargetUrls = async (run: SnapshotRun): Promise<Map<string, string>> => {
	try {
		const { targetInfos } = await run.client.Target.getTargets({});
		return new Map(targetInfos.map((info) => [info.targetId, info.url]));
	} catch (error) {
		await run.recordError("Target.getTargets", error);
		return new Map();
	}
};

const writeSnapshot = async (run: SnapshotRun, snapshot: StorageSnapshot): Promise<void> => {
	try {
		const file = await run.storage.recordStorageSnapshot(snapshot);
		await run.hooks?.publish(
			createStorageSnapshotHookEvent(
				file,
				countStorageSnapshot(snapshot),
				snapshot.truncated === true,
				run.storage,
			),
		);
	} catch (error) {
		await run.recordError("Storage.snapshot", error);
	}
};

// Runs while the browser and the CDP connection are both still up.
// That is why it is its own step before shutdown rather than part of close().
// A failure is recorded and the partial snapshot is still written, so neither
// Teardown nor the run summary depends on the storage domains answering.
const captureStorageSnapshot = async (run: SnapshotRun): Promise<void> => {
	const timeout = run.timeoutMs ?? SNAPSHOT_TIMEOUT_MS;
	// One deadline covers the whole snapshot, target lookup included, so shutdown
	// Waits for this step at most once.
	const deadline = Date.now() + timeout;
	const snapshot: StorageSnapshot = {
		cookies: [],
		origins: [],
		runTimestamp: run.storage.runTimestamp,
		timestamp: nowIso(),
	};
	const reader = new StorageSnapshotReader(
		run.client,
		snapshot,
		deadline,
		async (event, error, origin) => {
			await run.recordError(event, error, origin?.securityOrigin);
		},
	);

	const origins = collectSnapshotOrigins(run.sessions, await currentTargetUrls(run, timeout));
	const remaining = Math.max(deadline - Date.now(), 0);
	if (!(await finishesWithin(reader.read(origins), remaining))) {
		// The race only abandons the read; this is what stops the reader itself.
		reader.abort();
		snapshot.truncated = true;
		await run.recordError("Storage.snapshot", `Snapshot stopped after ${timeout}ms.`);
	}

	await writeSnapshot(run, snapshot);
};

export {
	MAX_DATABASES_PER_ORIGIN,
	MAX_ENTRIES_PER_OBJECT_STORE,
	MAX_OBJECT_STORES_PER_DATABASE,
	MAX_SNAPSHOT_ENTRIES,
	MAX_SNAPSHOT_ORIGINS,
	SNAPSHOT_TIMEOUT_MS,
	STORAGE_TARGET_TYPES,
	captureStorageSnapshot,
	collectSnapshotOrigins,
	readObjectStorePage,
	storageOriginOf,
};
export type { BoundedCall, ObjectStorePage, SnapshotRun };
