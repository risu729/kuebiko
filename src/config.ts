import { z } from "zod";

import type { LoggerConfig } from "./types";

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
