import type { Command } from "commander";

import type {
  TargetPublicArtifactSnapshotRequest,
} from "../target/publicArtifactSnapshot.js";
import type {
  TargetTopologyAttestationRequest,
} from "../target/contracts.js";
import type { TargetWorldClockRequest } from "../target/worldClock.js";
import type { TargetWorldReadinessRequest } from "../target/worldReadiness.js";

import { registerContainerBundleCommand } from "./containerBundleCommand.js";
import type { TargetDefaultConfig } from "./targetDefaultConfig.js";
import {
  readTargetDefaultConfigStdin,
  readTargetWorldReadinessConfigStdin,
} from "./targetDefaultConfigStdin.js";
import { createProductionTargetWorldQuerySession } from "./targetDefaultWorldQueries.js";
import {
  registerTargetConfigResolverCommand,
  TARGET_CONFIG_RESOLVER_COMMAND,
} from "./targetConfigResolverCommand.js";
import { createProductionTargetLookupLoader } from "./targetLookupCommands.js";
import {
  registerTargetCommands,
  type SetTargetCommandExitCode,
  type TargetCommandHandlers,
  type TargetCommandHandlerSession,
  type TargetCommandStreams,
} from "./targetCommands.js";

export const createProductionTargetCommandSession = (
  config: TargetDefaultConfig
): TargetCommandHandlerSession => Object.freeze({
  activateTopology: async (request: TargetTopologyAttestationRequest) => {
    const { activateTargetDefaultTopology } = await import("./targetDefaultHandlers.js");
    return activateTargetDefaultTopology(config, request);
  },
  run: async <Result>(
    invokeHandlers: (handlers: TargetCommandHandlers) => Promise<Result>
  ): Promise<Result> => {
    const { withTargetDefaultHandlerSession } = await import("./targetDefaultHandlers.js");
    return withTargetDefaultHandlerSession(config, invokeHandlers);
  },
  attestTopology: async (request: TargetTopologyAttestationRequest) => {
    const { attestTargetDefaultTopology } = await import("./targetDefaultHandlers.js");
    return attestTargetDefaultTopology(config, request);
  },
  queryWorldReadiness: async (request: TargetWorldReadinessRequest) => {
    const { queryTargetDefaultWorldReadiness } = await import(
      "./targetDefaultWorldReadiness.js"
    );
    return queryTargetDefaultWorldReadiness(config, request);
  },
  queryWorldClock: async (request: TargetWorldClockRequest) => {
    const { queryTargetDefaultWorldClock } = await import("./targetDefaultWorldClock.js");
    return queryTargetDefaultWorldClock(config, request);
  },
  snapshotPublicArtifact: async (request: TargetPublicArtifactSnapshotRequest) => {
    const { snapshotTargetDefaultPublicArtifact } = await import("./targetDefaultHandlers.js");
    return snapshotTargetDefaultPublicArtifact(config, request);
  },
});

export const registerProductionTargetCommands = (
  program: Command,
  streams: TargetCommandStreams,
  stdin: AsyncIterable<unknown>,
  setExitCode: SetTargetCommandExitCode
): void => {
  const target = registerTargetCommands(
    program,
    async (configInput) => {
      if (configInput !== "-") throw new TypeError("Invalid target configuration");
      return createProductionTargetCommandSession(await readTargetDefaultConfigStdin(stdin));
    },
    streams,
    setExitCode,
    createProductionTargetLookupLoader(stdin),
    async (configInput) => {
      if (configInput !== "-") throw new TypeError("Invalid target configuration");
      return createProductionTargetWorldQuerySession(
        await readTargetWorldReadinessConfigStdin(stdin)
      );
    },
    [TARGET_CONFIG_RESOLVER_COMMAND]
  );
  registerContainerBundleCommand(target, stdin, streams, setExitCode);
  registerTargetConfigResolverCommand(target, streams, setExitCode);
};
