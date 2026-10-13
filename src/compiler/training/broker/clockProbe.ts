import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { SpawnfileError } from "../../../shared/index.js";
import { trainingSlotPaths } from "./paths.js";

const run = promisify(execFile);
const quote = (value: string): string => `'${value.replace(/'/gu, `'"'"'`)}'`;

/** Clock directories are public by contract; prove the sibling mask in the worker's mount namespace. */
export const probeTrainingSiblingClock = async (
  slot: number, target: string,
  execute: (command: string, args: string[], options: { timeout: number }) => Promise<{ stdout: string }> = run
): Promise<boolean> => {
  const p = trainingSlotPaths(slot);
  const script = [
    'set -eu',
    `cat ${quote(p.clockFile)} >/dev/null`,
    // Use the same mode-000 directory bind as Grok's deny mounts. Neither an unavailable
    // namespace nor a hidden own clock is a successful denial.
    `blocked=$(mktemp -d ${quote(`${p.privateTmp}/clock-probe.XXXXXX`)})`,
    'trap \'chmod 700 "$blocked"; rmdir "$blocked"\' EXIT',
    'chmod 000 "$blocked"',
    `bwrap --die-with-parent --cap-drop ALL --ro-bind / / --ro-bind "$blocked" ${quote(target)} -- /bin/sh -ceu ${quote(
      `cat ${quote(p.clockFile)} >/dev/null; if ls -A ${quote(target)} >/dev/null 2>&1; then echo reachable; else echo denied; fi`
    )}`
  ].join("\n");
  const result = await execute("setpriv", ["--clear-groups", `--reuid=${p.workerUid}`, `--regid=${p.workerUid}`,
    "--inh-caps=-all", "--ambient-caps=-all", "--bounding-set=-all", "--", "/bin/sh", "-ceu", script], { timeout: 10_000 });
  if (result.stdout.trim() === "denied") return true;
  if (result.stdout.trim() === "reachable") return false;
  throw new SpawnfileError("runtime_error", "Training clock canary returned no verified verdict");
};
