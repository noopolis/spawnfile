import type { ResolvedAgentNode } from "../../compiler/types.js";
import type { CapabilityReport } from "../../report/index.js";
import { resolveMnemeDurableMemoryMountPath } from "../mnemeMcp.js";
import { SpawnfileError } from "../../shared/index.js";

/**
 * Memory lowering for the Daimon organization runtime, split out of
 * `config.ts` so that file stays inside the repository's 400-line source
 * bound. Nothing here knows about container targets, engines, or mounts: it
 * answers one question — which single declared Mneme bank (if any) becomes the
 * agent's `memory` block, and what the operator is told when the answer is not
 * the one they declared.
 */

type DaimonMemoryAccess = NonNullable<ResolvedAgentNode["memoryAccess"]>[number];

/**
 * Daimon's organization runtime accepts exactly one `memory` block per agent
 * (`OrganizationRuntimeMemory` = `{ runtimeHomePath, source?, tokenBudget? }`),
 * so lowering picks one declared bank deterministically, the same way the
 * legacy generated-Pi emitter does in `../pi/appAgentConfig.ts`.
 */
const memoryAccessKey = (access: DaimonMemoryAccess): string =>
  `${access.source}:${access.bank.id}`;

const selectDaimonMemoryAccess = (
  node: ResolvedAgentNode
): DaimonMemoryAccess | undefined =>
  [...(node.memoryAccess ?? [])].sort((left, right) =>
    memoryAccessKey(left).localeCompare(memoryAccessKey(right))
  )[0];

/**
 * The instance root every Daimon agent's `workspacePath` and `runtimeHomePath`
 * resolve under (`resolveInstancePaths` in
 * `src/compiler/containerTargetPlanResolution.ts`). Daimon's own parser rejects
 * a `memory.runtimeHomePath` that overlaps either of those, so a declared store
 * inside this subtree must fail at compile time with a Spawnfile message rather
 * than as an opaque container-side config parse error.
 *
 * Restating the literal here is deliberate — importing the compiler's path
 * builder into a runtime adapter would invert the dependency direction — so it
 * is pinned to that authority by `config.test.ts`'s "pins the instance-root
 * guard to resolveInstancePaths" case, which derives the expected value from
 * `resolveInstancePaths` and fails if either side drifts.
 */
export const DAIMON_INSTANCE_STATE_ROOT = "/var/lib/spawnfile/instances";

export const resolveDaimonAgentMemory = (
  node: ResolvedAgentNode
): { runtimeHomePath: string; source: string } | undefined => {
  const access = selectDaimonMemoryAccess(node);
  if (!access) return undefined;
  const runtimeHomePath = resolveMnemeDurableMemoryMountPath(access.bank);
  if (runtimeHomePath === null) return undefined;
  if (
    runtimeHomePath === DAIMON_INSTANCE_STATE_ROOT ||
    runtimeHomePath.startsWith(`${DAIMON_INSTANCE_STATE_ROOT}/`) ||
    DAIMON_INSTANCE_STATE_ROOT.startsWith(`${runtimeHomePath}/`)
  ) {
    throw new SpawnfileError(
      "validation_error",
      `Daimon memory bank ${access.bank.id} resolves to ${runtimeHomePath}, which overlaps the Daimon instance state root ${DAIMON_INSTANCE_STATE_ROOT}; declare the store outside it`
    );
  }
  return {
    runtimeHomePath,
    source: `spawnfile:${access.declaringKind}:${access.bank.id}`
  };
};

/**
 * The compile-time warning for an agent that declared several memory banks.
 *
 * `selectDaimonMemoryAccess` is deterministic (lexicographically first key),
 * and the capability row already reports the outcome as `degraded` — but a
 * capability row does not say *which* bank won. Declaring a new bank whose key
 * sorts earlier silently re-points this agent's memory home and orphans the
 * previously wired bank's data, so the wired and ignored ids are named here,
 * in the diagnostics an operator reads on every compile. The selection rule
 * itself is unchanged.
 */
