import { SpawnfileError } from "../../shared/index.js";
import { resolveDaimonEngine } from "../../runtime/daimon/config.js";
import { resolveDaimonGrokTurnLimits } from "../../runtime/daimon/grokTurnLimits.js";
import type { CompilePlanNode, ResolvedAgentNode } from "../types.js";
import { loadTrainingProject } from "./plan/load.js";
import { selectTrainingAgent } from "./selection.js";

/** The slice of a leased broker section the declaration must agree with. */
export interface TrainingSubjectDeclaredBroker {
  limits: { maxRequests: number; maxTokens: number; timeoutMs: number };
  workerConfigVariant: string;
}

const refuse = (message: string): never => { throw new SpawnfileError("validation_error", message); };

const LIMITS = [["maxRequests", "max_requests"], ["maxTokens", "max_tokens"], ["timeoutMs", "timeout_ms"]] as const;

/**
 * Declaration-level policy a training subject must already satisfy in its
 * resolved Spawnfile (inheritance included), checked before any compiler or
 * subject runs.
 *
 * - Codex: the Daimon declaration states `codex_policy: workspace-no-network`
 *   and carries neither a broker slot nor `turn_limits`.
 * - Grok: the declaration states all three `turn_limits`, each equal to the
 *   leased broker's registration limits, because a wake may only lower a
 *   registered limit and a trial must not run on a silently different budget;
 *   and the slot is the `clocked` worker variant, the only one that can hold a
 *   moment's shell clock.
 *
 * Any other runtime or engine is refused. Returns the engine it checked.
 */
export const assertTrainingSubjectDeclaration = async (
  projectRoot: string, agentId: string, broker?: TrainingSubjectDeclaredBroker
): Promise<"codex" | "grok"> => {
  const project = await loadTrainingProject(projectRoot);
  const agents = project.compilePlan.nodes.filter((node): node is CompilePlanNode & { value: ResolvedAgentNode } => node.value.kind === "agent");
  const node = selectTrainingAgent(agents, agentId).value;
  if (node.runtime.name !== "daimon") return refuse(`Training subject ${agentId} must declare runtime daimon, not ${node.runtime.name}`);
  const engine = resolveDaimonEngine(node);
  const declared = resolveDaimonGrokTurnLimits(node.runtime.options.turn_limits);
  if (engine === "codex") {
    if (node.runtime.options.codex_policy !== "workspace-no-network") {
      refuse(`Codex training subject ${agentId} requires explicit codex_policy: workspace-no-network on its Daimon declaration`);
    }
    if (broker !== undefined || declared !== undefined) refuse(`Codex training subject ${agentId} takes no broker slot and no turn_limits`);
    return engine;
  }
  if (engine !== "grok") return refuse(`Training subject ${agentId} uses Daimon engine ${engine}; only codex and grok subjects train`);
  if (!broker) return refuse(`Grok training subject ${agentId} requires its leased broker slot`);
  for (const [native, authored] of LIMITS) {
    if (declared?.[native] !== broker.limits[native]) {
      refuse(`Grok training subject ${agentId} turn_limits.${authored} (${String(declared?.[native] ?? "undeclared")}) differs from the broker limit ${broker.limits[native]}`);
    }
  }
  if (broker.workerConfigVariant !== "clocked") {
    refuse(`Grok training subject ${agentId} requires a broker slot provisioned and attested with workerConfigVariant: clocked`);
  }
  return engine;
};
