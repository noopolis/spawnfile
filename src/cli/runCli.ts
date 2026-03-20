import { Command } from "commander";

import { buildCompilePlan, compileProject, initProject } from "../compiler/index.js";
import { isSpawnfileError } from "../shared/index.js";
import { listRuntimeAdapters } from "../runtime/index.js";

export interface CliStreams {
  stderr: (message: string) => void;
  stdout: (message: string) => void;
}

const createDefaultStreams = (): CliStreams => ({
  stderr: (message) => process.stderr.write(`${message}\n`),
  stdout: (message) => process.stdout.write(`${message}\n`)
});

const formatPlanSummary = (plan: Awaited<ReturnType<typeof buildCompilePlan>>): string =>
  [
    `root: ${plan.root}`,
    `nodes: ${plan.nodes.length}`,
    `runtimes: ${Object.keys(plan.runtimes).sort().join(", ") || "none"}`
  ].join("\n");

export const runCli = async (
  argv: string[],
  streams: CliStreams = createDefaultStreams()
): Promise<number> => {
  const program = new Command();
  program.name("spawnfile").description("Spawnfile v0.1 compiler");

  program
    .command("compile")
    .argument("[path]", "Project directory or Spawnfile path", process.cwd())
    .option("-o, --out <directory>", "Output directory")
    .action(async (inputPath: string, options: { out?: string }) => {
      const result = await compileProject(inputPath, { outputDirectory: options.out });
      streams.stdout(`compiled to ${result.outputDirectory}`);
      streams.stdout(`report: ${result.reportPath}`);
    });

  program
    .command("init")
    .argument("[path]", "Directory to initialize", process.cwd())
    .option("--team", "Initialize a team project")
    .action(async (inputPath: string, options: { team?: boolean }) => {
      const result = await initProject({ directory: inputPath, team: options.team });
      streams.stdout(`initialized ${result.directory}`);
      for (const filePath of result.createdFiles) {
        streams.stdout(`created ${filePath}`);
      }
    });

  program
    .command("validate")
    .argument("[path]", "Project directory or Spawnfile path", process.cwd())
    .action(async (inputPath: string) => {
      const plan = await buildCompilePlan(inputPath);
      streams.stdout("validation succeeded");
      streams.stdout(formatPlanSummary(plan));
    });

  program
    .command("runtimes")
    .description("List bundled runtime adapters")
    .action(() => {
      for (const runtimeName of listRuntimeAdapters()) {
        streams.stdout(runtimeName);
      }
    });

  try {
    await program.parseAsync(argv, { from: "user" });
    return 0;
  } catch (error: unknown) {
    const message = isSpawnfileError(error)
      ? `${error.code}: ${error.message}`
      : error instanceof Error
        ? error.message
        : String(error);

    streams.stderr(message);
    return 1;
  }
};
