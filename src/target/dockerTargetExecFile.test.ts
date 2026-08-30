import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createBoundedDockerTargetExecFile } from "./dockerTargetExecFile.js";

const roots: string[] = [];
const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; }
  catch { return false; }
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("bounded Docker target executable", () => {
  it("delivers the exact build context on stdin", async () => {
    const execute = createBoundedDockerTargetExecFile();
    const result = await execute(process.execPath, [
      "--input-type=module", "-e",
      "const chunks=[];for await(const chunk of process.stdin)chunks.push(chunk);process.stdout.write(Buffer.concat(chunks).toString('hex'))",
    ], { stdin: Uint8Array.from([0, 1, 2, 255]), timeout: 2_000 });
    expect(result.stdout).toBe("000102ff");
  });

  it.skipIf(process.platform === "win32").each(["abort", "timeout"] as const)(
    "bounds %s and kills a descendant retaining inherited stdio",
    async (mode) => {
      const root = await mkdtemp(path.join(os.tmpdir(), "spawnfile-target-exec-"));
      roots.push(root);
      const pidFile = path.join(root, "descendant.pid");
      const program = [
        "import { spawn } from 'node:child_process';",
        "import { writeFileSync } from 'node:fs';",
        "const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:['ignore',1,2]});",
        `writeFileSync(${JSON.stringify(pidFile)},String(child.pid));`,
        "setInterval(()=>{},1000);",
      ].join("");
      const controller = new AbortController();
      const started = Date.now();
      const execution = createBoundedDockerTargetExecFile()(process.execPath, [
        "--input-type=module", "-e", program,
      ], { signal: controller.signal, timeout: mode === "timeout" ? 100 : 2_000 });
      if (mode === "abort") setTimeout(() => controller.abort(), 100);
      await expect(execution).rejects.toMatchObject({ kind: mode === "abort" ? "aborted" : "timeout" });
      expect(Date.now() - started).toBeLessThan(1_000);
      const descendant = Number(await readFile(pidFile, "utf8"));
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(alive(descendant)).toBe(false);
    },
  );

  it.skipIf(process.platform === "win32")(
    "reports unresolved cleanup when the process group cannot be signalled or proved absent",
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "spawnfile-target-eperm-"));
      roots.push(root);
      const pidFile = path.join(root, "group.pid");
      const program = `import{writeFileSync}from'node:fs';writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000)`;
      const realKill = process.kill.bind(process);
      const denied = vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: number | NodeJS.Signals) => {
        if (pid < 0) throw Object.assign(new Error("denied"), { code: "EPERM" });
        return realKill(pid, signal);
      }) as typeof process.kill);
      const started = Date.now();
      try {
        await expect(createBoundedDockerTargetExecFile()(process.execPath, [
          "--input-type=module", "-e", program,
        ], { timeout: 100 })).rejects.toMatchObject({ kind: "cleanup_failed" });
        expect(Date.now() - started).toBeGreaterThanOrEqual(300);
        expect(Date.now() - started).toBeLessThan(1_000);
      } finally {
        denied.mockRestore();
        const group = Number(await readFile(pidFile, "utf8"));
        try { realKill(-group, "SIGKILL"); } catch { /* test cleanup */ }
      }
    },
  );
});
