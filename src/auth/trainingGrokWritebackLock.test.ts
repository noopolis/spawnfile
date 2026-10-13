import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { acquireTrainingGrokWritebackLock } from "./trainingGrokWritebackLock.js";
import { writeBackTrainingGrokCredential } from "./trainingGrokWriteback.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

it("excludes a live holder and reacquires after release", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "grok-lock-"))); roots.push(root);
  const profile = path.join(root, "profile");
  const release = await acquireTrainingGrokWritebackLock(profile);
  try {
    await expect(acquireTrainingGrokWritebackLock(profile)).rejects.toThrow(/locked/u);
    await expect(acquireTrainingGrokWritebackLock(profile, 50)).rejects.toThrow(/locked/u);
    // A same-process contender must not accidentally release the kernel lock.
    const module = new URL("./trainingGrokWritebackLock.ts", import.meta.url).href;
    const contender = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
      import { acquireTrainingGrokWritebackLock } from ${JSON.stringify(module)};
      try { const release = await acquireTrainingGrokWritebackLock(process.argv[1]); release(); process.exitCode = 2; }
      catch (error) { if (!/locked/u.test(error.message)) process.exitCode = 3; }
    `, profile], { stdio: "ignore" });
    expect((await once(contender, "exit"))[0]).toBe(0);
  }
  finally { release(); }
  const again = await acquireTrainingGrokWritebackLock(profile);
  again();
});

it("yields to a same-process holder and acquires without caller retries", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "grok-lock-wait-"))); roots.push(root);
  const profile = path.join(root, "profile");
  const release = await acquireTrainingGrokWritebackLock(profile);
  const timer = setTimeout(release, 50);
  try {
    const again = await acquireTrainingGrokWritebackLock(profile, 1000);
    again();
  } finally { clearTimeout(timer); }
});

it("reacquires after SIGKILL without finally or deleting the lock inode", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "grok-lock-crash-"))); roots.push(root);
  const profile = path.join(root, "profile");
  const module = new URL("./trainingGrokWritebackLock.ts", import.meta.url).href;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    import { acquireTrainingGrokWritebackLock } from ${JSON.stringify(module)};
    await acquireTrainingGrokWritebackLock(process.argv[1]);
    process.send("locked");
    setInterval(() => {}, 1000);
  `, profile], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  const exited = once(child, "exit");
  try {
    await Promise.race([once(child, "message").then(([message]) => expect(message).toBe("locked")),
      exited.then(() => { throw Error("Lock holder exited before acquisition"); })]);
    await expect(acquireTrainingGrokWritebackLock(profile)).rejects.toThrow(/locked/u);
    const waiting = acquireTrainingGrokWritebackLock(profile, 1000);
    const timer = setTimeout(() => { child.kill("SIGKILL"); }, 50);
    try { (await waiting)(); } finally { clearTimeout(timer); }
    expect((await exited)[1]).toBe("SIGKILL");
    const credential = (day: number) => JSON.stringify({ "https://auth.x.ai::fixture": {
      key: "synthetic", refresh_token: "synthetic", expires_at: `2030-01-0${day}T00:00:00Z`
    } });
    const digest = (bytes: string) => createHash("sha256").update(bytes).digest("hex");
    const candidate = path.join(root, "candidate"), journal = path.join(root, "journal");
    await writeFile(profile, credential(1), { mode: 0o600 });
    await writeFile(candidate, credential(2), { mode: 0o600 });
    await writeFile(journal, JSON.stringify({ version: "noopolis.daimon.broker-credential-journal.v1", state: "promoted",
      generation: 1, sourceDigest: digest(credential(1)), promotedDigest: digest(credential(2)) }), { mode: 0o600 });
    expect(await writeBackTrainingGrokCredential(profile, candidate, journal)).toBe(true);
    expect(await readFile(profile, "utf8")).toBe(credential(2));
  } finally { child.kill("SIGKILL"); await exited; }
});
