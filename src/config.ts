import { z } from "zod";

// The config shapes live next to their only validator, as RunInfo does in storage.ts.
type LoggerPluginConfig = {
	enabled?: boolean | undefined;
	module: string;
	options?: unknown;
	queueSize?: number | undefined;
	timeoutMs?: number | undefined;
};

type LoggerConfig = {
	plugins?: LoggerPluginConfig[] | undefined;
};

const PluginConfigSchema = z
	.object({
		enabled: z.boolean().optional(),
		module: z.string().min(1),
		options: z.unknown().optional(),
		queueSize: z.int().positive().optional(),
		timeoutMs: z.int().positive().optional(),
	})
	.strict();

const LoggerConfigSchema: z.ZodType<LoggerConfig> = z
	.object({
		plugins: z.array(PluginConfigSchema).optional(),
	})
	.strict();

const parseLoggerConfig = (config: unknown): LoggerConfig => LoggerConfigSchema.parse(config ?? {});

const defineConfig = <const T extends LoggerConfig>(config: T): T => {
	parseLoggerConfig(config);

	return config;
};

export { defineConfig, parseLoggerConfig };
export type { LoggerConfig, LoggerPluginConfig };
