import { mkdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { fixture } from "./fixtures.test-helper.js";
import { prepareTrainingContainer } from "./prepare.js";
import { trainingContainerConfigSchema, trainingImageSchema } from "./contract.js";
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const setup = async () => { const value = await fixture(); roots.push(value.root); return value; };
it("maps canonical sources and CLI paths, leaving installed bridge and project-relative editables intact", async () => {
  const f = await setup();
  const result = await prepareTrainingContainer(f.config, f.context, [...f.args, "--resource", `archive=${f.project}`, "--bridge-command", "/opt/training/bin/bridge", "--editable", "a.md"]);
  expect(result.context.project.root).toBe("/run/training/inputs/project");
  expect(result.context.sources[0]?.sourcePath).toBe("/run/training/inputs/project/Spawnfile");
  expect(result.context.documents[0]?.sourcePath).toBe("/run/training/inputs/project/Spawnfile");
  expect(result.context.skills[0]?.sourcePath).toBe("/run/training/inputs/project/Spawnfile");
  expect(result.args).toEqual(["--train", "/run/training/inputs/project/train.yaml", "--out", "/run/training/output", "--resource", "archive=/run/training/inputs/project", "--bridge-command", "/opt/training/bin/bridge", "--editable", "a.md"]);
});
it("rejects mutable images, extra authority and overlapping destinations", async () => {
  const f = await setup();
  for (const image of ["latest", "image:tag", "sha256:bad", "a@sha256:"+"a".repeat(63)]) expect(trainingImageSchema.safeParse(image).success).toBe(false);
  for (const value of [{ ...f.config, command: "shell" }, { ...f.config, auth: [f.config.auth[0], { ...f.config.auth[0] }] },
    { ...f.config, inputs: [...f.config.inputs, { source: f.output, destination: "/run/training/inputs/project/sub" }] },
    { ...f.config, inputs: [{ source: f.project, destination: "/run/training/inputs/../run" }] }]) expect(trainingContainerConfigSchema.safeParse(value).success).toBe(false);
});
it("rejects unmapped paths, output under readonly mounts, malformed resources and host executables/viewers", async () => {
  const f = await setup();
  for (const args of [["--train", "/missing"], ["--out", f.project], ["--train"], ["--resource", "bad"], ["--resource"], ["--bridge-command", "/usr/bin/bridge"], ["--bridge-command"], ["--view", "0"]]) {
    await expect(prepareTrainingContainer(f.config, f.context, args)).rejects.toThrow();
  }
});
it("rejects symlink aliases, whole auth directories and overlapping writable mounts", async () => {
  const f = await setup(); const alias = path.join(f.root, "alias"); await symlink(f.project, alias);
  for (const config of [{ ...f.config, inputs: [{ source: alias, destination: "/run/training/inputs/project" }] },
    { ...f.config, auth: [{ provider: "grok", source: f.project }] },
    { ...f.config, output: { source: f.project, destination: "/run/training/output" } },
    { ...f.config, output: { source: path.join(f.root, "auth-leaf"), destination: "/run/training/output" } },
    { ...f.config, inputs: [{ source: f.root, destination: "/run/training/inputs/project" }] }]) await expect(prepareTrainingContainer(config, f.context, f.args)).rejects.toThrow();
  vi.spyOn(os, "homedir").mockReturnValue(f.root);
  const cliHome = path.join(f.root, ".grok"); await mkdir(cliHome); await writeFile(path.join(cliHome,"auth.json"), "fixture");
  await expect(prepareTrainingContainer({ ...f.config, inputs: [{ source: cliHome, destination: "/run/training/inputs/project" }] }, f.context, f.args)).rejects.toThrow("Host homes");
});

it("rejects noncanonical raw spellings and overlapping host input roots before remapping",async()=>{
 const f=await setup();const inner=path.join(f.project,"inner");await mkdir(inner);const other=path.join(f.root,"other");await mkdir(other);const leaf=path.join(f.project,"credential");await writeFile(leaf,"fixture");
 await expect(prepareTrainingContainer({...f.config,auth:[{provider:"grok",source:other+"/../project/credential"}]},f.context,f.args)).rejects.toThrow("canonical");
 await expect(prepareTrainingContainer({...f.config,inputs:[...f.config.inputs,{source:inner,destination:"/run/training/inputs/inner"}]},f.context,f.args)).rejects.toThrow("source roots must not overlap");
 await expect(prepareTrainingContainer({...f.config,output:{source:f.output+"/../output",destination:"/run/training/output"}},f.context,f.args)).rejects.toThrow("canonical");
});

it("accepts one explicit viewer port and rejects ephemeral, invalid or duplicate publication",async()=>{
 const f=await setup();const prepared=await prepareTrainingContainer(f.config,f.context,[...f.args,"--view","53484"]);
 expect(prepared.viewerPort).toBe(53484);expect(prepared.args.slice(-2)).toEqual(["--view","53484"]);
 for(const values of [["0"],["65536"],["-1"],["1.5"],["127.0.0.1:3"],[""]])await expect(prepareTrainingContainer(f.config,f.context,[...f.args,"--view",...values])).rejects.toThrow("explicit port");
 await expect(prepareTrainingContainer(f.config,f.context,[...f.args,"--view","1234","--view","1234"])).rejects.toThrow("explicit port");
});


it("accepts real nested project worktrees without treating their .claude directory as the host profile", async () => {
  const f = await setup();
  vi.spyOn(os, "homedir").mockReturnValue(f.root);
  const worktree = path.join(f.root, "Documents", "project", ".claude", "worktrees", "training");
  await mkdir(path.dirname(worktree), { recursive: true });
  await rename(f.project, worktree);
  const remap = <T>(value: T): T => JSON.parse(JSON.stringify(value).replaceAll(f.project, worktree)) as T;
  const result = await prepareTrainingContainer(remap(f.config), remap(f.context), remap(f.args));
  expect(result.context.project.root).toBe("/run/training/inputs/project");
  expect(result.config.inputs[0]?.source).toBe(worktree);
  expect(result.args[1]).toBe("/run/training/inputs/project/train.yaml");
});

it("still rejects exact host roots, global profile subtrees and explicit auth exposure", async () => {
  const f = await setup();
  const home = path.join(f.root, "home"); await mkdir(home);
  vi.spyOn(os, "homedir").mockReturnValue(home);
  const denied = [home, "/"];
  for (const name of [".codex", ".claude", ".grok", ".ssh", ".config"]) {
    const root = path.join(home, name), nested = path.join(root, "nested");
    await mkdir(nested, { recursive: true }); denied.push(root, nested);
  }
  for (const source of denied) {
    await expect(prepareTrainingContainer({ ...f.config, inputs: [{ ...f.config.inputs[0], source }] }, f.context, f.args)).rejects.toThrow("Host homes");
  }
  await expect(prepareTrainingContainer({ ...f.config, inputs: [{ ...f.config.inputs[0], source: f.config.auth[0]!.source }] }, f.context, f.args)).rejects.toThrow("Auth must not be exposed");
});
