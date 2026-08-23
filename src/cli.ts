import { parseArgs as parseNodeArgs } from "node:util";

import { z } from "zod";

import { cliArgs } from "./cli-args";
import type { CliArgDefinition, LoggerArgs } from "./cli-args";
import { DEFAULT_CDP_ENDPOINT, TOOL_NAME, TOOL_VERSION } from "./constants";
import type { CliOptions } from "./types";
import {
	optionalNonEmptyString,
	optionalStringArray,
	parseNonEmptyText,
	parseRegex,
	parseSafeInteger,
} from "./validation";

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
		browserCommand: optionalNonEmptyString,
		browserPath: optionalNonEmptyString,
		browserProfile: optionalNonEmptyString,
		captureCookies: z.boolean(),
		captureDownloads: z.boolean(),
		config: optionalNonEmptyString,
		cdp: z.url(),
		cdpPort: optionalNonEmptyString.transform((value) => {
			const port = parseSafeInteger(value, "--cdp-port", 1);
			if (port === undefined || port > 65_535) {
				throw new Error("--cdp-port must be an integer between 1 and 65535.");
			}

			return port;
		}),
		exclude: optionalNonEmptyString.transform((value) =>
			value ? parseRegex(value, "--exclude") : undefined,
		),
		help: z.boolean(),
		include: optionalNonEmptyString.transform((value) =>
			value ? parseRegex(value, "--include") : undefined,
		),
		labels: optionalStringArray,
		launchBrowser: z.boolean(),
		maxBodyBytes: optionalNonEmptyString.transform((value) =>
			parseSafeInteger(value, "--max-body-bytes", 0),
		),
		netlog: z.boolean(),
		noPlugins: z.boolean(),
		// A blank --note is rejected instead of dropped, so a mistyped note cannot vanish.
		// That deviates on purpose from the optionalNonEmptyString flags such as --out.
		note: z.optional(z.string()).transform((value) => parseNonEmptyText(value, "--note")),
		out: optionalNonEmptyString,
		snapshotStorage: z.boolean(),
		streamBodies: z.boolean(),
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

const assertKnownFlags = (argv: string[]): void => {
	for (const arg of argv) {
		if (!arg.startsWith("-")) {
			continue;
		}

		const flag = arg.includes("=") ? (arg.split("=", 1)[0] ?? arg) : arg;
		if (!validFlags.has(flag)) {
			throw new Error(`Unknown argument: ${flag}`);
		}
	}
};

const normalizeArgs = (args: LoggerArgs): CliOptions =>
	CliOptionsSchema.parse({
		browserArgs: args["browser-arg"],
		browserCommand: args["browser-command"],
		browserPath: args["browser-path"],
		browserProfile: args["browser-profile"],
		captureCookies: args["capture-cookies"] ?? false,
		captureDownloads: args["capture-downloads"] ?? false,
		config: args.config,
		cdp: args.cdp,
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
		verbose: args.verbose ?? false,
		version: args.version ?? false,
	});

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

const formatOption = (name: string, definition: CliArgDefinition): string => {
	const flag =
		definition.type === "boolean"
			? `--${definition.default === true ? "no-" : ""}${name}`
			: `--${name} <${definition.valueHint ?? "value"}>`;
	return `  ${flag.padEnd(24)} ${definition.description}`;
};

const renderHelp = (): string =>
	`${[
		`${TOOL_NAME} [options]`,
		"",
		"Save CDP response bodies and metadata.",
		"",
		"Options:",
		...Object.entries(cliArgs).map(([name, definition]) => formatOption(name, definition)),
		"  --help, -h               Show help",
		"  --version, -v            Show version",
	].join("\n")}\n`;

export { DEFAULT_CDP_ENDPOINT, TOOL_VERSION, cliArgs, normalizeArgs, parseArgs, renderHelp };
export { READY_MESSAGE } from "./constants";
