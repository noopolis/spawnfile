import { execFile } from "node:child_process";
import { lstat, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { prepareTraining } from "./prepare.js";
import { preparationFixture, imageDocker, image } from "./fixtures.test-helper.js";
import { parseTrainingMappedPreparation } from "./contract.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() { const f = await preparationFixture(); roots.push(f.root); const docker = imageDocker();
  return { ...f, docker, options: { configPath: f.configPath, context: f.context, args: f.args, dryRun: false,
    process: docker.process, timeoutMs: 30000, packageRoot: path.join(f.root, "own"), streams: { stdout() {}, stderr() {} } } }; }

it("prepares cold and warm runs, preserves mapped identity and resumes without rebuilding", async () => {
  const f = await fixture();
  const first = await prepareTraining(f.options); if ("dryRun" in first) throw Error("actual preparation expected");
  expect(first.image).toBe(image);
  expect((await lstat(path.join(f.root, "output"))).isDirectory()).toBe(true);
  const mapped = parseTrainingMappedPreparation(JSON.parse(await readFile(first.preparationPath, "utf8")));
  expect(mapped.bindings).toEqual([{ inputId: "project", destination: "/run/training/inputs/project" }, { inputId: "settings", destination: "/run/training/inputs/settings" }]);
  expect(JSON.stringify(mapped)).not.toContain(f.root);
  const resumed = await prepareTraining({ ...f.options, args: [...f.args, "--resume"] });
  expect(resumed).toEqual({ ...first, args: [...first.args, "--resume"] });
  f.config.output.source = "second"; await f.save();
  await prepareTraining({ ...f.options, args: ["--train", f.args[1]!, "--out", path.join(f.root, "second")] });
  expect(f.docker.calls.filter(args => args[2] === "build")).toHaveLength(1);
  expect(await readdir(f.root)).not.toContain(path.basename(f.docker.builtContext!));
});

it("dry-run reads declarations without Docker, auth access, output or staging mutations", async () => {
  const f = await fixture(); f.config.auth[0]!.source = "missing-auth"; await f.save();
  const before = await readdir(f.root);
  expect(await prepareTraining({ ...f.options, dryRun: true })).toMatchObject({ dryRun: true });
  expect(f.docker.calls).toEqual([]); expect(await readdir(f.root)).toEqual(before);
});

it("rejects changed executable, fixture, declaration and saved image on exact resume", async () => {
  const f = await fixture(); await prepareTraining(f.options);
  await f.put("paideia/dist/src/cli/main.js", "changed");
  await expect(prepareTraining({ ...f.options, args: [...f.args, "--resume"] })).rejects.toThrow("changed");
  await f.put("paideia/dist/src/cli/main.js"); await f.put("project/train.yaml", "changed");
  await expect(prepareTraining({ ...f.options, args: [...f.args, "--resume"] })).rejects.toThrow("changed");
  await f.put("project/train.yaml");
  await expect(prepareTraining({ ...f.options, args: [...f.args, "--resume"], process: async args => args[0] === "context"
    ? { code: 0, stdout: '"unix:///socket"', stderr: "" } : { code: 1, stdout: "", stderr: "" } })).rejects.toThrow("image");
});

it("materializes a real pinned worktree with overlays and rejects snapshot tampering", async () => {
  const f = await fixture(), git = promisify(execFile), project = f.context.project.root;
  const run = (args: string[]) => git("git", args, { cwd: project });
  await run(["init", "-q"]); await run(["add", "."]);
  await run(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "seed"]);
  const revision = (await run(["rev-parse", "HEAD"])).stdout.trim();
  const { sha } = await import("./fixtures.test-helper.js");
  await f.put("overlay", "generated"); f.config.inputs[0]!.git = { revision, overlays: [{ source: "overlay", path: "tools.tar", sha256: sha("generated") }] }; await f.save();
  const prepared = await prepareTraining(f.options); if ("dryRun" in prepared) throw Error("actual expected");
  expect(prepared.context.project.root).not.toBe(project);
  expect(await readFile(path.join(prepared.context.project.root, "tools.tar"), "utf8")).toBe("generated");
  expect((await lstat(path.join(prepared.context.project.root, ".git"))).isDirectory()).toBe(true);
  await prepareTraining({ ...f.options, args: [...f.args, "--resume"] });
  await writeFile(path.join(prepared.context.project.root, "tools.tar"), "tampered");
  await expect(prepareTraining({ ...f.options, args: [...f.args, "--resume"] })).rejects.toThrow("snapshot changed");
});

it("rejects auth/input overlap, missing auth, unsafe context and output mismatch before launch", async () => {
  const f = await fixture(); f.config.auth[0]!.source = "project/Spawnfile"; await f.save();
  await expect(prepareTraining(f.options)).rejects.toThrow("auth leaf"); expect(f.docker.calls).toEqual([]);
  f.config.auth[0]!.source = "missing"; await f.save(); await expect(prepareTraining(f.options)).rejects.toThrow();
  f.config.auth[0]!.source = "auth"; f.config.output.source = "project/run"; await f.save();
  await expect(prepareTraining(f.options)).rejects.toThrow("overlaps");
  f.config.output.source = "output"; await f.save();
  await expect(prepareTraining({ ...f.options, process: async () => ({ code: 0, stdout: '"tcp://remote"', stderr: "" }) })).rejects.toThrow("Unix");
  await expect(prepareTraining({ ...f.options, args: ["--out", "/different"] })).rejects.toThrow("match configured output");
});

it("rejects package symlinks, unsupported local locks and malformed Grok pins before building", async () => {
  const f = await fixture();
  await symlink(path.join(f.root, "auth"), path.join(f.root, "integration", "leak"));
  await expect(prepareTraining(f.options)).rejects.toThrow("symlinks"); await rm(path.join(f.root, "integration", "leak"));
  await f.put("claude/package-lock.json", JSON.stringify({ lockfileVersion: 3, packages: { "": { dependencies: {} }, "node_modules/local": { link: true } } }));
  await expect(prepareTraining(f.options)).rejects.toThrow("unsupported local");
  expect(f.docker.calls).toEqual([]);
});

it("uses an explicit immutable image without package preparation", async () => {
  const f = await fixture(); f.config.image = { ref: image }; await f.save();
  const result = await prepareTraining(f.options); expect(result).toMatchObject({ image });
  expect(f.docker.calls.some(args => args[2] === "build")).toBe(false);
});
