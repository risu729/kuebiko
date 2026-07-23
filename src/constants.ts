const DEFAULT_CDP_ENDPOINT = "http://127.0.0.1:9222";
const TOOL_NAME = "kuebiko";
declare const KUEBIKO_BUILD_VERSION: string;
const TOOL_VERSION =
	typeof KUEBIKO_BUILD_VERSION === "undefined" ? "0.0.0-development" : KUEBIKO_BUILD_VERSION;
const READY_MESSAGE = `${TOOL_NAME} running; press Ctrl-C to stop`;

export { DEFAULT_CDP_ENDPOINT, READY_MESSAGE, TOOL_NAME, TOOL_VERSION };
