import { access, chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { TrainingContext } from "../compiler/training/index.js";
import { delegatePaideiaTraining } from "./paideiaDelegation.js";

const directories: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });
const digest = `sha256:${"1".repeat(64)}`;
const context: TrainingContext = {
  version: "spawnfile.training-context.v1", producer: { package: "spawnfile", version: "0.1.17" },
  project: { root: "/isolated/project", manifest: "/isolated/project/Spawnfile", sourceDigest: digest },
  agent: { id: "agent:writer", name: "writer", source: "/isolated/project/Spawnfile", runtime: "daimon", engine: null, model: null },
  sources: [{ sourcePath: "/isolated/project/Spawnfile", destinationPath: "Spawnfile", sha256: digest }],
  documents: [], skills: [], resources: [], requirements: { nativeCompilation: true, isolatedPreparation: true }
};
const dryReceipt = 'console.log(JSON.stringify({schema:"paideia.training-cost-plan.v1",modelCallsMade:0}));';
const completed = 'console.log(JSON.stringify({status:"completed",index:"/isolated/invocation.json"}));';

async function command(body: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-paideia-child-"));
  directories.push(directory);
  const executable = path.join(directory, "paideia");
  // Generated process fixture, not an alternate maintained implementation.
  await writeFile(executable, `#!${process.execPath}\n${body}\n`);
  await chmod(executable, 0o700);
  return executable;
}

async function invoke(body: string, overrides: Partial<Parameters<typeof delegatePaideiaTraining>[0]> = {}) {
  const stdout: string[] = [], stderr: string[] = [];
  const result = delegatePaideiaTraining({ context, command: await command(body), args: ["--dry-run"], dryRun: true,
    timeoutMs: 5000, streams: { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) }, ...overrides });
  return { result, stdout, stderr };
}

