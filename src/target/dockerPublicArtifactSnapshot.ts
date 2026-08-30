import { SpawnfileError } from "../shared/index.js";
import {
  createPublicArtifactReadCommand,
  DockerPublicArtifactNotPresentError,
  type DockerTargetExecutors
} from "./dockerCommandExecutor.js";
import {
  createTargetPublicArtifactSnapshot,
  createTargetPublicArtifactSnapshotNotPresent,
  parseTargetPublicArtifactSnapshotRequest,
  type TargetPublicArtifactSnapshotRequest,
  type TargetPublicArtifactSnapshotResult
} from "./publicArtifactSnapshot.js";
import {
  type DockerWorldServiceExecutor
} from "./dockerWorldServiceProvider.js";
import {
  inspectDockerWorldService,
  sameWorldServiceValue,
  worldServiceSpecForBinding
} from "./dockerWorldServiceLifecycle.js";
import type { WorldServiceAuthorityStore } from "./dockerWorldServiceStore.js";

export const TARGET_PUBLIC_ARTIFACT_SNAPSHOT_ERROR =
  "Target public artifact snapshot failed";

export interface DockerPublicArtifactSnapshotOptions {
  readonly authorityStore: WorldServiceAuthorityStore;
  readonly context: string;
  readonly contentExecutor: DockerTargetExecutors["publicArtifact"];
  readonly executor: DockerWorldServiceExecutor;
  readonly signal?: AbortSignal;
  readonly timeoutMs: number;
}

export interface PublicArtifactSnapshotReader {
  snapshot(raw: unknown): Promise<TargetPublicArtifactSnapshotResult>;
}

const CONTEXT_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/u;
const fail = (): never => {
  throw new SpawnfileError("runtime_error", TARGET_PUBLIC_ARTIFACT_SNAPSHOT_ERROR);
};
const validOptions = (
  raw: DockerPublicArtifactSnapshotOptions
): DockerPublicArtifactSnapshotOptions => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)
    || typeof raw.context !== "string" || !CONTEXT_PATTERN.test(raw.context)
    || typeof raw.contentExecutor !== "function"
    || typeof raw.executor !== "function"
    || !raw.authorityStore || typeof raw.authorityStore.loadService !== "function"
    || !Number.isSafeInteger(raw.timeoutMs) || raw.timeoutMs < 1
    || raw.timeoutMs > 120_000
    || raw.signal !== undefined && !(raw.signal instanceof AbortSignal)) return fail();
  return raw;
};

const exactBinding = async (
  request: TargetPublicArtifactSnapshotRequest,
  options: DockerPublicArtifactSnapshotOptions
) => {
  const binding = await options.authorityStore.loadService(request.world_service_handle);
  const authorization = binding.resolution.authorization;
  if (binding.world_service_handle !== request.world_service_handle
    || authorization.run_id !== request.run_id
    || authorization.descriptor_digest !== request.descriptor_digest
    || !sameWorldServiceValue(authorization.selected_target, request.selected_target)) return fail();
  return binding;
};

const readPublicArtifact = async (
  containerId: string,
  request: TargetPublicArtifactSnapshotRequest,
  options: DockerPublicArtifactSnapshotOptions
): Promise<Uint8Array | null> => {
  let result: { readonly bytes: Uint8Array };
  try {
    result = await options.contentExecutor("docker", createPublicArtifactReadCommand({
      containerId,
      context: options.context,
      path: request.artifact.path
    }), {
      signal: options.signal,
      timeout: options.timeoutMs
    });
  } catch (error) {
    if (error instanceof DockerPublicArtifactNotPresentError) return null;
    return fail();
  }
  if (!result || !(result.bytes instanceof Uint8Array)
    || result.bytes.byteLength > request.artifact.max_bytes) return fail();
  return Uint8Array.from(result.bytes);
};

class DockerPublicArtifactSnapshotReader implements PublicArtifactSnapshotReader {
  readonly #options: DockerPublicArtifactSnapshotOptions;

  public constructor(options: DockerPublicArtifactSnapshotOptions) {
    this.#options = validOptions(options);
  }

  public async snapshot(raw: unknown): Promise<TargetPublicArtifactSnapshotResult> {
    let request: TargetPublicArtifactSnapshotRequest;
    try { request = parseTargetPublicArtifactSnapshotRequest(raw); }
    catch { return fail(); }
    const binding = await exactBinding(request, this.#options).catch(fail);
    const spec = worldServiceSpecForBinding(binding);
    const before = await inspectDockerWorldService(
      binding.container_id,
      spec,
      this.#options
    ).catch(fail);
    if (!before || before.containerId !== binding.container_id
      || before.status !== "running") return fail();

    const content = await readPublicArtifact(
      binding.container_id,
      request,
      this.#options
    );
    const after = await inspectDockerWorldService(
      binding.container_id,
      spec,
      this.#options
    ).catch(fail);
    if (!after || after.containerId !== before.containerId
      || after.status !== "running") return fail();
    return content === null
      ? createTargetPublicArtifactSnapshotNotPresent(request)
      : createTargetPublicArtifactSnapshot({ content, request });
  }
}

export const createDockerPublicArtifactSnapshotReader = (
  options: DockerPublicArtifactSnapshotOptions
): PublicArtifactSnapshotReader => new DockerPublicArtifactSnapshotReader(options);