export const daimonMemorySelectionWarning = (
  node: ResolvedAgentNode
): string | undefined => {
  const accesses = node.memoryAccess ?? [];
  const selected = selectDaimonMemoryAccess(node);
  if (!selected) return undefined;
  const selectedKey = memoryAccessKey(selected);
  const ignored = [...new Set(
    accesses
      .filter((access) => memoryAccessKey(access) !== selectedKey)
      .map((access) => access.bank.id)
  )].sort();
  if (ignored.length === 0) return undefined;
  return `Daimon organization runtime v1 lowers one memory bank per agent: ${node.name} wires memory bank ${selected.bank.id} and ignores ${ignored.join(", ")}. The wired bank is the lexicographically first declared one, so adding a bank that sorts earlier re-points this agent's memory home and orphans ${selected.bank.id}'s data.`;
};

/**
 * The compile-time warning for a wired memory bank that asked for vector
 * recall the Daimon organization runtime cannot provide.
 *
 * The memory block Spawnfile lowers into the organization runtime config is
 * `{runtimeHomePath, source?, tokenBudget?}` and nothing more (see
 * `resolveDaimonAgentMemory` above and the `memory` schema in daimon's
 * `organizationRuntimeContract.ts`). Daimon's CLI harness path forwards exactly
 * those three fields and never sets `memory.embeddingProvider`, so Mneme builds
 * a lexical-only recall path. Embeddings are optional in Mneme and it falls back
 * safely, so a fixture declaring `index.vector.enabled: true` still compiles and
 * still recalls — just not the way it asked to. That silence is the defect: the
 * declaration is accepted verbatim and quietly means something else.
 *
 * This says so at compile time rather than forwarding the configuration,
 * because forwarding it would mean widening the daimon organization runtime
 * config contract (and its digest-pinned manifest) plus building an embedding
 * provider on the daimon side — a much larger change than telling the truth.
 */
export const daimonMemoryVectorRecallWarning = (
  node: ResolvedAgentNode
): string | undefined => {
  const access = selectDaimonMemoryAccess(node);
  if (!access || !resolveDaimonAgentMemory(node)) return undefined;
  const vector = access.bank.index?.vector;
  if (!vector?.enabled) return undefined;
  return `Daimon organization runtime v1 has no vector recall: memory bank ${access.bank.id} declares `
    + `index.vector.enabled with model ${vector.model ?? "(unset)"}, but the runtime memory contract carries `
    + "no embedding configuration, so recall for this agent is lexical only. Declare index.vector on a "
    + "runtime that lowers it, or drop it from this bank so the declaration matches the behavior.";
};

export const daimonMemoryCapabilityFor = (
  node: ResolvedAgentNode
): { memoryMessage?: string; memoryOutcome?: CapabilityReport["outcome"] } => {
  const access = selectDaimonMemoryAccess(node);
  if (!access) return {};
  const memory = resolveDaimonAgentMemory(node);
  if (!memory) {
    return {
      memoryMessage: `Daimon organization runtime v1 lowers only durably mounted file-backed Mneme banks; memory bank ${access.bank.id} (store ${access.bank.store.kind}) has no durable container volume, so no memory block is emitted`,
      memoryOutcome: "degraded"
    };
  }
  const declaredKeys = new Set((node.memoryAccess ?? []).map(memoryAccessKey));
  declaredKeys.delete(memoryAccessKey(access));
  if (declaredKeys.size > 0) {
    return {
      memoryMessage: `Daimon organization runtime v1 lowers one memory bank per agent; ${access.bank.id} is wired at ${memory.runtimeHomePath} and ${declaredKeys.size} further declared bank(s) are not lowered`,
      memoryOutcome: "degraded"
    };
  }
  const vectorWarning = daimonMemoryVectorRecallWarning(node);
  if (vectorWarning) {
    return { memoryMessage: vectorWarning, memoryOutcome: "degraded" };
  }
  return {
    memoryMessage: `Daimon lowers Mneme memory bank ${access.bank.id} into the organization runtime agent config at ${memory.runtimeHomePath}`,
    memoryOutcome: "supported"
  };
};
