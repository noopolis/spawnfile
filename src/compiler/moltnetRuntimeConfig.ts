import { getRuntimeAdapter } from "../runtime/index.js";
import { SpawnfileError } from "../shared/index.js";

import type { CompilePlan, ResolvedAgentNode } from "./types.js";

const INSTANCE_ROOT_PLACEHOLDER = "<instance-root>";
const CONFIG_FILE_PLACEHOLDER = "<config-file>";

const resolveSequentialRuntimePort = (
  plan: CompilePlan,
  runtimeName: string,
  slug: string
): number | undefined => {
  const adapter = getRuntimeAdapter(runtimeName);
  const basePort = adapter.container.port;
  if (basePort === undefined) {
    return undefined;
  }

  const runtimeAgents = plan.nodes.filter(
    (node) => node.kind === "agent" && node.runtimeName === runtimeName
  );
  const index = runtimeAgents.findIndex((node) => node.slug === slug);
  if (index < 0) {
    return undefined;
  }

  return basePort + (index * (adapter.container.portStride ?? 1));
};

const replaceContainerPathTemplate = (
  template: string,
  instanceRoot: string,
  configFileName: string
): string =>
  template
    .replaceAll(INSTANCE_ROOT_PLACEHOLDER, instanceRoot)
    .replaceAll(CONFIG_FILE_PLACEHOLDER, configFileName);

const resolveRuntimeInstancePaths = (
  runtimeName: string,
  slug: string
): { configPath: string; homePath?: string } => {
  const adapter = getRuntimeAdapter(runtimeName);
  const instanceRoot = `/var/lib/spawnfile/instances/${runtimeName}/agent-${slug}`;

  return {
    configPath: replaceContainerPathTemplate(
      adapter.container.instancePaths.configPathTemplate,
      instanceRoot,
      adapter.container.configFileName
    ),
    homePath: adapter.container.instancePaths.homePathTemplate
      ? replaceContainerPathTemplate(
          adapter.container.instancePaths.homePathTemplate,
          instanceRoot,
          adapter.container.configFileName
        )
      : undefined
  };
};

export const resolveRuntimeConfig = (
  plan: CompilePlan,
  agentNode: ResolvedAgentNode,
  nodeSlug: string,
  _networkId: string,
  _agentId: string
): Record<string, string> => {
  switch (agentNode.runtime.name) {
    case "openclaw": {
      const port = resolveSequentialRuntimePort(plan, "openclaw", nodeSlug);
      if (!port) {
        throw new SpawnfileError(
          "compile_error",
          `Unable to resolve OpenClaw gateway port for Moltnet agent ${agentNode.name}`
        );
      }
      const instancePaths = resolveRuntimeInstancePaths("openclaw", nodeSlug);

      return {
        gateway_url: `ws://127.0.0.1:${port}`,
        ...(instancePaths.homePath ? { home_path: instancePaths.homePath } : {}),
        kind: "openclaw"
      };
    }
    case "picoclaw": {
      const instancePaths = resolveRuntimeInstancePaths("picoclaw", nodeSlug);

      return {
        command: "/usr/local/bin/picoclaw",
        config_path: instancePaths.configPath,
        ...(instancePaths.homePath ? { home_path: instancePaths.homePath } : {}),
        kind: "picoclaw"
      };
    }
    default:
      throw new SpawnfileError(
        "compile_error",
        `Moltnet does not know how to attach runtime ${agentNode.runtime.name} directly`
      );
  }
};
