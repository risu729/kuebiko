import { describe, expect, it } from "vitest";

import { DEFAULT_CDP_ENDPOINT, parseArgs } from "./index";

describe("parseArgs", () => {
  it("uses defaults", () => {
    expect(parseArgs([])).toEqual({
      cdp: DEFAULT_CDP_ENDPOINT,
      help: false,
      noPlugins: false,
      verbose: false,
    });
  });

  it("parses logger options", () => {
    const options = parseArgs([
      "--cdp",
      "http://127.0.0.1:9333",
      "--out",
      "C:\\captures\\run",
      "--verbose",
      "--config",
      "logger.config.ts",
      "--no-plugins",
      "--include",
      "api",
      "--exclude",
      "tracking",
      "--max-body-bytes",
      "123",
    ]);

    expect(options.cdp).toBe("http://127.0.0.1:9333");
    expect(options.config).toBe("logger.config.ts");
    expect(options.noPlugins).toBe(true);
    expect(options.out).toBe("C:\\captures\\run");
    expect(options.verbose).toBe(true);
    expect(options.include?.test("https://example.test/api")).toBe(true);
    expect(options.exclude?.test("https://example.test/tracking")).toBe(true);
    expect(options.maxBodyBytes).toBe(123);
  });

  it("rejects unknown flags", () => {
    expect(() => parseArgs(["--wat"])).toThrow("Unknown argument: --wat");
  });
});
