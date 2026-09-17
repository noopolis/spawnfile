import { execFile } from "node:child_process";
import { chmod, lstat, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
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
  const memo = path.join(process.env.SPAWNFILE_HOME!, "cache", "training-seal.v1.json");
  await expect(lstat(memo)).rejects.toThrow();
  f.config.auth[0]!.source = "auth"; await f.save();
  // Outlive the racy-clean window so an actual preparation would record digests.
  await new Promise(resolve => setTimeout(resolve, 2100));
  expect(await prepareTraining({ ...f.options, dryRun: true })).toMatchObject({ dryRun: true });
  await expect(lstat(memo)).rejects.toThrow();
  await prepareTraining(f.options);
  expect((await lstat(memo)).mode & 0o777).toBe(0o600);
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
  await expect(prepareTraining({ ...f.options, args: ["--out", path.join(f.root, "project/run")] })).rejects.toThrow("overlaps");
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

it("validates preserved launch and mapped receipts instead of trusting their declared digest", async () => {
  const f = await fixture(); const prepared = await prepareTraining(f.options); if ("dryRun" in prepared) throw Error("actual expected");
  const original = await readFile(prepared.preparationPath, "utf8"), mapped = JSON.parse(original);
  await chmod(prepared.preparationPath, 0o600);
  mapped.bindings[0].destination = "/run/training/inputs/elsewhere";
  await writeFile(prepared.preparationPath, JSON.stringify(mapped));
  await expect(prepareTraining({ ...f.options, args: [...f.args, "--resume"] })).rejects.toThrow("mapped receipt changed");
  await writeFile(prepared.preparationPath, original);
  mapped.imageId = `sha256:${"b".repeat(64)}`; await writeFile(prepared.preparationPath, JSON.stringify(mapped));
  await expect(prepareTraining({ ...f.options, args: [...f.args, "--resume"] })).rejects.toThrow("identity mismatch");
  await writeFile(prepared.preparationPath, original);
  const launch = JSON.parse(await readFile(prepared.configPath, "utf8")); launch.auth = [];
  await writeFile(prepared.configPath, JSON.stringify(launch));
  await expect(prepareTraining({ ...f.options, args: [...f.args, "--resume"] })).rejects.toThrow("launch or mapped receipt changed");
});

it("stages selective input closure and forwards resource paths through the snapshot on resume", async () => {
  const f = await fixture(); f.config.inputs[0]!.include = ["Spawnfile", "train.yaml"]; await f.save();
  const args = [...f.args, "--resource", `archive=${f.context.project.root}`, "--test", f.args[1]!, "--cost-config", f.args[1]!];
  const prepared = await prepareTraining({ ...f.options, args }); if ("dryRun" in prepared) throw Error("actual expected");
  expect(prepared.args).toContain(`archive=${prepared.context.project.root}`);
  expect(prepared.args.filter(value => value === path.join(prepared.context.project.root, "train.yaml"))).toHaveLength(3);
  await prepareTraining({ ...f.options, args: [...args, "--resume"] });
});

it("resolves immutable repository references and rejects missing images, overlapping inputs and preexisting files", async () => {
  const f = await fixture(); f.config.image = { ref: `registry.invalid/image@${image}` }; await f.save();
  const prepared = await prepareTraining({ ...f.options, process: async args => args[0] === "context"
    ? { code: 0, stdout: '"unix:///socket"', stderr: "" } : { code: 0, stdout: image, stderr: "" } });
  expect(prepared).toMatchObject({ image });
  f.config.output.source = "missing-image"; await f.save();
  await expect(prepareTraining({ ...f.options, args: ["--out", path.join(f.root, "missing-image")], process: async args => args[0] === "context"
    ? { code: 0, stdout: '"unix:///socket"', stderr: "" } : { code: 1, stdout: "", stderr: "" } })).rejects.toThrow("unavailable");
  f.config.inputs[1]!.source = "project"; await f.save();
  await expect(prepareTraining({ ...f.options, args: ["--out", path.join(f.root, "missing-image")] })).rejects.toThrow("inputs overlap");
  f.config.inputs[1]!.source = "settings"; f.config.output.source = "file"; await f.put("file"); await f.save();
  await expect(prepareTraining({ ...f.options, args: ["--out", path.join(f.root, "file")] })).rejects.toThrow();
  f.config.auth[0]!.source = "own"; await f.save();
  await expect(prepareTraining({ ...f.options, args: ["--out", path.join(f.root, "file")] })).rejects.toThrow("regular leaf");
});

it("rejects mismatched output before Docker or staging for cold, dry-run and exact resume", async () => {
  const f = await fixture();
  const before = await readdir(f.root);
  for (const args of [["--out", path.join(f.root, "other")], ["--out"]]) {
    for (const mode of [{ dryRun: false }, { dryRun: true }, { dryRun: false, resume: true }]) {
      await expect(prepareTraining({ ...f.options, dryRun: mode.dryRun, args: [...args, ...("resume" in mode ? ["--resume"] : [])] }))
        .rejects.toThrow("Training --out must match configured output");
      expect(f.docker.calls).toEqual([]);
      expect(await readdir(f.root)).toEqual(before);
    }
  }
  const prepared = await prepareTraining(f.options);
  if ("dryRun" in prepared) throw Error("actual preparation expected");
  const calls = f.docker.calls.length, saved = await readFile(prepared.preparationPath);
  await expect(prepareTraining({ ...f.options, args: ["--out", path.join(f.root, "other")] })).rejects.toThrow("match configured output");
  expect(f.docker.calls).toHaveLength(calls);
  expect(await readFile(prepared.preparationPath)).toEqual(saved);
});
