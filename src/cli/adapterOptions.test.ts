import { Command } from "commander";
import { expect, it } from "vitest";
import { splitAdapterOptions } from "./adapterOptions.js";

it("collects global adapters without consuming command or operand arguments", () => {
  const argv = ["--adapter", "./adapter.mjs", "compile", "/project", "--adapter=@example/plugin", "--out", "/output"];
  expect(splitAdapterOptions(argv)).toEqual({
    adapters: ["./adapter.mjs", "@example/plugin"],
    args: ["compile", "/project", "--out", "/output"]
  });
});

it("preserves -- and rejects options without a specifier", () => {
  const argv = ["validate", "--", "--adapter", "project"];
  expect(splitAdapterOptions(argv)).toEqual({ adapters: [], args: argv });
  expect(() => splitAdapterOptions(["compile", "--adapter", "--out"])).toThrow(/requires a local module path/u);
  expect(() => splitAdapterOptions(["--adapter="])).toThrow(/requires a local module path/u);
});

it("respects required values, including grouped short flags, in the active command", () => {
  const program = new Command();
  program.command("up").option("-d, --detach").option("-t, --tag <image>");
  const literal = "--adapter=./literal.mjs";
  for (const flag of ["--tag", "-t", "-dt"]) {
    const { args, adapters } = splitAdapterOptions(["up", flag, literal, "--adapter=./actual.mjs"], program);
    expect(args).toEqual(["up", flag, literal]);
    expect(adapters).toEqual(["./actual.mjs"]);
  }
  expect(splitAdapterOptions(["up", "-dtattached", literal], program)).toEqual({
    args: ["up", "-dtattached"],
    adapters: ["./literal.mjs"]
  });
});
