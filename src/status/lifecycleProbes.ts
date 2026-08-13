import path from "node:path";

import { getRuntimeAdapter, RUNTIME_INSTALL_ROOT } from "../runtime/index.js";

import type { LoadedCompileReport, StatusReportNode, StatusReportRuntimeInstance } from "./compileReport.js";
import type { StatusObservation } from "./types.js";

/**
 * Offline agent-lifecycle cross-check probes (B38). Every function here is
 * pure over the already-loaded compile report plus an injected `readFile`
 * — no direct `node:fs` access, so both the static (`--out <dir>` present)
 * and home-deployment (no on-disk compiled output) `spawnfile status`
 * paths can drive it with different readers. Cardinal rule, same as
 * `src/audit/`: absent input is `unknown`, never `ok` — a probe with
 * nothing to check reports `unknown`, it does not go silent.
 */
export type LifecycleReadFile = (filePath: string) => Promise<string | null>;

export interface CollectLifecycleProbeOptions {
  loadedReport: LoadedCompileReport;
  /** Compiled output directory to resolve on-disk paths against. `null` when there is no compiled output tree to read (home-deployment status). */
  outputDirectory: string | null;
  readFile: LifecycleReadFile;
}

const CONTAINER_ROOTFS_ROOT = "container/rootfs";
// B62 Option B (src/runtime/pi/appControlSource.ts): the operator-only
// mutating wake route and its fail-closed gate env/marker.
const PI_OPERATOR_ROUTE_MARKER = "/spawnfile/agents/";
const PI_CONTROL_TOKEN_ENV = "SPAWNFILE_PI_CONTROL_TOKEN";
const PI_FAIL_CLOSED_MARKER = "no operator token configured (";
// B93: the recipe env assignment containerEntrypointRender.ts stamps into
// the compiled entrypoint only when the compile-host process env carried a
// run id (see src/runtime/common.ts's resolveNoopolisRunId).
const NOOPOLIS_RUN_ID_MARKER = "NOOPOLIS_RUN_ID=";
// Both adapter names lower to the same generated Pi runtime app
// (src/runtime/pi/adapter.ts); the daimon adapter is a `{...piAdapter, name: "daimon"}` spread.
const PI_LIKE_RUNTIMES = new Set(["daimon", "pi"]);

const LIFECYCLE_KEYS = [
  "lifecycle.instance.coverage",
  "lifecycle.instance.runtime",
  "lifecycle.instance.paths",
  "lifecycle.wake.operator",
  "lifecycle.run_id"
] as const;

const createObservation = (
  input: Omit<StatusObservation, "label" | "source">
): StatusObservation => ({
  ...input,
  label: `${input.severity.toUpperCase()} ${input.key}`,
  source: "compile_report"
});

const instanceSubject = (instanceId: string): string => `runtime-instance:${instanceId}`;

/** No compile report at all: every key is reported once, unknown, never omitted and never ok. */
const missingReportObservations = (): StatusObservation[] =>
  LIFECYCLE_KEYS.map((key) => createObservation({
    key,
    message: `${key} was not checked: no compile report is available`,
    severity: "unknown",
    subject: "compile"
  }));

const collectInstanceCoverageObservations = (
  nodes: StatusReportNode[],
  instances: StatusReportRuntimeInstance[]
): StatusObservation[] => {
  const coveredNodeIds = new Set(instances.flatMap((instance) => instance.nodeIds));

  return nodes
    .filter((node) => node.kind === "agent")
    .map((node) => {
      const covered = coveredNodeIds.has(node.id);
      return createObservation({
        key: "lifecycle.instance.coverage",
        message: covered
          ? `${node.id} is covered by a compiled runtime instance's node_ids`
          : `${node.id} does not appear in any compiled runtime instance's node_ids`,
        severity: covered ? "ok" : "error",
        subject: node.id
      });
    });
};

const collectInstanceRuntimeObservations = (
  instances: StatusReportRuntimeInstance[]
): StatusObservation[] =>
  instances.map((instance) => {
    try {
      getRuntimeAdapter(instance.runtime);
      return createObservation({
        key: "lifecycle.instance.runtime",
        message: `${instance.id} resolves to the ${instance.runtime} runtime adapter`,
        severity: "ok",
        subject: instanceSubject(instance.id)
      });
    } catch (error) {
      return createObservation({
        key: "lifecycle.instance.runtime",
        message: error instanceof Error ? error.message : String(error),
        severity: "error",
        subject: instanceSubject(instance.id)
      });
    }
  });

