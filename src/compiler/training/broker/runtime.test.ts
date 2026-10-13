import { execFile, spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, lstat, rm, symlink, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { renderTrainingSlotWipe, probeTrainingWorker } from "./runtime.js";
import { trainingSlotPaths } from "./paths.js";

const run = promisify(execFile);
const fixture = async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "slot-wipe-")));
  const mapped = (p: string) => `${root}${p}`;
  for (let slot = 0; slot < 4; slot++) {
    const p = trainingSlotPaths(slot);
    for (const dir of [p.workerHome, p.privateTmp, p.runtimeHome, p.state, p.workspace, p.usageDirectory, `${p.workerHome}/.grok`]) {
      await mkdir(mapped(dir), { recursive: true });
      await writeFile(`${mapped(dir)}/trial-data`, `slot-${slot}`);
    }
    for (const file of [p.preflightReceipt, p.sealedInputsAttestation, p.generationFile]) await writeFile(mapped(file), `slot-${slot}`);
  }
  const script = renderTrainingSlotWipe(1).join("\n")
    .replaceAll("/run/training", `${root}/run/training`).replaceAll("/var/lib/daimon-workers", `${root}/var/lib/daimon-workers`)
    .replace("spawnfile_mount_points=$(awk '{print $5}' /proc/self/mountinfo)", "spawnfile_mount_points=''");
  // Execute the actual wipe with privilege operations stubbed: this portable test proves deletion scope,
  // inode retention and symlink refusal. Linux uid/capability enforcement is a separate integration gate.
  const harness = "chown() { :; }\nsetpriv() { while [ \"$1\" != -- ]; do shift; done; shift; \"$@\"; }\n" + script;
  return { root, mapped, harness };
};

it("executes slot 1's wipe while retaining sibling files, worker tmp inodes and running broker stand-ins", async () => {
  const f = await fixture();
  const children = Array.from({ length: 3 }, () => spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" }));
  try {
    const home = trainingSlotPaths(1).workerHome, tmp = trainingSlotPaths(1).privateTmp;
    const before = await Promise.all([home, tmp].map(p => lstat(f.mapped(p))));
    await run("/bin/bash", ["-ceu", f.harness]);
    for (const i of [0, 2, 3]) {
      const p = trainingSlotPaths(i);
      for (const dir of [p.workerHome, p.privateTmp, p.workspace, p.runtimeHome, p.state, p.usageDirectory])
        expect(await readFile(`${f.mapped(dir)}/trial-data`, "utf8")).toBe(`slot-${i}`);
    }
    for (const dir of [home, tmp, trainingSlotPaths(1).workspace, trainingSlotPaths(1).usageDirectory])
      await expect(readFile(`${f.mapped(dir)}/trial-data`)).rejects.toMatchObject({ code: "ENOENT" });
    const after = await Promise.all([home, tmp].map(p => lstat(f.mapped(p))));
    expect(after.map(s => [s.ino, s.uid, s.mode])).toEqual(before.map(s => [s.ino, s.uid, s.mode]));
    expect(await readFile(f.mapped(trainingSlotPaths(1).generationFile), "utf8")).toBe("slot-1");
    for (const child of children) { expect(child.exitCode).toBeNull(); expect(process.kill(child.pid!, 0)).toBe(true); }
  } finally { for (const child of children) child.kill(); await rm(f.root, { recursive: true, force: true }); }
});

it("refuses a symlinked registered wipe root before touching its target", async () => {
  const f = await fixture();
  try {
    const p = trainingSlotPaths(1), sibling = trainingSlotPaths(0);
    await rm(f.mapped(p.workspace), { recursive: true });
    await symlink(f.mapped(sibling.workspace), f.mapped(p.workspace));
    await expect(run("/bin/bash", ["-ceu", f.harness])).rejects.toThrow();
    expect(await readFile(`${f.mapped(sibling.workspace)}/trial-data`, "utf8")).toBe("slot-0");
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

it("requires an explicit worker-uid denial verdict; failed execution and empty output never certify isolation", async () => {
  expect(await probeTrainingWorker(2201, "/run/training/slots/0", "read", async (_cmd, args) => {
    expect(args).toContain("--reuid=2201");
    expect(args.at(-1)).toContain("test -r '/run/training/slots/0'");
    return { stdout: "denied\n" };
  })).toBe(true);
  expect(await probeTrainingWorker(2201, "/run/training/inputs", "enter", async (_cmd, args) => {
    expect(args.at(-1)).toContain("test -x"); return { stdout: "reachable\n" };
  })).toBe(false);
  await expect(probeTrainingWorker(2201, "/run/training/slots/0", "read", async () => ({ stdout: "" }))).rejects.toThrow(/verdict/);
  await expect(probeTrainingWorker(2201, "/run/training/slots/0", "read", async () => { throw Error("setpriv failed"); })).rejects.toThrow(/setpriv failed/);
});
