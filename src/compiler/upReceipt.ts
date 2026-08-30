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

const createReceiptMoltnetIdentity = (
  release: NonNullable<UpProjectResult["report"]["container"]>["moltnet"] extends infer Moltnet
    ? Moltnet extends { release?: infer Identity } ? Identity : never
    : never
) => {
  if (!release) return undefined;
  // Discriminate on PROVENANCE, never on capability count. A published release
  // now advertises `daimon-bridge` too (moltnet v0.1.18), so `length === 1` would
  // route it into the local-development branch and reject it for lacking a
  // `development` marker it is never supposed to have.
  //
  // The canonical list lives in `moltnetReleaseAuthority.ts`, but the H2 boundary
  // (`../deployment/organizationHandoffTypes.test.ts`) forbids this file from
  // importing any `moltnet*` module, so the ordering is compared inline here the
  // same way the local branch below already compares it. `upReceiptTypes.ts`'s
  // schema is the authority that rejects any other list on parse.
  const joined = release.capabilities.join("\0");
  const receiptCapabilities: ["daimon-bridge", "pi-bridge"] | ["pi-bridge"] | null =
    joined === "daimon-bridge\0pi-bridge"
      ? ["daimon-bridge", "pi-bridge"]
      : joined === "pi-bridge" ? ["pi-bridge"] : null;
  if (receiptCapabilities === null) {
    throw new SpawnfileError("runtime_error", "Moltnet receipt advertises unknown bridge capabilities");
  }
  if (!release.development) {
    if (!release.release_version || !release.source_revision) {
      throw new SpawnfileError("runtime_error", "Published Moltnet receipt lacks its pinned source identity");
    }
    return {
      architecture: release.architecture,
      asset: release.asset,
      asset_sha256: release.asset_sha256,
      capabilities: receiptCapabilities,
      release_version: release.release_version,
      source_revision: release.source_revision,
      version: release.version
    };
  }
  if (
    release.capabilities.join("\0") !== "daimon-bridge\0pi-bridge" ||
    !release.source_sha256
  ) {
    throw new SpawnfileError("runtime_error", "Local Moltnet receipt lacks its development provenance");
  }
  return {
    architecture: release.architecture,
    asset: release.asset,
    asset_sha256: release.asset_sha256,
    capabilities: ["daimon-bridge", "pi-bridge"] as ["daimon-bridge", "pi-bridge"],
    development: release.development,
    source_sha256: release.source_sha256,
    version: release.version
  };
};

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
      ? { moltnet_release: createReceiptMoltnetIdentity(result.report.container.moltnet.release) }
      : {}),
    ...(record?.organization_handoff ? { organization_handoff: record.organization_handoff } : {}),
    ...(record?.organization_handoff_handle ? { organization_handoff_handle: record.organization_handoff_handle } : {}),
    ...(record?.organization_ready ? { organization_ready: record.organization_ready } : {})
  };
};
