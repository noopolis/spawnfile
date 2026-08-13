import path from "node:path/posix";

import type { CompileReport, ContainerPersistentMountReport } from "../report/index.js";

/** One durable-artifact file `spawnfile artifacts export` egresses, and where it lands
 * under `<out>` (Decision 21 §2 run-dir layout). Pure planning data — no Docker/IO here;
 * `artifactsExport.ts` executes each plan entry and `artifactsExportDocker.ts` knows how. */
export interface PlannedExportFile {
  /** Path relative to the export destination directory, e.g. "raw/moltnet/causal.jsonl". */
  relativePath: string;
  source:
    | { kind: "volume"; volumeName: string; volumePath: string }
    | { kind: "container"; containerPath: string };
  /** True when the file may legitimately be absent (e.g. a bank's causal.jsonl before any
   * recall event, or events.jsonl before any memory write) — a missing optional file is a
   * silent skip, never a diagnostic. Non-optional sources missing is worth flagging. */
  optional: boolean;
}

const AGENT_NODE_ID_PREFIX = "agent:";
const TEAM_NODE_ID_PREFIX = "team:";

/** Strips the compiler's `agent:` node-id prefix down to the generated runtime slug, the
 * same convention `src/e2e/moltnetMemeticsArtifacts.ts`'s `agentSlugFromNodeId` uses (kept
 * as a local copy here rather than an import: compiler/deployment code must not depend on
 * `src/e2e`, per that folder's own charter — e2e depends on compiler, never the reverse). */
const agentSlugFromNodeId = (nodeId: string): string | null => {
  if (nodeId.startsWith(AGENT_NODE_ID_PREFIX)) {
    return nodeId.slice(AGENT_NODE_ID_PREFIX.length);
  }
  return nodeId.startsWith(TEAM_NODE_ID_PREFIX) ? null : nodeId;
};

const mountById = (
  mounts: ContainerPersistentMountReport[] | undefined
): Map<string, ContainerPersistentMountReport> =>
  new Map((mounts ?? []).map((mount) => [mount.id, mount]));

/** Moltnet: one `causal.jsonl` and one `transcript.json` per managed network, always
 * mounted at the causal directory's own root (see `moltnetArtifacts.ts`'s
 * `createMoltnetCausalDirectory` — the mount path IS the directory the event file lives
 * directly under). A single managed network exports to the flat `raw/moltnet/causal.jsonl`;
 * more than one disambiguates by network id under `raw/moltnet/<network_id>/causal.jsonl`.
 *
 * The transcript rides the SAME mount deliberately: the causal log records only
 * `content_sha256`, so the transcript's text is verified against the log sitting beside it
 * rather than trusted on its own. See moltnet's `internal/observability/transcript.go` for
 * why that volume now holds message bodies and what its attestation does and does not
 * cover. */
const planMoltnetFiles = (
  report: CompileReport,
  mounts: Map<string, ContainerPersistentMountReport>
): PlannedExportFile[] => {
  const managedNetworkIds = (report.container?.moltnet?.server_plans ?? [])
    .filter((serverPlan) => serverPlan.mode === "managed")
    .map((serverPlan) => serverPlan.network_id);

  const resolved = managedNetworkIds
    .map((networkId) => ({ mount: mounts.get(`moltnet-${networkId}-causal`), networkId }))
    .filter((entry): entry is { mount: ContainerPersistentMountReport; networkId: string } =>
      entry.mount !== undefined);

  const singleNetwork = resolved.length === 1;
  return resolved.flatMap(({ mount, networkId }) => [{
    // A managed network that received zero room messages has no causal.jsonl yet — no
    // room activity is a legitimate (if unusual) state, not an export failure.
    optional: true,
    relativePath: singleNetwork
      ? "raw/moltnet/causal.jsonl"
      : `raw/moltnet/${networkId}/causal.jsonl`,
    source: { kind: "volume", volumeName: mount.volume_name, volumePath: "causal.jsonl" }
  }, {
    // Optional for the same reason: a network with zero accepted messages has no
    // transcript yet.
    optional: true,
    relativePath: singleNetwork
      ? "raw/moltnet/transcript.json"
      : `raw/moltnet/${networkId}/transcript.json`,
    source: { kind: "volume", volumeName: mount.volume_name, volumePath: "transcript.json" }
  }]);
};

