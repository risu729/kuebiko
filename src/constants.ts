const DEFAULT_CDP_ENDPOINT = "http://127.0.0.1:9222";
const TOOL_NAME = "kuebiko";
declare const KUEBIKO_BUILD_VERSION: string;
const TOOL_VERSION =
	typeof KUEBIKO_BUILD_VERSION === "undefined" ? "0.0.0-development" : KUEBIKO_BUILD_VERSION;
const READY_MESSAGE = `${TOOL_NAME} running; press Ctrl-C to stop`;
// Where the browser writes downloads, and where storage looks for them afterwards.
const DOWNLOADS_DIRECTORY = "downloads";
// The one whole-file capture output, written once at the end of a run.
const STORAGE_SNAPSHOT_FILE = "storage-snapshot.json";

export {
	DEFAULT_CDP_ENDPOINT,
	DOWNLOADS_DIRECTORY,
	READY_MESSAGE,
	STORAGE_SNAPSHOT_FILE,
	TOOL_NAME,
	TOOL_VERSION,
};
