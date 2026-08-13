import { describe, expect, it } from "vitest";

import { parseDuplicateFreeDockerProjection } from "./dockerProjectionJson.js";

describe("duplicate-free Docker projection JSON", () => {
  it("accepts whitespace, escaped strings, empty containers, and nested values", () => {
    expect(parseDuplicateFreeDockerProjection(
      " \n { \"escaped\\\\\\\"key\" : [ ], \"nested\" : { }, \"literal\" : true } \t"
    )).toEqual({ "escaped\\\"key": [], nested: {}, literal: true });
    expect(parseDuplicateFreeDockerProjection(
      "[\"escaped\\\"value\", false, null, -1.25e2]"
    )).toEqual(["escaped\"value", false, null, -125]);
    expect(parseDuplicateFreeDockerProjection("\"standalone\"")).toBe("standalone");
  });

  it.each([
    ["unterminated string", "\"unterminated"],
    ["dangling string escape", "\"dangling\\\\"],
    ["non-string object key", "{true:1}"],
    ["missing object colon", "{\"key\" 1}"],
    ["missing object comma", "{\"first\":1 \"second\":2}"],
    ["missing array comma", "[1 2]"],
    ["empty input", ""],
    ["trailing document", "true false"],
    ["invalid primitive", "truth"],
    ["duplicate nested key", "{\"outer\":{\"key\":1,\"key\":2}}"],
  ])("rejects %s", (_name, source) => {
    expect(parseDuplicateFreeDockerProjection(source)).toBeNull();
  });
});
