import { parseArgs as parseNodeArgs } from "node:util";

import { z } from "zod";

import { cliArgs } from "./cli-args";
import type { CliArgDefinition, LoggerArgs } from "./cli-args";
import { DEFAULT_CDP_ENDPOINT, TOOL_NAME, TOOL_VERSION } from "./constants";
import type { CliOptions } from "./types";
import { nonEmptyString, optionalStringArray, parseRegex, parseSafeInteger } from "./validation";

type ParseOption = {
	default?: boolean | string;
	multiple?: boolean;
	short?: string;
	type: "boolean" | "string";
};

const validFlags = new Set([
	"--help",
	"--version",
	"-h",
	"-v",
	...Object.entries(cliArgs).flatMap(([name, definition]) =>
		definition.type === "boolean" ? [`--${name}`, `--no-${name}`] : [`--${name}`],
	),
]);

const CliOptionsSchema: z.ZodType<CliOptions> = z
	.object({
		browserArgs: optionalStringArray,
		browserCommand: nonEmptyString("--browser-command"),
		browserPath: nonEmptyString("--browser-path"),
		// Blank would silently launch into the default browser profile directory.
		browserProfile: nonEmptyString("--browser-profile"),
		captureCookies: z.boolean(),
		captureDownloads: z.boolean(),
		// Blank would otherwise run with every plugin silently disabled.
		config: nonEmptyString("--config"),
		cdp: z.url(),
		cdpPort: nonEmptyString("--cdp-port").transform((value) => {
			const port = parseSafeInteger(value, "--cdp-port", 1);
			if (port === undefined || port > 65_535) {
				throw new Error("--cdp-port must be an integer between 1 and 65535.");
			}

			return port;
		}),
		// Blank would capture exactly the traffic the caller meant to leave out.
		exclude: nonEmptyString("--exclude").transform((value) =>
			value ? parseRegex(value, "--exclude") : undefined,
		),
		help: z.boolean(),
		include: nonEmptyString("--include").transform((value) =>
			value ? parseRegex(value, "--include") : undefined,
		),
		labels: optionalStringArray,
		launchBrowser: z.boolean(),
		// Blank would retrieve every body however large, with no cap recorded anywhere.
		maxBodyBytes: nonEmptyString("--max-body-bytes").transform((value) =>
			parseSafeInteger(value, "--max-body-bytes", 0),
		),
		netlog: z.boolean(),
		noPlugins: z.boolean(),
		// Blank would drop a mistyped note without a word.
		note: nonEmptyString("--note"),
		// Blank would fall back to the default capture root.
		// The run would then be written somewhere the caller never named.
		out: nonEmptyString("--out"),
		snapshotStorage: z.boolean(),
		streamBodies: z.boolean(),
		trackStorage: z.boolean(),
		verbose: z.boolean(),
		version: z.boolean(),
	})
	.superRefine((options, context) => {
		if (!options.launchBrowser) {
			return;
		}

		if (!options.browserCommand && !options.browserPath) {
			context.addIssue({
				code: "custom",
				message: "--launch-browser requires --browser-command or --browser-path.",
				path: ["browserCommand"],
			});
		}
		if (options.browserCommand && options.browserPath) {
			context.addIssue({
				code: "custom",
				message: "Use only one of --browser-command or --browser-path.",
				path: ["browserCommand"],
			});
		}
	});

const valueFlags = new Set(
	Object.entries(cliArgs)
		.filter(([, definition]) => definition.type === "string")
		.map(([name]) => `--${name}`),
);

// The token after a value-taking flag is that flag's argument, whatever it looks like.
// Every browser arg starts with a dash, so treating those as flags here was wrong.
// `--browser-arg --no-sandbox` answered "Unknown argument: --no-sandbox" instead.
// That hid node:util's advice about the `--browser-arg=-XYZ` spelling, which is the fix.
const flagOf = (arg: string): string => (arg.includes("=") ? (arg.split("=", 1)[0] ?? arg) : arg);

const assertKnownFlags = (argv: string[]): void => {
	let expectsValue = false;
	for (const arg of argv) {
		const isValue = expectsValue;
		expectsValue = false;
		if (isValue || !arg.startsWith("-")) {
			continue;
		}

		const flag = flagOf(arg);
		if (!validFlags.has(flag)) {
			throw new Error(`Unknown argument: ${flag}`);
		}
		expectsValue = arg === flag && valueFlags.has(flag);
	}
};

