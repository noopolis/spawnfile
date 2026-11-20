import type { Observation, ObservationCoverage, RuntimeTrainingCapability, Usage } from "./trainingTypes.js";

/** One compiled agent, running as its normal container user. All paths are inside that trial. */
export interface NativeTrainingInstance {
  configPath: string;
  homePath: string;
  workspacePath: string;
  exec(argv: readonly string[], options?: {
    env?: Readonly<Record<string, string>>;
    signal?: AbortSignal;
    timeoutMs?: number;
  }): Promise<string>;
  readFile(absolutePath: string): Promise<string | null>;
}

export interface NativeTrainingTurn {
  trialId: string;
  wakeId: string;
  /** The harness session stays the same for all turns of this isolated trial. */
  sessionId: string;
  text: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface NativeTrainingReply {
  text: string;
  observations?: readonly Observation[];
  toolCoverage: ObservationCoverage;
  usage?: Usage | null;
}

/** Adapters implement their native delivery and decode only evidence belonging to this turn. */
export interface NativeTrainingDriver {
  run(instance: NativeTrainingInstance, turn: NativeTrainingTurn): Promise<NativeTrainingReply>;
}

/** Use the ordinary compiled agent and shared grader with a harness-owned native driver. */
export function nativeTrainingCapability(
  runtime: string, loadDriver: () => Promise<NativeTrainingDriver>
): RuntimeTrainingCapability {
  return {
    adapterId: runtime,
    subject: async () => ({
      create() { throw new Error(`Train ${runtime} through spawnfile train with a selected project`); }
    }),
    run: async options => {
      const { runNativeTraining } = await import("./nativeTrainingRun.js");
      return runNativeTraining(runtime, await loadDriver(), options);
    }
  };
}
