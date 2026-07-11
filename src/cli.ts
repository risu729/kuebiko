import { parseArgs as parseNodeArgs } from "node:util";

import { z } from "zod";

import { DEFAULT_CDP_ENDPOINT, TOOL_NAME, TOOL_VERSION } from "./constants";
import type { CliOptions } from "./types";
import { optionalNonEmptyString, optionalStringArray, parseSafeInteger } from "./validation";

type CliArgDefinition = {
	default?: boolean | string | undefined;
	description: string;
	multiple?: boolean | undefined;
	type: "boolean" | "string";
	valueHint?: string | undefined;
};

const cliArgs = {
	"browser-arg": {
		description: "Extra browser arg for --launch-browser. May be repeated.",
		multiple: true,
		type: "string",
		valueHint: "arg",
	},
	"browser-command": {
		description: "Browser command for --launch-browser, resolved from PATH.",
		type: "string",
		valueHint: "command",
	},
	"browser-path": {
		description: "Browser executable path for --launch-browser.",
		type: "string",
		valueHint: "path",
	},
	"browser-profile": {
		description: "Browser profile directory for --launch-browser.",
		type: "string",
		valueHint: "dir",
	},
	config: {
		description: "TS/JS logger config with plugin modules.",
		type: "string",
		valueHint: "path",
	},
	cdp: {
		default: DEFAULT_CDP_ENDPOINT,
		description: "CDP endpoint.",
		type: "string",
		valueHint: "url",
	},
	"cdp-port": {
		default: "9222",
		description: "Local CDP port for --launch-browser.",
		type: "string",
		valueHint: "port",
	},
	exclude: {
		description: "Do not persist matching response URLs.",
		type: "string",
		valueHint: "regex",
	},
	include: {
		description: "Only persist matching response URLs.",
		type: "string",
		valueHint: "regex",
	},
	"launch-browser": {
		description: "Launch and own a local CDP browser process.",
		type: "boolean",
	},
	"max-body-bytes": {
		description: "Skip body retrieval above encoded byte length.",
		type: "string",
		valueHint: "number",
	},
	netlog: {
		default: true,
		description: "Write netlog.json when using --launch-browser.",
		type: "boolean",
	},
	out: {
		description: "Capture directory.",
		type: "string",
		valueHint: "capture-dir",
	},
	plugins: {
		default: true,
		description: "Load plugins from --config.",
		type: "boolean",
	},
	verbose: {
		description: "Print verbose status logs.",
		type: "boolean",
	},
} as const;

type LoggerArgs = {
	[key in keyof typeof cliArgs]?: boolean | string | string[] | undefined;
} & {
	help?: boolean | undefined;
	version?: boolean | undefined;
};

const createValidFlags = (): Set<string> => {
	const flags = new Set(["--help", "--version", "-h", "-v"]);

	for (const [name, definition] of Object.entries(cliArgs)) {
		flags.add(`--${name}`);
		if (definition.type === "boolean") {
			flags.add(`--no-${name}`);
		}
	}

	return flags;
};

const validFlags = createValidFlags();

const parseRegex = (value: string, flag: string): RegExp => {
	try {
		return new RegExp(value, "u");
	} catch (error) {
		throw new Error(`${flag} must be a valid JavaScript regular expression.`, { cause: error });
	}
};

const CliOptionsSchema: z.ZodType<CliOptions> = z
	.object({
		browserArgs: optionalStringArray,
		browserCommand: optionalNonEmptyString,
		browserPath: optionalNonEmptyString,
		browserProfile: optionalNonEmptyString,
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
		launchBrowser: z.boolean(),
		maxBodyBytes: optionalNonEmptyString.transform((value) =>
			parseSafeInteger(value, "--max-body-bytes", 0),
		),
		netlog: z.boolean(),
		noPlugins: z.boolean(),
		out: optionalNonEmptyString,
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
		config: args.config,
		cdp: args.cdp,
		cdpPort: args["cdp-port"],
		exclude: args.exclude,
		help: args.help ?? false,
		include: args.include,
		launchBrowser: args["launch-browser"] ?? false,
		maxBodyBytes: args["max-body-bytes"],
		netlog: args.netlog ?? true,
		noPlugins: args.plugins === false,
		out: args.out,
		verbose: args.verbose ?? false,
		version: args.version ?? false,
	});

const createParseOption = (
	definition: CliArgDefinition,
): {
	default?: boolean | string;
	multiple?: boolean;
	short?: string;
	type: "boolean" | "string";
} => {
	const parseOption: {
		default?: boolean | string;
		multiple?: boolean;
		short?: string;
		type: "boolean" | "string";
	} = {
		type: definition.type,
	};
	if (definition.default !== undefined) {
		parseOption.default = definition.default;
	}
	if (definition.multiple) {
		parseOption.multiple = true;
	}

	return parseOption;
};

const createParseOptions = (): Record<
	string,
	{ default?: boolean | string; multiple?: boolean; short?: string; type: "boolean" | "string" }
> => {
	const options: Record<
		string,
		{ default?: boolean | string; multiple?: boolean; short?: string; type: "boolean" | "string" }
	> = {};

	for (const [name, definition] of Object.entries(cliArgs)) {
		options[name] = createParseOption(definition);
	}

	options["help"] = { short: "h", type: "boolean" };
	options["version"] = { short: "v", type: "boolean" };

	return options;
};

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

const renderHelp = (): string => {
	const lines = [
		`${TOOL_NAME} [options]`,
		"",
		"Save CDP response bodies and metadata.",
		"",
		"Options:",
		...Object.entries(cliArgs).map(([name, definition]) => formatOption(name, definition)),
		"  --help, -h               Show help",
		"  --version, -v            Show version",
	];

	return `${lines.join("\n")}\n`;
};

export { DEFAULT_CDP_ENDPOINT, TOOL_VERSION, cliArgs, normalizeArgs, parseArgs, renderHelp };
export { READY_MESSAGE } from "./constants";
