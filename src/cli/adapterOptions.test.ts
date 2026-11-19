import { expect, it } from "vitest";
import { hasAdapterOption, splitAdapterOptions } from "./adapterOptions.js";

it("collects global adapters without consuming command or operand arguments", () => {
  const argv = ["--adapter", "./adapter.mjs", "compile", "/project", "--adapter=@example/plugin", "--out", "/output"];
  expect(hasAdapterOption(argv)).toBe(true);
  expect(splitAdapterOptions(argv)).toEqual({
    adapters: ["./adapter.mjs", "@example/plugin"],
    args: ["compile", "/project", "--out", "/output"]
  });
});

it("preserves -- and rejects options without a specifier", () => {
  const argv = ["validate", "--", "--adapter", "project"];
  expect(hasAdapterOption(argv)).toBe(false);
  expect(splitAdapterOptions(argv)).toEqual({ adapters: [], args: argv });
  expect(() => splitAdapterOptions(["compile", "--adapter", "--out"])).toThrow(/requires a local module path/u);
  expect(() => splitAdapterOptions(["--adapter="])).toThrow(/requires a local module path/u);
});
