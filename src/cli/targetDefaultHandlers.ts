import { createDockerPublicArtifactSnapshotReader } from "../target/dockerPublicArtifactSnapshot.js";
import type {
  TargetResourceRequest,
  TargetTopologyAttestationRequest
} from "../target/contracts.js";
import type { TargetTopologyAttestationResult } from "../target/topologyAttestation.js";
import type {
  TargetPublicArtifactSnapshotRequest,
  TargetPublicArtifactSnapshotResult
} from "../target/publicArtifactSnapshot.js";
import type { TargetTopologyActivationResult } from "../target/topologyActivation.js";

import {
  initializeTargetDefaultAuthoritySession,
  type TargetDefaultAuthoritySession
} from "./targetDefaultAuthorities.js";
import type { TargetDefaultConfig } from "./targetDefaultConfig.js";
import {
  createTargetDefaultHandlers,
  targetDefaultHandlerFactories
} from "./targetDefaultHandlerFactory.js";
import type { TargetCommandHandlers } from "./targetCommands.js";

export {
  createTargetDefaultHandlers,
  type TargetDefaultHandlerFactories
} from "./targetDefaultHandlerFactory.js";

/** A closeable production target handler graph. */
export interface TargetDefaultHandlerSession {
  readonly handlers: TargetCommandHandlers;
  dispose(): Promise<void>;
}

export const createTargetDefaultHandlerSession = async (
  config: TargetDefaultConfig
): Promise<TargetDefaultHandlerSession> => {
  let authoritySession: TargetDefaultAuthoritySession | undefined;
  try {
    authoritySession = await initializeTargetDefaultAuthoritySession(config);
    const handlers = await createTargetDefaultHandlers(
      config,
      targetDefaultHandlerFactories,
      authoritySession.authorities
    );
    return Object.freeze({ handlers, dispose: authoritySession.dispose });
  } catch (error) {
    await authoritySession?.dispose().catch(() => undefined);
    throw error;
  }
};

export const withTargetDefaultHandlerSession = async <Result>(
  config: TargetDefaultConfig,
  invoke: (handlers: TargetCommandHandlers) => Promise<Result>,
  signal?: AbortSignal
): Promise<Result> => {
  if (signal?.aborted) throw new Error("Target handler initialization failed");
  const session = await createTargetDefaultHandlerSession(config);
  return runTargetDefaultHandlerSession(session, invoke, signal);
};

/** The read-only attestor owns the same private authority graph as mutations. */
export const attestTargetDefaultTopology = async (
  config: TargetDefaultConfig,
  request: TargetTopologyAttestationRequest
): Promise<TargetTopologyAttestationResult> => {
  const session = await initializeTargetDefaultAuthoritySession(config);
  try {
    return await session.authorities.topologyAttestor.attest(request);
  } finally {
    await session.dispose();
  }
};

/** Read one exact, bounded public projection from an attested world service. */
export const snapshotTargetDefaultPublicArtifact = async (
  config: TargetDefaultConfig,
  request: TargetPublicArtifactSnapshotRequest
): Promise<TargetPublicArtifactSnapshotResult> => {
  const session = await initializeTargetDefaultAuthoritySession(config);
  try {
    return await createDockerPublicArtifactSnapshotReader({
      authorityStore: session.authorities.worldAuthorityStore,
      context: config.context,
      contentExecutor: session.authorities.executors.publicArtifact,
      executor: session.authorities.executors.world,
      timeoutMs: config.timeoutMs
    }).snapshot(request);
  } finally {
    await session.dispose();
  }
};

export const activateTargetDefaultTopology = async (
  config: TargetDefaultConfig,
  request: TargetTopologyAttestationRequest
): Promise<TargetTopologyActivationResult> => {
  const session = await initializeTargetDefaultAuthoritySession(config);
  try {
    return await session.authorities.topologyAttestor.activate(request);
  } finally {
    await session.dispose();
  }
};

/** Internal lifecycle primitive; not re-exported from the package surface. */
export const runTargetDefaultHandlerSession = async <Result>(
  session: TargetDefaultHandlerSession,
  invoke: (handlers: TargetCommandHandlers) => Promise<Result>,
  signal?: AbortSignal
): Promise<Result> => {
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => closing ??= session.dispose();
  if (signal?.aborted) {
    await close();
    throw new Error("Target handler initialization failed");
  }
  try {
    return await invoke(session.handlers);
  } finally {
    await close();
  }
};
