import { parseArgs as parseNodeArgs } from "node:util";

import { z } from "zod";

import type { CliOptions } from "./types";

const DEFAULT_CDP_ENDPOINT = "http://127.0.0.1:9222";
const TOOL_NAME = "cdp-response-logger";
const TOOL_VERSION = "0.0.0";

type CliArgDefinition = {
	default?: boolean | string | undefined;
	description: string;
	type: "boolean" | "string";
	valueHint?: string | undefined;
};

const cliArgs = {
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
	"max-body-bytes": {
		description: "Skip body retrieval above encoded byte length.",
		type: "string",
		valueHint: "number",
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
	[key in keyof typeof cliArgs]?: boolean | string | undefined;
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

const optionalNonEmptyString = z.preprocess(
	(value) => (value === "" ? undefined : value),
	z.string().optional(),
);

const CliOptionsSchema: z.ZodType<CliOptions> = z.object({
	config: optionalNonEmptyString,
	cdp: z.url(),
	exclude: optionalNonEmptyString.transform((value) =>
		value ? parseRegex(value, "--exclude") : undefined,
	),
	help: z.boolean(),
	include: optionalNonEmptyString.transform((value) =>
		value ? parseRegex(value, "--include") : undefined,
	),
	maxBodyBytes: optionalNonEmptyString.transform((value) => {
		if (!value) {
			return undefined;
		}

		const parsed = Number(value);
		if (!Number.isSafeInteger(parsed) || parsed < 0) {
			throw new Error("--max-body-bytes must be a non-negative integer.");
		}

		return parsed;
	}),
	noPlugins: z.boolean(),
	out: optionalNonEmptyString,
	verbose: z.boolean(),
	version: z.boolean(),
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
		config: args.config,
		cdp: args.cdp,
		exclude: args.exclude,
		help: args.help ?? false,
		include: args.include,
		maxBodyBytes: args["max-body-bytes"],
		noPlugins: args.plugins === false,
		out: args.out,
		verbose: args.verbose ?? false,
		version: args.version ?? false,
	});

const createParseOptions = (): Record<
	string,
	{ default?: boolean | string; short?: string; type: "boolean" | "string" }
> => {
	const options: Record<
		string,
		{ default?: boolean | string; short?: string; type: "boolean" | "string" }
	> = {};

	for (const [name, definition] of Object.entries(cliArgs)) {
		const parseOption: { default?: boolean | string; short?: string; type: "boolean" | "string" } =
			{
				type: definition.type,
			};
		if ("default" in definition) {
			parseOption.default = definition.default;
		}

		options[name] = parseOption;
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
