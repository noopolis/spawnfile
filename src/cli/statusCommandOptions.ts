import type {
  CompiledProbeCollectors,
  StatusCommandResult,
  StatusOutputMode,
  StatusSelectorInput
} from "../status/index.js";
import {
  collectDeploymentLogObservations,
  collectMoltnetProbeObservations,
  collectRuntimeProbeObservations
} from "../status/index.js";
import { inspectDockerDeployment, recoverDockerDeploymentRecords } from "../deployment/index.js";

import type { CliHandlers, CliStreams } from "./runCli.js";

export type StatusCommandHandlers = Pick<CliHandlers, "buildOrganizationView"> &
  Partial<Pick<CliHandlers, "requireAuthProfile">>;

export interface StatusCommandLiveHandlers {
  collectDeploymentLogObservations?: typeof collectDeploymentLogObservations;
  collectMoltnetProbeObservations?: typeof collectMoltnetProbeObservations;
  collectRuntimeProbeObservations?: typeof collectRuntimeProbeObservations;
  compiledProbeCollectors?: CompiledProbeCollectors;
  inspectDockerDeployment?: typeof inspectDockerDeployment;
  recoverDockerDeploymentRecords?: typeof recoverDockerDeploymentRecords;
}

export type StatusCommandHandlersWithLive = StatusCommandHandlers & StatusCommandLiveHandlers;

export interface StatusCommandOptions {
  agent?: string;
  context?: string;
  deployment?: string;
  dockerCommand?: string;
  image?: boolean;
  json?: boolean;
  live?: boolean;
  logs?: boolean;
  network?: string;
  out?: string;
  pretty?: boolean;
  pull?: boolean;
  pullCheck?: boolean;
  quiet?: boolean;
  recover?: boolean;
  runtime?: string;
  team?: string;
  timeout?: string;
  watch?: boolean;
}

export const statusInputFailure = (message: string): StatusCommandResult => ({
  error: message,
  exitCode: 2
});

export const resolveStatusOutputMode = (
  options: StatusCommandOptions
): StatusOutputMode | StatusCommandResult => {
  const modes: StatusOutputMode[] = [
    ...(options.json ? ["json" as const] : []),
    ...(options.pretty ? ["pretty" as const] : []),
    ...(options.quiet ? ["quiet" as const] : [])
  ];

  if (modes.length > 1) {
    return statusInputFailure("Choose only one status output mode: --pretty, --json, or --quiet");
  }

  return modes[0] ?? "pretty";
};

export const resolveStatusSelectorInput = (
  options: StatusCommandOptions
): StatusSelectorInput | null | StatusCommandResult => {
  const selectors = [
    ...(options.agent ? [{ kind: "agent" as const, value: options.agent }] : []),
    ...(options.team ? [{ kind: "team" as const, value: options.team }] : []),
    ...(options.network ? [{ kind: "network" as const, value: options.network }] : []),
    ...(options.runtime ? [{ kind: "runtime" as const, value: options.runtime }] : [])
  ];

  if (selectors.length > 1) {
    return statusInputFailure("Choose only one status selector: --agent, --team, --network, or --runtime");
  }

  return selectors[0] ?? null;
};

export const resolveStatusTimeoutMs = (
  options: StatusCommandOptions
): number | undefined | StatusCommandResult => {
  if (!options.timeout) {
    return undefined;
  }
  const parsed = Number(options.timeout);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return statusInputFailure("status --timeout must be a positive integer number of milliseconds");
  }
  return parsed;
};

export const emitStatusOutput = (streams: CliStreams, output: string): void => {
  for (const line of output.split("\n")) {
    streams.stdout(line);
  }
};
