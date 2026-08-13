import {
  readDeploymentRecord,
  UP_RECEIPT_VERSION,
  type CompiledEngineEntry,
  type CompiledScheduleEntry,
  type UpReceipt
} from "../deployment/index.js";
import { SpawnfileError } from "../shared/index.js";

import { buildCompilePlan } from "./buildCompilePlan.js";
import type { CompilePlan, CompilePlanNode, ResolvedAgentNode } from "./types.js";
import type { UpProjectResult } from "./upProject.js";

/**
 * Extracts the `{agent, cron}` pairs an up-receipt's `compiled_schedule` field carries
 * (Decision 21 Piece 4) — the raw material for simfile's wake-diff denominator oracle.
 * Only `kind: "cron"` schedules are represented; `every`/`disabled` schedules have no
 * cron-fire cadence to diff against sim-time and are intentionally omitted, not zeroed.
 */
export const resolveCompiledSchedule = (plan: CompilePlan): CompiledScheduleEntry[] =>
  plan.nodes
    .filter((node): node is CompilePlanNode & { value: ResolvedAgentNode } => node.kind === "agent")
    .flatMap((node) => {
      const schedule = node.value.schedule;
      return schedule?.kind === "cron" ? [{ agent: node.id, cron: schedule.cron }] : [];
    })
    .sort((left, right) => left.agent.localeCompare(right.agent));

/**
 * Extracts `{agent, engine}` pairs (Piece 5, Slice B) — disclosure ground truth for the
 * run-manifest's `pinned-engine` field, so a `scripted` (or any non-default) pi engine is
 * visibly disclosed rather than an invisible test-only branch. Reads
 * `report.container.runtime_instances[].engine_by_node_id`, the single source of truth
 * `containerArtifacts.ts` already stamps from the pi adapter's own resolved engine kinds
 * (see `src/runtime/pi/adapter.ts`'s `createContainerTargets`) — deliberately not
 * re-derived from a fresh `buildCompilePlan` walk (unlike `resolveCompiledSchedule` above),
 * since that would recompute the exact same fact from pi-adapter-internal logic
 * (`resolvePiEngine`) that compiler code has no business reaching into directly.
 */
export const resolveCompiledEngines = (
  report: UpProjectResult["report"]
): CompiledEngineEntry[] =>
  (report.container?.runtime_instances ?? [])
    .flatMap((instance) => Object.entries(instance.engine_by_node_id ?? {}))
    .map(([agent, engine]) => ({ agent, engine }))
    .sort((left, right) => left.agent.localeCompare(right.agent));

/**
 * Builds `spawnfile.up-receipt.v1` from a project-path `upProject()` result. Reads back
 * the deployment record `upProject` already wrote (for `run_id`/deployment name/container
 * id — the same record `spawnfile artifacts export`/`spawnfile down` resolve), and
 * re-derives `compiled_schedule` from the resolved graph, since `compileProject` does not
 * retain its own `CompilePlan` past the compile step.
 *
 * `readiness` reuses whatever signal `upProject` already has — a bare `docker run -d`
 * that returned a container id, not a new health probe: `up` has never polled
 * application-level readiness, and this receipt does not invent one. `moltnet_base_url`
 * comes straight from the compiled container report's own managed/external server plan;
 * no credentials ever land on this contract (contracts.md).
 */
export const buildUpReceipt = async (
  inputPath: string,
  result: UpProjectResult
): Promise<UpReceipt> => {
  const plan = await buildCompilePlan(inputPath);
  const compiledSchedule = resolveCompiledSchedule(plan);
  const compiledEngines = resolveCompiledEngines(result.report);

  const record = result.deploymentRecordPath
    ? await readDeploymentRecord(result.deploymentRecordPath)
    : null;
  const unit = record?.units[0] ?? null;
  const containerIds = unit?.container_id ? [unit.container_id] : [];

  const fingerprint = result.report.compile_fingerprint;
  if (!fingerprint) {
    throw new SpawnfileError(
      "runtime_error",
      "Compiled output has no compile_fingerprint; cannot build an up-receipt"
    );
  }

  return {
    version: UP_RECEIPT_VERSION,
    run_id: record?.run_id ?? null,
    fingerprint,
    deployment: {
      name: record?.name ?? null,
      container_ids: containerIds
    },
    readiness: {
      state: containerIds.length > 0 ? "running" : "unknown",
      moltnet_base_url: result.report.container?.moltnet?.server_plans?.[0]?.base_url ?? null
    },
    compiled_schedule: compiledSchedule,
    engines: compiledEngines,
    ...(result.report.container?.moltnet?.release
      ? { moltnet_release: {
          ...result.report.container.moltnet.release,
          capabilities: ["pi-bridge"] as ["pi-bridge"]
        } }
      : {}),
    ...(record?.organization_handoff ? { organization_handoff: record.organization_handoff } : {}),
    ...(record?.organization_handoff_handle ? { organization_handoff_handle: record.organization_handoff_handle } : {}),
    ...(record?.organization_ready ? { organization_ready: record.organization_ready } : {})
  };
};