// Launch mode connects to the port it started the browser on.
// An endpoint given here was discarded: the run and run.json both used --cdp-port.
// Passing the flag is what conflicts, not the endpoint it names.
// Comparing values accepted --cdp with the default spelled out.
// It rejected --cdp matching --cdp-port, the one spelling that is internally consistent.
// Presence is only visible before the default is applied, so this runs on the raw args.
const assertNoCdpEndpoint = (args: LoggerArgs): void => {
	if (args["launch-browser"] === true && args.cdp !== undefined) {
		throw new Error("Use --cdp-port instead of --cdp with --launch-browser.");
	}
};

const normalizeArgs = (args: LoggerArgs): CliOptions => {
	assertNoCdpEndpoint(args);

	return CliOptionsSchema.parse({
		browserArgs: args["browser-arg"],
		browserCommand: args["browser-command"],
		browserPath: args["browser-path"],
		browserProfile: args["browser-profile"],
		captureCookies: args["capture-cookies"] ?? false,
		captureDownloads: args["capture-downloads"] ?? false,
		config: args.config,
		cdp: args.cdp ?? DEFAULT_CDP_ENDPOINT,
		cdpPort: args["cdp-port"],
		exclude: args.exclude,
		help: args.help ?? false,
		include: args.include,
		labels: args.label,
		launchBrowser: args["launch-browser"] ?? false,
		maxBodyBytes: args["max-body-bytes"],
		netlog: args.netlog ?? true,
		noPlugins: args.plugins === false,
		note: args.note,
		out: args.out,
		snapshotStorage: args["snapshot-storage"] ?? false,
		streamBodies: args["stream-bodies"] ?? false,
		trackStorage: args["track-storage"] ?? false,
		verbose: args.verbose ?? false,
		version: args.version ?? false,
	});
};

const createParseOption = (definition: CliArgDefinition): ParseOption => ({
	...(definition.default === undefined ? {} : { default: definition.default }),
	...(definition.multiple ? { multiple: true } : {}),
	type: definition.type,
});

const createParseOptions = (): Record<string, ParseOption> => ({
	help: { short: "h", type: "boolean" },
	version: { short: "v", type: "boolean" },
	...Object.fromEntries(
		Object.entries(cliArgs).map(([name, definition]) => [name, createParseOption(definition)]),
	),
});

const parseRawArgs = (argv: string[]): LoggerArgs => {
	const { values } = parseNodeArgs({
		allowNegative: true,
		args: argv,
		options: createParseOptions(),
		strict: true,
	});

	return values as LoggerArgs;
};

const parseArgs = (argv: string[]): CliOptions => {
	assertKnownFlags(argv);
	return normalizeArgs(parseRawArgs(argv));
};

// Wide enough for the longest flag, --browser-command <command>.
// The value-taking flags then keep their descriptions in the same column as the rest.
const OPTION_COLUMN_WIDTH = 28;

const formatOptionLine = (flag: string, description: string): string =>
	`  ${flag.padEnd(OPTION_COLUMN_WIDTH)} ${description}`;

// A flag defaulting to true is only spelled negated, so it says what turning it off does.
// Printing the affirmative description against --no-<flag> stated the opposite.
// A definition without a negated description shows both spellings instead.
const formatOption = (name: string, definition: CliArgDefinition): string => {
	if (definition.type !== "boolean") {
		return formatOptionLine(
			`--${name} <${definition.valueHint ?? "value"}>`,
			definition.description,
		);
	}
	if (definition.default !== true) {
		return formatOptionLine(`--${name}`, definition.description);
	}

	return definition.negatedDescription === undefined
		? formatOptionLine(`--[no-]${name}`, definition.description)
		: formatOptionLine(`--no-${name}`, definition.negatedDescription);
};

const renderHelp = (): string =>
	`${[
		`${TOOL_NAME} [options]`,
		"",
		"Save CDP response bodies and metadata.",
		"",
		"Options:",
		...Object.entries(cliArgs).map(([name, definition]) => formatOption(name, definition)),
		formatOptionLine("--help, -h", "Show help"),
		formatOptionLine("--version, -v", "Show version"),
	].join("\n")}\n`;

export { DEFAULT_CDP_ENDPOINT, TOOL_VERSION, cliArgs, normalizeArgs, parseArgs, renderHelp };
export { READY_MESSAGE } from "./constants";
