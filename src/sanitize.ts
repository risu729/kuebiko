import { basename, join } from "node:path";

import { extension } from "mime-types";

const WINDOWS_BASE_DIR_NAME = "ChromeCdpResponseLogger";
const MIME_EXTENSION_OVERRIDES = new Map([
	["application/jsonl", ".jsonl"],
	["application/x-jsonlines", ".jsonl"],
	["application/x-ndjson", ".ndjson"],
	["application/problem+json", ".json"],
]);

const timestampForFolder = (date = new Date()): string =>
	date
		.toISOString()
		.replaceAll(":", "-")
		.replace(/\.\d{3}Z$/u, "");

const timestampForFile = (date = new Date()): string =>
	date.toISOString().replaceAll(":", "-").replaceAll(".", "-");

const shortHash = (hash: string): string => hash.slice(0, 16);

const contentTypeToExtension = (contentType?: string): string => {
	const mimeType = contentType?.split(";")[0]?.trim().toLowerCase() ?? "";

	const override = MIME_EXTENSION_OVERRIDES.get(mimeType);
	if (override) {
		return override;
	}

	const extensionFromDatabase = extension(mimeType);
	if (extensionFromDatabase) {
		return `.${extensionFromDatabase}`;
	}

	if (mimeType.startsWith("text/")) {
		return ".txt";
	}
	if (mimeType.endsWith("+json")) {
		return ".json";
	}
	if (mimeType.endsWith("+xml")) {
		return ".xml";
	}

	return ".bin";
};

const createBodyFilename = (
	timestamp: string,
	hash: string,
	counter: number,
	contentType?: string,
): string => `${timestamp}-${shortHash(hash)}-${counter}${contentTypeToExtension(contentType)}`;

const getRequiredHome = (): string => {
	const home = process.env["HOME"] ?? process.env["USERPROFILE"];
	if (!home) {
		throw new Error("HOME/USERPROFILE is not set. Pass --out explicitly.");
	}

	return home;
};

const getDefaultBaseDirectory = (): string => {
	const override = process.env["CDP_RESPONSE_LOGGER_BASE_DIR"];
	if (override) {
		return override;
	}

	if (process.platform === "win32") {
		const localAppData = process.env["LOCALAPPDATA"];
		if (!localAppData) {
			throw new Error("LOCALAPPDATA is not set. Pass --out explicitly.");
		}

		return join(localAppData, WINDOWS_BASE_DIR_NAME);
	}

	if (process.platform === "darwin") {
		return join(getRequiredHome(), "Library", "Application Support", WINDOWS_BASE_DIR_NAME);
	}

	return join(
		process.env["XDG_STATE_HOME"] ?? join(getRequiredHome(), ".local", "state"),
		WINDOWS_BASE_DIR_NAME,
	);
};

const getDefaultCaptureDirectory = (date = new Date()): string =>
	join(getDefaultBaseDirectory(), "captures", timestampForFolder(date));

const relativeBodyPath = (filename: string): string => join("bodies", basename(filename));

const matchesFilters = (url: string | undefined, include?: RegExp, exclude?: RegExp): boolean => {
	if (!url) {
		return true;
	}
	if (include && !include.test(url)) {
		return false;
	}
	if (exclude?.test(url)) {
		return false;
	}

	return true;
};

export {
	contentTypeToExtension,
	createBodyFilename,
	getDefaultBaseDirectory,
	getDefaultCaptureDirectory,
	matchesFilters,
	relativeBodyPath,
	shortHash,
	timestampForFile,
	timestampForFolder,
};
