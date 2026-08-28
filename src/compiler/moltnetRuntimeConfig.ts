import { getRuntimeAdapter } from "../runtime/index.js";
import { SpawnfileError } from "../shared/index.js";

import type { CompilePlan, ResolvedAgentNode } from "./types.js";
import { createMoltnetDaimonReceiptStorePath } from "./moltnetConfigLowering.js";

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

const resolveDaimonAgentId = (
  plan: CompilePlan,
  agentNode: ResolvedAgentNode
): string => {
  const compiled = plan.nodes.find(
    (node) => node.kind === "agent" && node.value.source === agentNode.source
  );
  if (!compiled) {
    throw new SpawnfileError(
      "compile_error",
      `Unable to resolve Daimon runtime agent identity for ${agentNode.name}`
    );
  }
  return compiled.id;
};

export const resolveRuntimeConfig = (
  plan: CompilePlan,
  agentNode: ResolvedAgentNode,
  nodeSlug: string,
  networkId: string,
  moltnetAgentId: string
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
    case "daimon": {
      const port = getRuntimeAdapter("daimon").container.port;
      if (!port) {
        throw new SpawnfileError(
          "compile_error",
          `Unable to resolve Daimon control port for Moltnet agent ${agentNode.name}`
        );
      }
      return {
        agent_id: resolveDaimonAgentId(plan, agentNode),
        control_url: `http://127.0.0.1:${port}`,
        kind: "daimon",
        receipt_store_path: createMoltnetDaimonReceiptStorePath(networkId, moltnetAgentId),
        token_env: "SPAWNFILE_DAIMON_CONTROL_TOKEN"
      };
    }
    case "pi": {
      const port = getRuntimeAdapter(agentNode.runtime.name).container.port;
      if (!port) {
        throw new SpawnfileError(
          "compile_error",
          `Unable to resolve ${agentNode.runtime.name} control port for Moltnet agent ${agentNode.name}`
        );
      }

      return {
        control_url: `http://127.0.0.1:${port}/agents/${nodeSlug}/wake`,
        kind: "pi"
      };
    }
    default:
      throw new SpawnfileError(
        "compile_error",
        `Moltnet does not know how to attach runtime ${agentNode.runtime.name} directly`
      );
  }
};
