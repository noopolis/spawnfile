import type { DockerArtifactExecutor } from "../target/dockerArtifactsProvider.js";

export interface PrepareEvidenceHelperInput {
  readonly baseImage: string;
  readonly context: string;
  readonly executor: DockerArtifactExecutor;
  readonly privateRoot: string;
  readonly signal?: AbortSignal;
  /** Test-only fault injection at durable/mutation/receipt boundaries. */
  readonly testHooks?: {
    readonly afterBuild?: () => Promise<void> | void;
    readonly afterComplete?: () => Promise<void> | void;
    readonly afterReserve?: () => Promise<void> | void;
    readonly beforeBuild?: () => Promise<void> | void;
    readonly beforeComplete?: () => Promise<void> | void;
    readonly beforeReceipt?: () => Promise<void> | void;
    readonly beforeReserve?: () => Promise<void> | void;
  };
  readonly timeoutMs?: number;
}
