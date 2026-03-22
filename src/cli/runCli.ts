import { Command } from "commander";

import {
  buildCompilePlan,
  buildProject,
  compileProject,
  initProject
} from "../compiler/index.js";
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

export interface CliHandlers {
  buildCompilePlan: typeof buildCompilePlan;
  buildProject: typeof buildProject;
  compileProject: typeof compileProject;
  initProject: typeof initProject;
  listRuntimeAdapters: typeof listRuntimeAdapters;
}

const createDefaultHandlers = (): CliHandlers => ({
  buildCompilePlan,
  buildProject,
  compileProject,
  initProject,
  listRuntimeAdapters
});

const formatPlanSummary = (plan: Awaited<ReturnType<typeof buildCompilePlan>>): string =>
  [
    `root: ${plan.root}`,
    `nodes: ${plan.nodes.length}`,
    `runtimes: ${Object.keys(plan.runtimes).sort().join(", ") || "none"}`
  ].join("\n");

export const runCli = async (
  argv: string[],
  streams: CliStreams = createDefaultStreams(),
  handlerOverrides: Partial<CliHandlers> = {}
): Promise<number> => {
  const handlers = { ...createDefaultHandlers(), ...handlerOverrides };
  const program = new Command();
  program.name("spawnfile").description("Spawnfile v0.1 compiler");

  program
    .command("compile")
    .argument("[path]", "Project directory or Spawnfile path", process.cwd())
    .option("-o, --out <directory>", "Output directory")
    .action(async (inputPath: string, options: { out?: string }) => {
      const result = await handlers.compileProject(inputPath, { outputDirectory: options.out });
      streams.stdout(`compiled to ${result.outputDirectory}`);
      streams.stdout(`report: ${result.reportPath}`);
    });

  program
    .command("build")
    .argument("[path]", "Project directory or Spawnfile path", process.cwd())
    .option("-o, --out <directory>", "Output directory")
    .option("-t, --tag <image>", "Docker image tag")
    .action(async (inputPath: string, options: { out?: string; tag?: string }) => {
      const result = await handlers.buildProject(inputPath, {
        imageTag: options.tag,
        outputDirectory: options.out
      });
      streams.stdout(`built image ${result.imageTag}`);
      streams.stdout(`compiled to ${result.outputDirectory}`);
      streams.stdout(`report: ${result.reportPath}`);
    });

  program
    .command("init")
    .argument("[path]", "Directory to initialize", process.cwd())
    .option("--team", "Initialize a team project")
    .action(async (inputPath: string, options: { team?: boolean }) => {
      const result = await handlers.initProject({ directory: inputPath, team: options.team });
      streams.stdout(`initialized ${result.directory}`);
      for (const filePath of result.createdFiles) {
        streams.stdout(`created ${filePath}`);
      }
    });

  program
    .command("validate")
    .argument("[path]", "Project directory or Spawnfile path", process.cwd())
    .action(async (inputPath: string) => {
      const plan = await handlers.buildCompilePlan(inputPath);
      streams.stdout("validation succeeded");
      streams.stdout(formatPlanSummary(plan));
    });

  program
    .command("runtimes")
    .description("List bundled runtime adapters")
    .action(() => {
      for (const runtimeName of handlers.listRuntimeAdapters()) {
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
