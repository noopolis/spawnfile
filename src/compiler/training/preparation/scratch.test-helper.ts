import { spawn } from "node:child_process";
import type { PrepareTrainingOptions, PreparedTraining } from "./prepare.js";

/** Real independent launch, held alive after claiming/staging until the test stops it. */
export const startScratchOwner = (staging: string, digest: string, readonly = false, mode: "fresh" | "resume" = "fresh") =>
  startOwner(`
    import { claimTrainingPreparationScratch } from ${JSON.stringify(new URL("./scratch.ts", import.meta.url).href)};
    import { mkdir, writeFile, chmod } from "node:fs/promises";
    import path from "node:path";
    try {
      await claimTrainingPreparationScratch(process.argv[1], process.argv[2], () => {}, process.argv[4]);
      if (process.argv[4] !== "resume") {
        await mkdir(path.join(process.argv[1], "snapshot"));
        await writeFile(path.join(process.argv[1], "snapshot/input"), "sealed", { mode: 0o400 });
        if (process.argv[3] === "readonly") await chmod(path.join(process.argv[1], "snapshot"), 0o500);
      }
      setInterval(() => {}, 1000);
      process.send({ ok: true });
    } catch (error) { process.send({ ok: false, error: error.message }, () => process.exit(1)); }
  `, [staging, digest, readonly ? "readonly" : "writable", mode]);

export const startPreparationOwner = (options: Omit<PrepareTrainingOptions, "process" | "streams">) => startOwner(`
  import { prepareTraining } from ${JSON.stringify(new URL("./prepare.ts", import.meta.url).href)};
  import { imageDocker } from ${JSON.stringify(new URL("./fixtures.test-helper.ts", import.meta.url).href)};
  try {
    const prepared = await prepareTraining({ ...JSON.parse(process.argv[1]), process: imageDocker().process,
      streams: { stdout() {}, stderr() {} } });
    setInterval(() => {}, 1000);
    process.send({ ok: true, prepared });
  } catch (error) { process.send({ ok: false, error: error.message }, () => process.exit(1)); }
`, [JSON.stringify(options)]);

const startOwner = async (source: string, args: string[]) => {
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source, ...args],
    { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  let stderr = "";
  child.stderr!.on("data", chunk => { stderr += String(chunk); });
  const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
  const result = await new Promise<{ ok: boolean; error?: string; prepared?: PreparedTraining }>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(Error(`scratch child timed out: ${stderr}`)); }, 10_000);
    child.once("message", message => { clearTimeout(timer); resolve(message as { ok: boolean; error?: string; prepared?: PreparedTraining }); });
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("exit", () => { clearTimeout(timer); reject(Error(`scratch child exited before its receipt: ${stderr}`)); });
  });
  return { ...result, pid: child.pid!, stop: async () => { child.kill("SIGKILL"); await exited; } };
};

export const leaveAbandonedScratch = async (staging: string, digest: string, readonly = false): Promise<void> => {
  const owner = await startScratchOwner(staging, digest, readonly);
  await owner.stop();
  if (!owner.ok) throw Error(owner.error);
  // Waiting for exit reaps the child, making its PID check positive death evidence.
};