describe("Paideia public CLI delegation", () => {
  it("passes literal argv and a private context, forwards streams and removes the temporary handoff", async () => {
    const injected = "`touch /tmp/spawnfile-must-not-execute` $(false) with spaces";
    const { result, stdout, stderr } = await invoke(`
const fs = require("node:fs");
const args = process.argv.slice(2), file = args[2];
console.log(JSON.stringify({args,context:JSON.parse(fs.readFileSync(file,"utf8")),mode:fs.statSync(file).mode & 511,file}));
process.stderr.write("diagnostic without newline");
${dryReceipt}`, { args: ["--train", injected, "--editable", "a.md", "--editable", "b.md",
      "--judge-citation-repairs", "editor=1", "--judge-citation-repairs", injected, "--dry-run"] });
    expect(await result).toBe(0);
    const observed = JSON.parse(stdout[0]!);
    expect(observed.args.slice(0, 2)).toEqual(["train", "--spawnfile-context"]);
    expect(observed.args.slice(3)).toEqual(["--train", injected, "--editable", "a.md", "--editable", "b.md",
      "--judge-citation-repairs", "editor=1", "--judge-citation-repairs", injected, "--dry-run"]);
    expect(observed.context).toEqual(context);
    expect(observed.mode).toBe(0o600);
    expect(stderr).toEqual(["diagnostic without newline"]);
    await expect(access(observed.file)).rejects.toThrow();
  });

  it.each([
    "", 'console.log(" ");', 'console.log("not json");', 'console.log("null");',
    'console.log(JSON.stringify({schema:"paideia.training-cost-plan.v1",modelCallsMade:1}));',
    `${dryReceipt} console.log("done");`
  ])("rejects empty, malformed or nonfinal success receipts: %s", async (body) => {
    const run = await invoke(body);
    await expect(run.result).rejects.toThrow("required final training receipt");
  });

  it("handles a receipt without a newline and ordinary blank lines", async () => {
    const run = await invoke('process.stdout.write("\\n\\r\\n" + JSON.stringify({schema:"paideia.training-cost-plan.v1",modelCallsMade:0}));');
    expect(await run.result).toBe(0);
  });

  it("rejects every host actual-training path before invoking a model executable", async () => {
    for (const body of [completed, dryReceipt, 'console.log("unexpected");']) {
      const run = await invoke(body, { dryRun: false, args: [] });
      await expect(run.result).rejects.toThrow("host execution is disabled");
      expect(run.stdout).toEqual([]);
    }
  });

  it("propagates receiver errors without requiring a success receipt", async () => {
    const run = await invoke('console.error("unsupported native preparation"); process.exitCode=2;');
    expect(await run.result).toBe(2);
    expect(run.stderr).toEqual(["unsupported native preparation"]);
  });

  it("reports missing executables without fallback", async () => {
    const run = await invoke(dryReceipt, { command: "/does-not-exist/paideia" });
    await expect(run.result).rejects.toThrow("Could not start Paideia");
  });

  it("cancels a running child and cleans up the context", async () => {
    const controller = new AbortController();
    let contextPath = "";
    const run = await invoke('console.log(process.argv[4]); setInterval(()=>{},100);', {
      signal: controller.signal, streams: { stdout: (line) => { contextPath = line; controller.abort(); }, stderr: () => undefined }
    });
    expect(await run.result).toBe(130);
    await expect(access(contextPath)).rejects.toThrow();
  });

  it("does not spawn when already cancelled", async () => {
    const controller = new AbortController(); controller.abort();
    const run = await invoke("throw Error('must not run');", { signal: controller.signal });
    expect(await run.result).toBe(130);
    expect(run.stdout).toEqual([]);
  });

  it.each([["SIGINT", 130], ["SIGTERM", 143]] as const)("forwards parent %s and removes its signal handler", async (signal, expected) => {
    const registered = vi.spyOn(process, "once");
    let listener: (() => void) | undefined;
    const run = await invoke('console.log("ready"); setInterval(()=>{},100);', {
      streams: { stdout: () => {
        listener = registered.mock.calls.findLast(([name]) => name === signal)?.[1] as (() => void) | undefined;
        expect(listener).toBeTypeOf("function"); listener!();
      }, stderr: () => undefined }
    });
    expect(await run.result).toBe(expected);
    expect(process.listeners(signal)).not.toContain(listener);
  });

  it("force-stops a child that ignores graceful termination", async () => {
    const controller = new AbortController();
    const run = await invoke('process.on("SIGTERM",()=>{}); console.log("ready"); setInterval(()=>{},100);', {
      signal: controller.signal, streams: { stdout: () => controller.abort(), stderr: () => undefined }
    });
    expect(await run.result).toBe(130);
  });

  it.each([true, false])("terminates descendants with inherited output=%s after the native leader exits on cancellation", async (inherited) => {
    await descendantTrial(inherited, true);
  });

  it.each([true, false])("confirms supervisor and descendant quiescence before success with inherited output=%s", async (inherited) => {
    await descendantTrial(inherited, false);
  });

  it("reports unknown group cleanup as an error and never signals after the supervisor is reaped", async () => {
    const original = process.kill.bind(process);
    const kill = vi.spyOn(process, "kill").mockImplementation((pid, signal) => signal === 0 ? true : original(pid, signal));
    const run = await invoke(dryReceipt);
    await expect(run.result).rejects.toThrow("quiescence is unknown");
    const firstProbe = kill.mock.calls.findIndex(([, signal]) => signal === 0);
    expect(firstProbe).toBeGreaterThan(-1);
    expect(kill.mock.calls.slice(firstProbe).every(([, signal]) => signal === 0)).toBe(true);
  });

  it("bounds hung children and oversized output", async () => {
    const hung = await invoke('setInterval(()=>{},100);', { timeoutMs: 100 });
    await expect(hung.result).rejects.toThrow("command deadline");
    const noisy = await invoke('process.stdout.write("x".repeat(1024*1024+1)); setInterval(()=>{},100);');
    await expect(noisy.result).rejects.toThrow("bounded JSON-line contract");
  });

  it("preserves a child signal outcome", async () => {
    const run = await invoke('process.kill(process.pid,"SIGTERM");');
    expect(await run.result).toBe(143);
  });

  it("rejects an oversized context before spawning", async () => {
    const run = await invoke("throw Error('must not run');", { context: { ...context,
      producer: { package: "spawnfile", version: "v".repeat(1024 * 1024) } } });
    await expect(run.result).rejects.toThrow("context exceeds 1 MiB");
  });
});

async function descendantTrial(inherited: boolean, cancel: boolean): Promise<void> {
  const folder = await mkdtemp(path.join(os.tmpdir(), "spawnfile-training-descendant-")); directories.push(folder);
  const ready = path.join(folder, "ready");
  const descendant = 'process.on("SIGTERM",()=>{}); require("node:fs").writeFileSync(' + JSON.stringify(ready) + ',"ready");setInterval(()=>{},100);';
  const leader = 'const {spawn}=require("node:child_process"),fs=require("node:fs");process.on("SIGTERM",()=>process.exit(0));'
    + `const descendant=spawn(process.execPath,["-e",${JSON.stringify(descendant)}],{stdio:${JSON.stringify(inherited ? ["ignore", "inherit", "inherit"] : "ignore")}});`
    + `const timer=setInterval(()=>{if(!fs.existsSync(${JSON.stringify(ready)}))return;clearInterval(timer);`
    + 'console.log(JSON.stringify({leader:process.pid,supervisor:process.ppid,descendant:descendant.pid}));'
    + (cancel ? 'setInterval(()=>{},100);' : `${dryReceipt} process.exit(0);`) + '},10);';
  const controller = new AbortController();
  let pids: { leader: number; supervisor: number; descendant: number } | undefined;
  const run = await invoke(leader, { signal: controller.signal, streams: { stdout: (line) => {
    const value = JSON.parse(line);
    if (typeof value.descendant === "number") { pids = value; if (cancel) controller.abort(); }
  }, stderr: () => undefined } });
  expect(await run.result).toBe(cancel ? 130 : 0);
  expect(pids).toBeDefined();
  for (const pid of Object.values(pids!)) expect(() => process.kill(pid, 0)).toThrow(/ESRCH/u);
}