/** Mneme: each durable (json/sqlite-backed) bank writes its append-only ledger
 * (`events.jsonl`) and causal stream (`causal.jsonl`) into a `memory/` subdirectory of its
 * own mount root — not the mount root itself (verified live; see
 * `ecosystem/mneme/src/store/store.ts`'s `JsonlMemoryStore` and `causalStore.ts`'s
 * `CausalEventStore`, both keyed off the same `<runtimeHomePath>/memory` dir, where
 * `runtimeHomePath` is exactly this mount's path). Both files are optional: a bank with no
 * recall yet has no causal.jsonl, and one with no writes yet has no events.jsonl. */
const planMnemeFiles = (
  report: CompileReport,
  mounts: Map<string, ContainerPersistentMountReport>
): PlannedExportFile[] =>
  (report.container?.memory ?? []).flatMap((bank) => {
    const mountId = bank.store.persistent_mount_id;
    const mount = mountId ? mounts.get(mountId) : undefined;
    if (!mount) {
      return [];
    }

    return ["causal.jsonl", "events.jsonl"].map((fileName) => ({
      optional: true,
      relativePath: `raw/mneme/${bank.id}/${fileName}`,
      source: {
        kind: "volume" as const,
        volumeName: mount.volume_name,
        volumePath: `memory/${fileName}`
      }
    }));
  });

/** Daimon: per pi/daimon runtime instance, per agent it covers, the turn-causal telemetry
 * stream at `runtime/agents/<slug>/telemetry/causal.jsonl` under the instance root (see
 * `ecosystem/daimon/src/observability/causalEvents.ts`). As of Piece 4b, that directory is
 * a run-scoped durable volume (`daimonTelemetryArtifacts.ts`, mirroring how
 * `moltnetArtifacts.ts` mounts the Moltnet causal directory), resolved here via each
 * instance's `telemetry_mount_ids` (node id -> persistent mount id). This is the real
 * relaxation of the export-before-teardown invariant (Decision 21) for daimon truth:
 * `spawnfile down` (without `--volumes`) can run BEFORE `spawnfile artifacts export`, and
 * export still recovers every agent's causal.jsonl from its named volume.
 *
 * The `instance.home_path`-keyed branch below is a legacy fallback for a compile report
 * written before Piece 4b (no `telemetry_mount_ids` yet) — it reads the old container-local
 * path with `docker cp`, which only works while the container is still live. Any report
 * produced by this compiler build always populates `telemetry_mount_ids` for a pi/daimon
 * instance, so that branch never fires today; it exists only so an out-of-date report
 * doesn't silently export zero daimon files. Optional either way: a fresh instance that
 * never woke has no telemetry file yet. */
const planDaimonFiles = (
  report: CompileReport,
  mounts: Map<string, ContainerPersistentMountReport>
): PlannedExportFile[] =>
  (report.container?.runtime_instances ?? [])
    .filter((instance) => instance.runtime === "pi" || instance.runtime === "daimon")
    .flatMap((instance) =>
      (instance.node_ids ?? []).flatMap((nodeId): PlannedExportFile[] => {
        const slug = agentSlugFromNodeId(nodeId);
        if (!slug) {
          return [];
        }

        const mountId = instance.telemetry_mount_ids?.[nodeId];
        const mount = mountId ? mounts.get(mountId) : undefined;
        if (mount) {
          return [{
            optional: true,
            relativePath: `raw/daimon/${slug}/causal.jsonl`,
            source: {
              kind: "volume" as const,
              volumeName: mount.volume_name,
              volumePath: "causal.jsonl"
            }
          }];
        }

        if (!instance.home_path) {
          return [];
        }
        const instanceRoot = path.dirname(instance.home_path);
        return [{
          optional: true,
          relativePath: `raw/daimon/${slug}/causal.jsonl`,
          source: {
            kind: "container" as const,
            containerPath: `${instanceRoot}/runtime/agents/${slug}/telemetry/causal.jsonl`
          }
        }];
      })
    );

/** Resolves every durable artifact file this run's compile report declares, and where each
 * one is read from. Pure function of the compile report alone (no deployment record, no
 * Docker) — `artifactsExport.ts` supplies the live container name at execution time. */
export const planArtifactExports = (report: CompileReport): PlannedExportFile[] => {
  const mounts = mountById(report.container?.persistent_mounts);
  return [
    ...planMoltnetFiles(report, mounts),
    ...planMnemeFiles(report, mounts),
    ...planDaimonFiles(report, mounts)
  ];
};
