import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { preparationFixture, image } from "./fixtures.test-helper.js";
import { startPreparationOwner } from "./scratch.test-helper.js";

const roots: string[] = [];
const owners: Awaited<ReturnType<typeof startPreparationOwner>>[] = [];
afterEach(async () => {
  await Promise.all(owners.splice(0).map(owner => owner.stop()));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
const fixture = async () => {
  const f = await preparationFixture(); roots.push(f.root);
  f.config.image = { ref: image };
  f.config.inputs[0]!.include = ["Spawnfile", "train.yaml"]; await f.save();
  const options = { configPath: f.configPath, context: f.context, args: f.args, dryRun: false,
    timeoutMs: 30000, packageRoot: path.join(f.root, "own") };
  const first = await startPreparationOwner(options); owners.push(first);
  expect(first.ok).toBe(true); await first.stop();
  return { options, prepared: first.prepared!, staging: path.dirname(first.prepared!.configPath) };
};

it("protects a resumed preparation from a competing fresh launch after its original owner exits", async () => {
  const f = await fixture();
  const saved = await Promise.all(["state.json", "launch.json", "mapped.json", "project/Spawnfile"]
    .map(file => readFile(path.join(f.staging, file))));
  const resume = await startPreparationOwner({ ...f.options, args: [...f.options.args, "--resume"] }); owners.push(resume);
  expect(resume.ok, resume.error).toBe(true);
  const competitor = await startPreparationOwner(f.options); owners.push(competitor);
  expect(competitor.ok, "resumed scratch ownership guarantee").toBe(false);
  expect(competitor.error, "resumed scratch ownership guarantee").toContain("active or unverifiable owner");
  expect(JSON.parse(await readFile(path.join(f.staging, "owner.json"), "utf8")).pid).toBe(resume.pid);
  expect(await Promise.all(["state.json", "launch.json", "mapped.json", "project/Spawnfile"]
    .map(file => readFile(path.join(f.staging, file))))).toEqual(saved);
  const competingResume = await startPreparationOwner({ ...f.options, args: [...f.options.args, "--resume"] }); owners.push(competingResume);
  expect(competingResume.ok).toBe(false);
  expect(competingResume.error).toContain("active or unverifiable owner");
});

it("refuses resume under an existing recovery guard without changing ownership or snapshots", async () => {
  const f = await fixture(), receipt = await readFile(path.join(f.staging, "owner.json"));
  await mkdir(`${f.staging}.reclaim`);
  const resume = await startPreparationOwner({ ...f.options, args: [...f.options.args, "--resume"] }); owners.push(resume);
  expect(resume.ok, "resume recovery exclusion guarantee").toBe(false);
  expect(resume.error, "resume recovery exclusion guarantee").toContain("recovery is already claimed");
  expect(await readFile(path.join(f.staging, "owner.json"))).toEqual(receipt);
  expect(await readFile(path.join(f.staging, "project/Spawnfile"), "utf8")).toContain("spawnfile_version");
});
