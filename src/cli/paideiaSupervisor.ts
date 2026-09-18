import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type PaideiaProcessOutcome =
  | { type: "paideia.process.exited"; code: number | null; signal: NodeJS.Signals | null }
  | { type: "paideia.process.launch-error"; message: string };

type SupervisorProcess = Pick<NodeJS.Process, "send" | "pid" | "on" | "removeListener" | "kill" | "exit">;
export interface PaideiaSupervisorHost {
  process: SupervisorProcess;
  launch(command: string, args: string[]): ChildProcess;
}
const defaultHost: PaideiaSupervisorHost = {
  process,
  launch: (command, args) => spawn(command, args, { shell: false, stdio: ["ignore", "inherit", "inherit"] })
};

/** Remains the owned group leader until the parent closes the entire group. */
export const supervisePaideia = (argv: readonly string[], host: PaideiaSupervisorHost = defaultHost): (() => void) => {
  const [command, ...args] = argv;
  if (!command || !host.process.send) throw new Error("Paideia supervisor requires an executable and private IPC");
  const hold = setInterval(() => undefined, 1000);
  const ignore = (): void => undefined;
  const disconnect = (): void => {
    // This process is still alive: its own group identity cannot have been recycled.
    try { host.process.kill(-host.process.pid, "SIGKILL"); }
    finally { host.process.exit(1); }
  };
  host.process.on("SIGINT", ignore).on("SIGTERM", ignore).on("disconnect", disconnect);
  let reported = false;
  const report = (outcome: PaideiaProcessOutcome): void => {
    if (reported) return;
    reported = true;
    host.process.send!(outcome);
  };
  const child = host.launch(command, args);
  child.once("error", (error) => report({ type: "paideia.process.launch-error", message: error.message }));
  child.once("exit", (code, signal) => report({ type: "paideia.process.exited", code, signal }));
  return () => {
    clearInterval(hold);
    host.process.removeListener("SIGINT", ignore).removeListener("SIGTERM", ignore).removeListener("disconnect", disconnect);
  };
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { supervisePaideia(process.argv.slice(2)); }
  catch (error) { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; }
}
