import { mkdir } from "node:fs/promises";

import { defineCommand, parseArgs as parseCittyArgs, runMain } from "citty";
import type { ParsedArgs } from "citty";
import { z } from "zod";

import { startCdpLogger } from "./cdp";
import { defineConfig } from "./config";
import { createPluginHost } from "./plugins";
import { getDefaultCaptureDirectory } from "./sanitize";
import { createStorage } from "./storage";
import type {
	CliOptions,
	HookEvent,
	HookEventName,
	LoggerConfig,
	LoggerPlugin,
	LoggerPluginConfig,
	PluginContext,
} from "./types";

const DEFAULT_CDP_ENDPOINT = "http://127.0.0.1:9222";

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

type LoggerArgs = ParsedArgs<typeof cliArgs>;

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
	help: z.literal(false),
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

const normalizeArgs = (args: LoggerArgs): CliOptions => {
	const parsed = CliOptionsSchema.parse({
		config: args.config,
		cdp: args.cdp,
		exclude: args.exclude,
		help: false,
		include: args.include,
		maxBodyBytes: args["max-body-bytes"],
		noPlugins: args.plugins === false,
		out: args.out,
		verbose: args.verbose ?? false,
	});

	return parsed;
};

const parseArgs = (argv: string[]): CliOptions => {
	assertKnownFlags(argv);
	return normalizeArgs(parseCittyArgs<typeof cliArgs>(argv, cliArgs));
};

const waitForShutdown = (): Promise<void> =>
	new Promise((resolve) => {
		process.once("SIGINT", () => resolve());
		process.once("SIGTERM", () => resolve());
	});

const runLogger = async (options: CliOptions): Promise<void> => {
	const out = options.out ?? getDefaultCaptureDirectory();
	await mkdir(out, { recursive: true });
	const storage = await createStorage(out, options.cdp);

	process.stdout.write(`capture_dir=${storage.runDirectory}\n`);
	process.stdout.write(`cdp=${options.cdp}\n`);

	let logger: undefined | Awaited<ReturnType<typeof startCdpLogger>>;
	let plugins: undefined | Awaited<ReturnType<typeof createPluginHost>>;
	try {
		plugins = await createPluginHost({
			configPath: options.config,
			disabled: options.noPlugins,
			storage,
			verbose: options.verbose,
		});
		logger = await startCdpLogger({
			cdp: options.cdp,
			exclude: options.exclude,
			hooks: plugins,
			include: options.include,
			maxBodyBytes: options.maxBodyBytes,
			storage,
			verbose: options.verbose,
		});
		process.stdout.write("logger running; press Ctrl-C to stop\n");
		await Promise.race([waitForShutdown(), logger.closed]);
	} finally {
		await plugins?.stopping();
		await logger?.close().catch((error: unknown) => {
			process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		});
		await plugins?.close();
		await storage.close();
	}
};

const mainCommand = defineCommand({
	args: cliArgs,
	meta: {
		description: "Save Chrome CDP response bodies and metadata.",
		name: "cdp-response-logger",
		version: "0.0.0",
	},
	run: async ({ args }) => {
		await runLogger(normalizeArgs(args));
	},
});

const main = async (argv = process.argv.slice(2)): Promise<void> => {
	assertKnownFlags(argv);
	await runMain(mainCommand, { rawArgs: argv });
};

if (import.meta.main) {
	await main();
}

export {
	DEFAULT_CDP_ENDPOINT,
	cliArgs,
	defineConfig,
	main,
	mainCommand,
	normalizeArgs,
	parseArgs,
	runLogger,
};
export type {
	HookEvent,
	HookEventName,
	LoggerConfig,
	LoggerPlugin,
	LoggerPluginConfig,
	PluginContext,
};
