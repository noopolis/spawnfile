import type { CompileReport, ContainerPersistentMountReport } from "../report/index.js";
import { getRuntimeOperations, listRuntimeOperations, requireRuntimeAdapters } from "../runtime/registry.js";
import type { RuntimeExportFile, RuntimeUsageOperations } from "../runtime/operations.js";

export type PlannedExportFile = RuntimeExportFile;

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

const planUsageFiles = (
  usage: RuntimeUsageOperations, mounts: ReadonlyMap<string, ContainerPersistentMountReport>
): PlannedExportFile[] => {
  const mount = mounts.get(usage.mountId);
  if (!mount) return [];
  return (["filePath", "rotatedFilePath"] as const).map((generation) => ({
    optional: true,
    relativePath: usage.exportedPaths[generation],
    source: { kind: "volume", volumeName: mount.volume_name, volumePath: usage.volumePaths[generation] }
  }));
};

/** Every runtime a compile report names; an absent adapter would silently plan zero files. */
export const compileReportRuntimeNames = (report: CompileReport): string[] => [
  ...(report.container?.runtime_instances ?? []).map((instance) => instance.runtime),
  ...(report.container?.runtimes_installed ?? []),
  ...(report.nodes ?? []).flatMap((node) => node.runtime ? [node.runtime] : [])
];

export const requireCompileReportAdapters = (report: CompileReport, operation: string): void =>
  requireRuntimeAdapters(compileReportRuntimeNames(report), operation);

/** Resolves every durable artifact file this run's compile report declares, and where each
 * one is read from. Pure function of the compile report alone (no deployment record, no
 * Docker) — `artifactsExport.ts` supplies the live container name at execution time. */
export const planArtifactExports = (report: CompileReport): PlannedExportFile[] => {
  requireCompileReportAdapters(report, "export this deployment's artifacts");
  const mounts = mountById(report.container?.persistent_mounts);
  return [
    ...planMoltnetFiles(report, mounts),
    ...planMnemeFiles(report, mounts),
    ...(report.container?.runtime_instances ?? []).flatMap((instance) =>
      getRuntimeOperations(instance.runtime)?.exportFiles?.(instance, mounts) ?? []),
    ...listRuntimeOperations().flatMap(({ usage }) => usage ? planUsageFiles(usage, mounts) : [])
  ];
};
