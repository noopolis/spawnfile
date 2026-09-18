import { execFile } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { promisify } from "node:util";
import { expect, it } from "vitest";
const execute = promisify(execFile);
it("rejects a FIFO before any blocking read in a bounded child", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "training-auth-fifo-")));
  try {
    const source = path.join(root, "fifo"), home = path.join(root, "home");
    await mkdir(home, { mode: 0o700 }); await execute("mkfifo", [source]);
    const module = new URL("./trainingAuth.ts", import.meta.url).href;
    const script = `const {stageTrainingAuth}=await import(${JSON.stringify(module)});try{await stageTrainingAuth(${JSON.stringify({home,source,provider:"codex"})});throw Error("unexpected stage")}catch(error){if(!String(error).includes("bounded nonempty regular leaf"))throw error;console.log("FIFO_REJECTED_WITHOUT_BLOCKING")}`;
    const result = await execute(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], { timeout: 2500 });
    expect(result.stdout.trim()).toBe("FIFO_REJECTED_WITHOUT_BLOCKING");
  } finally { await rm(root, { recursive: true, force: true }); }
});
