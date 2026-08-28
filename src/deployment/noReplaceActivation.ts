import { execFile as execFileCallback } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const MAX_OUTPUT = 4096;
const TIMEOUT_MS = 5_000;
type HelperResult = { stderr: string; stdout: string };
type HelperRun = (file: string, args: string[], options: { encoding: "utf8"; maxBuffer: number; timeout: number; windowsHide: true }) => Promise<HelperResult>;

const component = (value: string): boolean => value.length > 0 && value !== "." && value !== ".." && !value.includes(path.sep);

export const activateNoReplaceWith = async (temporaryPath: string, destinationPath: string, runtime: { arch: string; platform: string; run: HelperRun }): Promise<void> => {
  if (runtime.platform !== "linux" || (runtime.arch !== "x64" && runtime.arch !== "arm64")) throw new Error("Workspace resource atomic no-replace activation is unsupported on this platform");
  const parent = path.dirname(temporaryPath);
  if (parent !== path.dirname(destinationPath) || !path.isAbsolute(parent)) throw new Error("Workspace resource activation paths must share one canonical parent");
  const source = path.basename(temporaryPath); const destination = path.basename(destinationPath);
  if (!component(source) || !component(destination)) throw new Error("Workspace resource activation names must be single components");
  const helper = fileURLToPath(new URL(`./native/rename-noreplace-${runtime.arch}`, import.meta.url));
  try {
    const result = await runtime.run(helper, [parent, source, destination], { encoding: "utf8", maxBuffer: MAX_OUTPUT, timeout: TIMEOUT_MS, windowsHide: true });
    if (result.stderr !== "" || result.stdout !== '{"ok":true}\n') throw new Error("Workspace resource atomic helper returned malformed output");
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { stdout?: string; killed?: boolean };
    if (failure.killed || failure.code === "ETIMEDOUT") throw new Error("Workspace resource atomic helper timed out");
    if (failure.code === "ENOENT") throw new Error("Workspace resource atomic helper is missing");
    if (typeof failure.stdout === "string" && failure.stdout.length <= MAX_OUTPUT) {
      try {
        const parsed = JSON.parse(failure.stdout) as { error?: string; ok?: boolean };
        if (parsed.ok === false && ["EEXIST", "EXDEV", "ENOSYS", "EOPNOTSUPP"].includes(parsed.error ?? "")) {
          const mapped = new Error(`Workspace resource atomic activation failed: ${parsed.error}`) as NodeJS.ErrnoException; mapped.code = parsed.error; throw mapped;
        }
      } catch (parsedError) { if ((parsedError as NodeJS.ErrnoException).code) throw parsedError; }
    }
    if (failure.message.includes("malformed output")) throw failure;
    throw new Error("Workspace resource atomic helper failed closed");
  }
};

export const activateNoReplace = async (temporaryPath: string, destinationPath: string): Promise<void> =>
  await activateNoReplaceWith(temporaryPath, destinationPath, { arch: process.arch, platform: process.platform, run: execFile });
