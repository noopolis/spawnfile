import path from "node:path";

import type { CompileReportWorkspaceGitResource, RecordingAgentReport } from "../report/index.js";
import { resolveMnemeDurableMemoryMountPath } from "../runtime/mnemeMcp.js";
import { daimonRecordingDirectory } from "../runtime/daimon/recording.js";
import { recordingKeepMs, SpawnfileError } from "../shared/index.js";
import type { CompilePlan } from "./types.js";
import { resolveTrainingRecordVolumes } from "./training/plan/index.js";

/** Only compiled, portable identities: no host sources and no history reads. */
export const resolveRecordingAgentFacts = (
  plan: CompilePlan, gitPins: readonly CompileReportWorkspaceGitResource[] = []
): RecordingAgentReport[] => plan.nodes.flatMap((node): RecordingAgentReport[] => {
  if (node.value.kind !== "agent" || node.value.training?.record === undefined) return [];
  const agent = node.value;
  const memory = new Map<string, RecordingAgentReport["memory"][number]>();
  for (const access of agent.memoryAccess ?? []) {
    const declaring = plan.nodes.find((entry) => entry.value.source === access.source);
    if (!declaring) throw new SpawnfileError("validation_error", `Recording bank ${access.bank.id} has no declaring node`);
    const home = resolveMnemeDurableMemoryMountPath(access.bank);
    memory.set(`${declaring.id}\0${access.bank.id}`, {
      id: access.bank.id, declared_by: declaring.id,
      ledger_path: home === null ? null : path.posix.join(home, "memory/events.jsonl")
    });
  }
  const resources = agent.workspaceResources ?? [];
  return [{
    node_id: node.id, slug: node.slug, directory: daimonRecordingDirectory(node.slug),
    keep_ms: recordingKeepMs(agent.training!.record)!,
    networks: [...new Set((agent.surfaces?.moltnet ?? []).map((entry) => entry.network))].sort(),
    memory: [...memory.values()].sort((a, b) => `${a.declared_by}:${a.id}`.localeCompare(`${b.declared_by}:${b.id}`)),
    feeds: resources.flatMap((resource) => resource.kind === "volume" && resource.feed
      ? [{ id: resource.id, volume_name: resource.name! }] : []).sort((a, b) => a.id.localeCompare(b.id)),
    resources: resources.flatMap((resource): RecordingAgentReport["resources"] => resource.kind === "volume" ? []
      : [{ id: resource.id, kind: gitPins.some((pin) => pin.id === resource.id && pin.agent_node_ids?.includes(node.id)) ? "git" : resource.kind }])
      .sort((a, b) => a.id.localeCompare(b.id)),
    snapshots: resolveTrainingRecordVolumes({ id: node.id, value: agent }).map((resource) => resource.id)
  }];
}).sort((a, b) => a.node_id.localeCompare(b.node_id));
