import { DEFAULT_CDP_ENDPOINT } from "./constants";

// One table describes every flag: how it parses, how it validates, and how it prints.
// It lives on its own because it grows with each capture feature.
// That keeps cli.ts about parsing and validation alone.
type CliArgDefinition = {
	default?: boolean | string | undefined;
	description: string;
	multiple?: boolean | undefined;
	// What --no-<flag> does, for a flag that is on by default and so only spelled negated.
	// Help printed the affirmative description there, stating the opposite.
	negatedDescription?: string | undefined;
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
	"capture-cookies": {
		description: "Also record raw wire headers, including live cookies.",
		type: "boolean",
	},
	"capture-downloads": {
		description: "Save browser downloads into the run directory.",
		type: "boolean",
	},
	config: {
		description: "TS/JS logger config with plugin modules.",
		type: "string",
		valueHint: "path",
	},
	// No default here: normalizeArgs applies it, so the parsed args say whether it was given.
	// Launch mode has to reject the flag itself rather than the value it carries.
	cdp: {
		description: `CDP endpoint, ${DEFAULT_CDP_ENDPOINT} by default.`,
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
	label: {
		description: "Label recorded in run.json. May be repeated.",
		multiple: true,
		type: "string",
		valueHint: "label",
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
		negatedDescription: "Disable netlog.json in --launch-browser mode.",
		type: "boolean",
	},
	note: {
		description: "Free-form note recorded in run.json.",
		type: "string",
		valueHint: "text",
	},
	out: {
		description: "Capture directory.",
		type: "string",
		valueHint: "capture-dir",
	},
	plugins: {
		default: true,
		description: "Load plugins from --config.",
		negatedDescription: "Disable plugin loading from --config.",
		type: "boolean",
	},
	"snapshot-storage": {
		description: "Snapshot cookies and web storage when the run ends.",
		type: "boolean",
	},
	"stream-bodies": {
		description: "Assemble bodies from Network.streamResourceContent (experimental).",
		type: "boolean",
	},
	verbose: {
		description: "Print verbose status logs.",
		type: "boolean",
	},
} as const;

// The parsed shape of the table above, before validation turns it into CliOptions.
type LoggerArgs = {
	[key in keyof typeof cliArgs]?: boolean | string | string[] | undefined;
} & {
	help?: boolean | undefined;
	version?: boolean | undefined;
};

export { cliArgs };
export type { CliArgDefinition, LoggerArgs };
