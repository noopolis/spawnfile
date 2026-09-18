import type { Command } from "commander";

import { SpawnfileError } from "../shared/index.js";
import type { CliHandlers, CliStreams } from "./runCli.js";

const forwarded = ["train", "test", "editable", "resource", "judge", "judge-citation-repairs", "validation-group", "optimizer-model",
  "bridge-command", "out", "max-trials", "max-proposals", "seed", "timeout-ms", "view", "cost-config"] as const;
const repeated = new Set(["editable", "resource", "judge", "judge-citation-repairs", "validation-group"]);
const key = (name: string): string => name.replace(/-([a-z])/gu, (_, letter: string) => letter.toUpperCase());

export const registerTrainCommand = (
  program: Command,
  handlers: CliHandlers,
  streams: CliStreams,
  packageVersion: string,
  setExitCode: (code: number) => void,
  signal?: AbortSignal
): void => {
  const command = program.command("train")
    .description("Train one canonical agent through Paideia's isolated native integration")
    .argument("[path]", "Canonical project directory or Spawnfile path", process.cwd())
    .option("--agent <id>", "Exact canonical agent node id (inferred only for a single-agent project)")
    .option("--paideia-command <executable>", "Installed Paideia executable; no shell or automatic install", "paideia")
    .option("--training-image <immutable-image>", "Pinned image containing the complete training environment")
    .option("--training-config <json>", "V2 image recipe and declared inputs, or advanced v1 local bindings")
    .option("--dry-run", "Validate and estimate without compiling, authenticating or starting models")
    .option("--repair-measurements <parent-out>", "Fork captured work into a fresh output for authorized measurement repair")
    .option("--repair-witness <manifest>", "Explicit verified image witness for a legacy parent")
    .option("--resume", "Resume the exact persisted training experiment in --out");
  for (const name of forwarded) {
    const flag = `--${name} <value>`;
    if (repeated.has(name)) command.option(flag, `Paideia ${name}; repeatable`, (value: string, previous: string[]) => [...previous, value], []);
    else if (name === "train") command.requiredOption(flag, `Paideia ${name}`);
    else command.option(flag, `Paideia ${name}`);
  }
  command.action(async (inputPath: string, options: Record<string, string | string[] | boolean | undefined>) => {
    if (options.dryRun !== true && typeof options.out !== "string") {
      throw new SpawnfileError("validation_error", "Actual training requires --out; dry-run does not write an output directory");
    }
    if (options.dryRun !== true && typeof options.trainingConfig !== "string") {
      throw new SpawnfileError("validation_error", "Actual training requires --training-config; v1 additionally requires --training-image; host execution is disabled");
    }
    const timeout = options.timeoutMs === undefined ? 3_600_000 : Number(options.timeoutMs);
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 3_600_000 ||
      (options.timeoutMs !== undefined && !/^\d+$/u.test(String(options.timeoutMs)))) {
      throw new SpawnfileError("validation_error", "--timeout-ms must be an integer from 1 to 3600000");
    }
    const context = await handlers.createTrainingContext(inputPath, {
      agent: options.agent as string | undefined, packageVersion
    });
    const args: string[] = [];
    for (const name of forwarded) {
      const value = options[key(name)];
      if (typeof value === "string") args.push(`--${name}`, value);
      else if (Array.isArray(value)) for (const item of value) args.push(`--${name}`, item);
    }
    if (options.dryRun === true) args.push("--dry-run");
    if (options.resume === true) args.push("--resume");
    setExitCode(await handlers.delegatePaideiaTraining({ context, args,
      repairMeasurements: options.repairMeasurements as string | undefined, repairWitness: options.repairWitness as string | undefined,
      trainingImage: options.trainingImage as string | undefined, trainingConfig: options.trainingConfig as string | undefined,
      command: options.paideiaCommand as string, dryRun: options.dryRun === true,
      timeoutMs: timeout + 5000, streams, signal }));
  });
};
