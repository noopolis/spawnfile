import { execFile } from "node:child_process";
import { access, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import { planInputs, readBoundedJson, stageInput, verifyCanonicalPins } from "./inputs.js";
import { preparationFixture, sha } from "./fixtures.test-helper.js";

const roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() { const f = await preparationFixture(); roots.push(f.root); return f; }
it("copies only selected inputs, ignoring historical runs, and seals their contents", async () => {
  const f = await fixture(); await f.put("project/history/old-run", "not selected");
  f.config.inputs[0]!.include = ["Spawnfile", "train.yaml"];
  const inputs = await planInputs(f.config, f.root, []), target = path.join(f.root, "snapshot");
  expect(await stageInput(inputs[0]!, target)).toBe(target);
  expect(await readFile(path.join(target, "train.yaml"), "utf8")).toBe("fixture");
  await expect(readFile(path.join(target, "history/old-run"))).rejects.toThrow();
  await verifyCanonicalPins(inputs, f.context.sources, [target, "unused"]);
  await writeFile(path.join(target, "Spawnfile"), "changed");
  await expect(verifyCanonicalPins(inputs, f.context.sources, [target, "unused"])).rejects.toThrow("differs");
  await expect(verifyCanonicalPins(inputs, [{ sourcePath: "/not-declared", sha256: sha("x") }], [target, "unused"])).rejects.toThrow("outside");
  f.config.inputs[0]!.include = ["Spawnfile", "Spawnfile"];
  await expect(planInputs(f.config, f.root, [])).rejects.toThrow("overlap");
});

it("accepts confined tracked links and rejects escaping Git links and overlay drift", async () => {
  const f = await fixture(), cwd = f.context.project.root, execute = promisify(execFile);
  const git = (args: string[]) => execute("git", args, { cwd });
  await f.put("project/AGENTS.md", "guide"); await symlink("AGENTS.md", path.join(cwd, "CLAUDE.md"));
  await git(["init", "-q"]); await git(["add", "."]);
  const commit = async () => { await git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "seed"]); return (await git(["rev-parse", "HEAD"])).stdout.trim(); };
  f.config.inputs[0]!.git = { revision: await commit(), overlays: [] };
  const inputs = await planInputs(f.config, f.root, []), target = path.join(f.root, "snapshot");
  await stageInput(inputs[0]!, target); expect(await readFile(path.join(target, "CLAUDE.md"), "utf8")).toBe("guide");
  await symlink("../../auth", path.join(cwd, "escape")); await git(["add", "."]); f.config.inputs[0]!.git!.revision = await commit();
  await expect(planInputs(f.config, f.root, [])).rejects.toThrow("symlink escapes");
  await git(["rm", "escape"]); f.config.inputs[0]!.git!.revision = await commit();
  f.config.inputs[0]!.git!.overlays = [{ source: "grok", path: "extra", sha256: sha("wrong") }];
  await expect(planInputs(f.config, f.root, [])).rejects.toThrow("digest mismatch");
  f.config.inputs[0]!.source = "project/nested"; await mkdir(path.join(cwd, "nested"));
  await expect(planInputs(f.config, f.root, [])).rejects.toThrow("repository root");
});

it("bounds retained JSON metadata", async () => {
  const f = await fixture(); expect(await readBoundedJson(f.configPath)).toEqual(f.config);
  await f.put("large.json", "x".repeat(1048577)); await expect(readBoundedJson(path.join(f.root, "large.json"))).rejects.toThrow("1 MiB");
});

it("does not execute ambient Git filters while checking out a pinned repository", async () => {
  const f = await fixture(), cwd = f.context.project.root, execute = promisify(execFile);
  const git = (args: string[]) => execute("git", args, { cwd });
  await f.put("project/.gitattributes", "train.yaml filter=probe\n");
  await git(["init", "-q"]); await git(["add", "."]);
  await git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "seed"]);
  f.config.inputs[0]!.git = { revision: (await git(["rev-parse", "HEAD"])).stdout.trim(), overlays: [] };
  const marker = path.join(f.root, "host-filter-ran"), config = path.join(f.root, "global.gitconfig");
  await writeFile(config, `[filter "probe"]\n smudge = touch ${marker}\n`);
  vi.stubEnv("GIT_CONFIG_GLOBAL", config);
  const inputs = await planInputs(f.config, f.root, []);
  await stageInput(inputs[0]!, path.join(f.root, "isolated"));
  await expect(access(marker)).rejects.toThrow();
  expect(await readFile(path.join(f.root, "isolated/train.yaml"), "utf8")).toBe("fixture");
});
