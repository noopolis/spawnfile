import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Command } from "commander";
import { afterEach, describe, expect, it } from "vitest";

import { envFileAliasOption, resolveEnvFileOption, runtimeEnvFileOption } from "./envFileOption.js";

const cleanup: string[] = [];
afterEach(async () => {
  for (const directory of cleanup.splice(0)) await rm(directory, { force: true, recursive: true });
});

const parse = (argv: string[]): string | undefined => {
  let seen: string | undefined;
  const program = new Command().exitOverride();
  program
    .command("x")
    .addOption(runtimeEnvFileOption("secrets"))
    .addOption(envFileAliasOption())
    .action((options: { envFile?: string; runtimeEnvFile?: string }) => { seen = resolveEnvFileOption(options); });
  program.parse(["x", ...argv], { from: "user" });
  return seen;
};

describe("env file option", () => {
  it("accepts --runtime-env-file and the hidden --env-file alias", () => {
    expect(parse(["--runtime-env-file", "/a.env"])).toBe("/a.env");
    expect(parse(["--env-file", "/a.env"])).toBe("/a.env");
    expect(parse(["--env-file", "/a.env", "--runtime-env-file", "/a.env"])).toBe("/a.env");
    expect(parse([])).toBeUndefined();
  });

  it("refuses two different files", () => {
    expect(() => parse(["--env-file", "/a.env", "--runtime-env-file", "/b.env"])).toThrow("different files");
  });

  it("hides the alias from help", () => {
    const command = new Command("x").addOption(runtimeEnvFileOption("secrets")).addOption(envFileAliasOption());
    expect(command.helpInformation()).toContain("--runtime-env-file <file>");
    expect(command.helpInformation()).not.toContain("--env-file <file>");
  });

  // Why the rename exists: Node claims --env-file anywhere in argv, even after
  // the script, and exits 9 before the script runs. --runtime-env-file reaches it.
  it("is the spelling Node leaves to the script", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-env-flag-"));
    cleanup.push(directory);
    const script = path.join(directory, "argv.cjs");
    await writeFile(script, "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n");
    const missing = path.join(directory, "missing.env");
    const claimed = spawnSync(process.execPath, [script, "release", "--env-file", missing], { encoding: "utf8" });
    const passed = spawnSync(process.execPath, [script, "release", "--runtime-env-file", missing], { encoding: "utf8" });
    expect(passed.status).toBe(0);
    expect(JSON.parse(passed.stdout)).toEqual(["release", "--runtime-env-file", missing]);
    // Documents the Node behaviour this works around; if a Node release stops
    // claiming the flag, this becomes 0 and the alias is merely redundant.
    expect([0, 9]).toContain(claimed.status);
  });
});
