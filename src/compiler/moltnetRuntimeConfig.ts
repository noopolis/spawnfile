import {
  getRuntimeAdapter,
  requireMoltnetWiring,
  type RuntimeMoltnetBridgeConfig
} from "../runtime/index.js";
import { SpawnfileError } from "../shared/index.js";

import { resolveInstancePaths } from "./containerTargetPlanResolution.js";
import { createMoltnetNetworkStateDirectory } from "./moltnetConfigLowering.js";
import type { CompilePlan, ResolvedAgentNode } from "./types.js";

export const resolveRuntimeConfig = (
  plan: CompilePlan,
  agentNode: ResolvedAgentNode,
  nodeSlug: string,
  networkId: string,
  moltnetAgentId: string
): RuntimeMoltnetBridgeConfig => {
  const runtimeName = agentNode.runtime.name;
  const wiring = requireMoltnetWiring(runtimeName, agentNode.name);
  const { container } = getRuntimeAdapter(runtimeName);
  const paths = resolveInstancePaths(runtimeName, `agent-${nodeSlug}`, container);
  const runtimeAgents = plan.nodes.filter((node) => node.kind === "agent" && node.runtimeName === runtimeName);
  const index = runtimeAgents.findIndex((node) => node.slug === nodeSlug);
  const config = wiring.bridge({
    ...paths,
    agentId: plan.nodes.find((node) => node.kind === "agent" && node.value.source === agentNode.source)?.id ?? "",
    agentName: agentNode.name,
    basePort: container.port,
    memberId: moltnetAgentId,
    networkId,
    nodeSlug,
    networkStateDirectory: createMoltnetNetworkStateDirectory(networkId),
    ...(container.port !== undefined && index >= 0
      ? { port: container.port + index * (container.portStride ?? 1) }
      : {})
  });
  if (config.kind !== wiring.kind) {
    throw new SpawnfileError("validation_error",
      `Agent ${agentNode.name} selects runtime ${runtimeName}, which emitted Moltnet bridge kind ${config.kind} instead of ${wiring.kind}`);
  }
  return config;
};
