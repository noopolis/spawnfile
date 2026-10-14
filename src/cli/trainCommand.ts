import type { Command } from "commander";

import { SpawnfileError } from "../shared/index.js";
import type { CliHandlers, CliStreams } from "./runCli.js";

const forwarded = ["train", "test", "editable", "resource", "judge", "judge-citation-repairs", "validation-group", "optimizer-model",
  "bridge-command", "out", "max-trials", "max-proposals", "seed", "timeout-ms", "view", "cost-config", "concurrency"] as const;
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
    .description("Plan, rewind, or train one canonical agent through its declared training inputs")
    .argument("[path]", "Canonical project directory or Spawnfile path", process.cwd())
    .option("--agent <id>", "Canonical agent id or unambiguous short name (inferred for one agent)")
    .option("--paideia-command <executable>", "Installed Paideia executable; no shell or automatic install", "paideia")
    .option("--training-image <immutable-image>", "Pinned image containing the complete training environment")
    .option("--training-config <json>", "V2 image recipe and declared inputs, or advanced v1 local bindings")
    .option("--plan", "Print the resolved training authoring plan without executing training")
    .option("--materialize <example>", "Rewind an authored example into --out without running training")
    .option("--history <directory>", "Local recorded history for --materialize")
    .option("--dry-run", "Validate and estimate without compiling, authenticating or starting models")
    .option("--repair-measurements <parent-out>", "Fork captured work into a fresh output for authorized measurement repair")
    .option("--repair-witness <manifest>", "Explicit verified image witness for a legacy parent")
    .option("--resume", "Resume the exact persisted training experiment in --out");
  for (const name of forwarded) {
    const flag = `--${name} <value>`;
    if (repeated.has(name)) command.option(flag, `Paideia ${name}; repeatable`, (value: string, previous: string[]) => [...previous, value], []);
    else command.option(flag, name === "out" ? "Output directory for training or moment materialization" : `Paideia ${name}`);
  }
  command.action(async (inputPath: string, options: Record<string, string | string[] | boolean | undefined>) => {
    if (typeof options.materialize === "string") {
      if (options.plan === true) {
        throw new SpawnfileError("validation_error", "--materialize and --plan are mutually exclusive");
      }
      if (typeof options.out !== "string") {
        throw new SpawnfileError("validation_error", "--materialize requires --out");
      }
      const project = await handlers.loadTrainingProject(inputPath);
      const plan = handlers.resolveTrainingPlan(project, options.agent as string | undefined, packageVersion);
      const moment = await handlers.materializeTrainingMoment({ plan, project, example: options.materialize,
        historyDir: options.history as string | undefined, out: options.out });
      if (moment.status === "refused") {
        streams.stderr(`error: Moment refused: ${moment.inputs.filter((input) => input.refusal !== null).length} input refusal(s), ${moment.leakCheck.findings} leak finding(s); see moment.json in --out`);
        setExitCode(1);
      } else {
        streams.stdout(JSON.stringify(moment, null, 2));
        setExitCode(0);
      }
      return;
    }
    if (options.history !== undefined) {
      throw new SpawnfileError("validation_error", "--history requires --materialize");
    }
    if (options.plan === true) {
      const plan = await handlers.createTrainingPlan(inputPath, {
        agent: options.agent as string | undefined, packageVersion
      });
      streams.stdout(JSON.stringify(plan, null, 2));
      setExitCode(0);
      return;
    }
    const timeout = options.timeoutMs === undefined ? 3_600_000 : Number(options.timeoutMs);
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 3_600_000 ||
      (options.timeoutMs !== undefined && !/^\d+$/u.test(String(options.timeoutMs)))) {
      throw new SpawnfileError("validation_error", "--timeout-ms must be an integer from 1 to 3600000");
    }
    const args: string[] = [];
    for (const name of forwarded) {
      const value = options[key(name)];
      if (typeof value === "string") args.push(`--${name}`, value);
      else if (Array.isArray(value)) for (const item of value) args.push(`--${name}`, item);
    }
    if (options.dryRun === true) args.push("--dry-run");
    if (options.resume === true) args.push("--resume");
    const project = await handlers.loadTrainingProject(inputPath);
    const plan = handlers.resolveTrainingPlan(project, options.agent as string | undefined, packageVersion);
    const lowered = plan.targets.length > 0 ? await handlers.lowerTrainingExecution({ project, plan, args,
      trainingConfig: options.trainingConfig as string | undefined, trainingImage: options.trainingImage as string | undefined }) : undefined;
    if (lowered && options.dryRun === true) {
      streams.stdout(JSON.stringify({ ...lowered.execution, container: { configPath: lowered.trainingConfig,
        declaration: lowered.declaration, ...(lowered.trainingImage ? { imageOverride: lowered.trainingImage } : {}) } }, null, 2));
      setExitCode(0);
      return;
    }
    if (!lowered && typeof options.train !== "string") {
      throw new SpawnfileError("validation_error", `Agent ${plan.agent.id} has no executable training targets; supply --train`);
    }
    if (!lowered && options.dryRun !== true && typeof options.out !== "string") {
      throw new SpawnfileError("validation_error", "Actual training requires --out when no training targets are declared");
    }
    if (!lowered && options.dryRun !== true && typeof options.trainingConfig !== "string") {
      throw new SpawnfileError("validation_error", "Actual training requires --training-config when no training targets are declared; host execution is disabled");
    }
    const context = await handlers.createTrainingContext(inputPath, { agent: plan.agent.id, packageVersion });
    if (lowered) await handlers.allocateTrainingOutputParent(lowered.execution.output);
    setExitCode(await handlers.delegatePaideiaTraining({ context, args: lowered?.execution.args ?? args, execution: lowered?.execution,
      repairMeasurements: options.repairMeasurements as string | undefined, repairWitness: options.repairWitness as string | undefined,
      trainingImage: lowered?.trainingImage ?? options.trainingImage as string | undefined,
      trainingConfig: lowered?.trainingConfig ?? options.trainingConfig as string | undefined,
      command: options.paideiaCommand as string, dryRun: options.dryRun === true,
      timeoutMs: timeout + 5000, streams, signal }));
  });
};
