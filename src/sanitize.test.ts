import { describe, expect, it } from "vitest";

import {
  contentTypeToExtension,
  createBodyFilename,
  matchesFilters,
  shortHash,
  timestampForFolder,
} from "./sanitize";

describe("timestampForFolder", () => {
  it("creates Windows-safe ISO-ish timestamps", () => {
    expect(timestampForFolder(new Date("2026-07-06T12:34:56.789Z"))).toBe("2026-07-06T12-34-56");
  });
});

describe("contentTypeToExtension", () => {
  it("maps common response MIME types", () => {
    expect(contentTypeToExtension("application/json; charset=utf-8")).toBe(".json");
    expect(contentTypeToExtension("text/html")).toBe(".html");
    expect(contentTypeToExtension("text/css")).toBe(".css");
    expect(contentTypeToExtension("text/javascript")).toBe(".js");
    expect(contentTypeToExtension("image/webp")).toBe(".webp");
    expect(contentTypeToExtension("application/ld+json")).toBe(".jsonld");
    expect(contentTypeToExtension("application/problem+json")).toBe(".json");
    expect(contentTypeToExtension("application/x-ndjson")).toBe(".ndjson");
    expect(contentTypeToExtension("application/jsonl")).toBe(".jsonl");
    expect(contentTypeToExtension("application/octet-stream")).toBe(".bin");
  });
});

describe("createBodyFilename", () => {
  it("does not include URL text and uses the short hash", () => {
    const hash = "0123456789abcdef0123456789abcdef";
    expect(createBodyFilename("2026-07-06T12-34-56", hash, 7, "application/json")).toBe(
      "2026-07-06T12-34-56-0123456789abcdef-7.json",
    );
    expect(shortHash(hash)).toBe("0123456789abcdef");
  });
});

describe("matchesFilters", () => {
  it("applies include and exclude regexes", () => {
    expect(matchesFilters("https://example.test/api", /api/u, undefined)).toBe(true);
    expect(matchesFilters("https://example.test/page", /api/u, undefined)).toBe(false);
    expect(matchesFilters("https://example.test/api", undefined, /example/u)).toBe(false);
    expect(matchesFilters("https://example.test/api", /api/u, /blocked/u)).toBe(true);
  });
});
