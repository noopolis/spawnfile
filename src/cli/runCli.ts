import { errorExitCode } from "../shared/errors.js";
import { skipAdapterOptions, splitAdapterOptions } from "./adapterOptions.js";
import { formatCliErrorMessage, isCommanderError } from "./cliErrors.js";
import { isTargetLookupInvocation, targetLookupOperandIndex, targetLookupValueOptions } from "./targetCliRoute.js";
import type { CliHandlers } from "./cliProgram.js";

export type { CliHandlers } from "./cliProgram.js";

export interface CliStreams { stderr: (message: string) => void; stdout: (message: string) => void; }

const createDefaultStreams = (): CliStreams => ({
  stderr: (message) => process.stderr.write(`${message}\n`),
  stdout: (message) => process.stdout.write(`${message}\n`)
});

export interface CliRenderEnvironment {
  ci: boolean;
  noColor: boolean;
  stdoutIsTty: boolean;
}
const createDefaultRenderEnvironment = (): CliRenderEnvironment => ({
  ci: process.env.CI !== undefined && process.env.CI !== "" && process.env.CI !== "0",
  noColor: process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== "",
  stdoutIsTty: process.stdout.isTTY === true
});

export interface RunCliOptions {
  adapterCwd?: string;
  handlers?: Partial<CliHandlers>; renderEnvironment?: CliRenderEnvironment; stdin?: AsyncIterable<unknown>; streams?: CliStreams; signal?: AbortSignal;
}

const isCliStreams = (value: CliStreams | RunCliOptions | undefined): value is CliStreams => {
  const candidate = value as Partial<CliStreams> | undefined;
  return typeof candidate?.stderr === "function" && typeof candidate.stdout === "function";
};

export type NormalizedRunCliOptions = Required<Omit<RunCliOptions, "signal" | "adapterCwd">>
  & Pick<RunCliOptions, "signal" | "adapterCwd">;

const normalizeRunCliOptions = (
  optionsOrStreams?: CliStreams | RunCliOptions,
  handlerOverrides: Partial<CliHandlers> = {}
): NormalizedRunCliOptions => isCliStreams(optionsOrStreams)
  ? {
      handlers: handlerOverrides,
      renderEnvironment: createDefaultRenderEnvironment(),
      stdin: process.stdin,
      streams: optionsOrStreams
    }
  : {
      adapterCwd: optionsOrStreams?.adapterCwd,
      handlers: optionsOrStreams?.handlers ?? handlerOverrides,
      renderEnvironment: optionsOrStreams?.renderEnvironment ?? createDefaultRenderEnvironment(),
      stdin: optionsOrStreams?.stdin ?? process.stdin,
      streams: optionsOrStreams?.streams ?? createDefaultStreams(),
      signal: optionsOrStreams?.signal
    };

type RunCli = {
  (argv: string[], options?: RunCliOptions): Promise<number>;
  (
    argv: string[], streams?: CliStreams, handlerOverrides?: Partial<CliHandlers>
  ): Promise<number>;
};

export const runCli: RunCli = async (
  argv: string[],
  optionsOrStreams?: CliStreams | RunCliOptions,
  handlerOverrides: Partial<CliHandlers> = {}
): Promise<number> => {
  const cliOptions = normalizeRunCliOptions(optionsOrStreams, handlerOverrides);
  const { streams } = cliOptions;
  const first = skipAdapterOptions(argv, 0);
  const command = argv[first];
  const isTarget = command === "target";

  try {
    const dedicated = await findDedicatedHandler(argv, first, cliOptions);
    const cli = dedicated ? undefined : await createProgram(cliOptions, isTarget);
    const { args, adapters } = splitAdapterOptions(argv, cli?.program ?? dedicated?.valueOptions);
    const useDedicated = dedicated && (!isTarget || isTargetLookupInvocation(args));
    const run = async () => {
      if (useDedicated) return dedicated.handle(args);
      const selected = cli ?? await createProgram(cliOptions, isTarget);
      await selected.program.parseAsync(args, { from: "user" });
      return selected.exitCode();
    };
    if (useDedicated && adapters.length === 0) return await run();

    const { loadRuntimeAdapterPlugins } = await import("../runtime/loadAdapterPlugins.js");
    const { withRuntimeAdapterPlugins } = await import("../runtime/registry.js");
    const plugins = await loadRuntimeAdapterPlugins(adapters, { cwd: cliOptions.adapterCwd });
    return await withRuntimeAdapterPlugins(plugins, run);
  } catch (error: unknown) {
    if (isCommanderError(error)) {
      if (isTarget && error.exitCode !== 0) streams.stderr("error: Invalid target command");
      return error.exitCode === 0 ? 0 : 2;
    }
    streams.stderr(`error: ${formatCliErrorMessage(error)}`);
    return errorExitCode(error);
  }
};

const createProgram = async (options: NormalizedRunCliOptions, isTarget: boolean) =>
  (await import("./cliProgram.js")).createCliProgram(options, isTarget);

interface DedicatedHandler {
  handle(args: string[]): Promise<number>;
  valueOptions?: ReadonlySet<string>;
}

const findDedicatedHandler = async (
  argv: string[],
  first: number,
  { stdin, streams }: NormalizedRunCliOptions
): Promise<DedicatedHandler | undefined> => {
  const second = skipAdapterOptions(argv, first + 1);
  const command = argv[first];
  const prefix = argv[second] === undefined ? [] : [command!, argv[second]];

  if (command === "canary") {
    const route = await import("./canaryCutoverCommand.js");
    if (route.isCanaryCutoverInvocation(prefix)) return { handle: route.runCanaryCutoverCommand };
  }
  if (command === "product-state") {
    const route = await import("./productStateCloneCommand.js");
    if (route.isProductStateCloneInvocation(prefix)) return { handle: route.runProductStateCloneCommand };
  }
  if (command === "workspace-resource") {
    const route = await import("./workspaceResourceMigrationCommand.js");
    if (route.isWorkspaceResourceMigrationInvocation(prefix)) return {
      handle: (args) => route.runWorkspaceResourceMigrationCommand(args, streams),
      valueOptions: route.workspaceResourceValueOptions
    };
  }
  if (command === "target" && argv[targetLookupOperandIndex(argv, first + 1)] === "lookup_operation") {
    return {
      handle: async (args) => (await import("./targetLookupCli.js")).runTargetLookupCli(args, stdin, streams),
      valueOptions: targetLookupValueOptions
    };
  }
  return undefined;
};