const collectInstancePathsObservations = (
  instances: StatusReportRuntimeInstance[]
): StatusObservation[] =>
  instances.map((instance) => {
    const subject = instanceSubject(instance.id);
    if (!instance.configPath) {
      return createObservation({
        key: "lifecycle.instance.paths",
        message: `${instance.id} is missing a configPath`,
        severity: "error",
        subject
      });
    }

    const missing = [
      !instance.homePath ? "homePath" : null,
      !instance.workspacePath ? "workspacePath" : null
    ].filter((entry): entry is string => entry !== null);
    if (missing.length > 0) {
      return createObservation({
        key: "lifecycle.instance.paths",
        message: `${instance.id} is missing ${missing.join(" and ")}`,
        severity: "warn",
        subject
      });
    }

    return createObservation({
      key: "lifecycle.instance.paths",
      message: `${instance.id} has configPath, homePath, and workspacePath`,
      severity: "ok",
      subject
    });
  });

const piAppSourcePath = (outputDirectory: string, runtimeName: string): string =>
  path.join(outputDirectory, CONTAINER_ROOTFS_ROOT, RUNTIME_INSTALL_ROOT, runtimeName, "app.mjs");

const collectWakeOperatorObservations = async (
  instances: StatusReportRuntimeInstance[],
  outputDirectory: string | null,
  readFile: LifecycleReadFile
): Promise<StatusObservation[]> => {
  const observations: StatusObservation[] = [];

  for (const instance of instances) {
    const subject = instanceSubject(instance.id);

    if (!PI_LIKE_RUNTIMES.has(instance.runtime)) {
      observations.push(createObservation({
        key: "lifecycle.wake.operator",
        message: `${instance.id} uses runtime ${instance.runtime}; the B62 operator wake route is Pi/Daimon-specific and was not checked`,
        severity: "unknown",
        subject
      }));
      continue;
    }

    if (!outputDirectory) {
      observations.push(createObservation({
        key: "lifecycle.wake.operator",
        message: `${instance.id} has no compiled output directory to read the generated runtime app from`,
        severity: "unknown",
        subject
      }));
      continue;
    }

    const filePath = piAppSourcePath(outputDirectory, instance.runtime);
    const content = await readFile(filePath);
    if (content === null) {
      observations.push(createObservation({
        key: "lifecycle.wake.operator",
        message: `${instance.id} generated runtime app is not readable at ${filePath}`,
        severity: "error",
        subject
      }));
      continue;
    }

    const missing = [
      !content.includes(PI_OPERATOR_ROUTE_MARKER) ? "operator wake route" : null,
      !content.includes(PI_CONTROL_TOKEN_ENV) ? `${PI_CONTROL_TOKEN_ENV} reference` : null,
      !content.includes(PI_FAIL_CLOSED_MARKER) ? "fail-closed gate" : null
    ].filter((entry): entry is string => entry !== null);

    observations.push(createObservation({
      key: "lifecycle.wake.operator",
      message: missing.length === 0
        ? `${instance.id} generated runtime app exposes the B62 fail-closed operator wake route`
        : `${instance.id} generated runtime app at ${filePath} is missing: ${missing.join(", ")}`,
      severity: missing.length === 0 ? "ok" : "error",
      subject
    }));
  }

  return observations;
};

const collectRunIdObservation = async (
  entrypointPath: string | null,
  readFile: LifecycleReadFile
): Promise<StatusObservation> => {
  const content = entrypointPath ? await readFile(entrypointPath) : null;
  const hasRunId = content !== null && content.includes(NOOPOLIS_RUN_ID_MARKER);

  return createObservation({
    key: "lifecycle.run_id",
    message: hasRunId
      ? "compiled entrypoint stamps NOOPOLIS_RUN_ID for this run"
      : "not compiled with a run id",
    severity: hasRunId ? "ok" : "unknown",
    subject: "compile"
  });
};

export const collectLifecycleProbeObservations = async (
  options: CollectLifecycleProbeOptions
): Promise<StatusObservation[]> => {
  if (options.loadedReport.kind !== "loaded") {
    return missingReportObservations();
  }

  const { report } = options.loadedReport;

  return [
    ...collectInstanceCoverageObservations(report.nodes, report.runtimeInstances),
    ...collectInstanceRuntimeObservations(report.runtimeInstances),
    ...collectInstancePathsObservations(report.runtimeInstances),
    ...await collectWakeOperatorObservations(report.runtimeInstances, options.outputDirectory, options.readFile),
    await collectRunIdObservation(report.entrypointPath ?? null, options.readFile)
  ];
};
