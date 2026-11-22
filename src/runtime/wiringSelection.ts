import type { ResolvedAgentNode } from "../compiler/types.js";
import { SpawnfileError } from "../shared/index.js";
import { getRuntimeAdapter, hasRuntimeAdapter, listRuntimeAdapters } from "./registry.js";
import type { RuntimeMoltnetWiring, RuntimeWiring } from "./wiringTypes.js";

export const findRuntimeWiring = (runtimeName: string): RuntimeWiring | undefined =>
  hasRuntimeAdapter(runtimeName) ? getRuntimeAdapter(runtimeName).wiring : undefined;

export const requireMoltnetWiring = (runtimeName: string, agentName: string): RuntimeMoltnetWiring => {
  const wiring = findRuntimeWiring(runtimeName)?.moltnet;
  if (!wiring) {
    throw new SpawnfileError("validation_error",
      `Agent ${agentName} selects runtime ${runtimeName}, which has no Moltnet wiring capability`);
  }
  return wiring;
};

export const assertRuntimeSupportsAgentWiring = (agent: ResolvedAgentNode): void => {
  const { name: runtimeName } = agent.runtime;
  if (agent.surfaces?.moltnet?.length) requireMoltnetWiring(runtimeName, agent.name);
  if (agent.memoryAccess?.length && !findRuntimeWiring(runtimeName)?.memory) {
    throw new SpawnfileError("validation_error",
      `Agent ${agent.name} selects runtime ${runtimeName}, which has no memory wiring capability`);
  }
};

export const resolveMoltnetActorTokenScopes = (runtimeName?: string): readonly string[] =>
  (runtimeName ? findRuntimeWiring(runtimeName)?.moltnet?.actorTokenScopes : undefined) ?? ["attach", "write"];

export const resolveMoltnetStatusFields = (bridgeKind: string): readonly string[] =>
  [...new Set(listRuntimeAdapters().flatMap((runtimeName) => {
    const wiring = getRuntimeAdapter(runtimeName).wiring?.moltnet;
    return wiring?.kind === bridgeKind ? wiring.statusFields ?? [] : [];
  }))];
