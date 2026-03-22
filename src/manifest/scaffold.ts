import type { AgentManifest, TeamManifest } from "./schemas.js";
import type { ModelAuthMethod } from "../shared/index.js";

export interface AgentScaffoldManifestOptions {
  authMethod?: ModelAuthMethod;
  docs: {
    identity?: string;
    soul?: string;
    system: string;
  };
  modelName: string;
  name?: string;
  provider: string;
  runtime: string;
}

export const createAgentScaffoldManifest = (
  options: AgentScaffoldManifestOptions
): AgentManifest => {
  const authMethod = options.authMethod;

  return {
    spawnfile_version: "0.1" as const,
    kind: "agent" as const,
    name: options.name ?? "my-agent",
    runtime: options.runtime,
    execution: {
      model: {
        ...(authMethod
          ? {
              auth: {
                method: authMethod
              }
            }
          : {}),
        primary: {
          name: options.modelName,
          provider: options.provider
        }
      }
    },
    docs: {
      ...(options.docs.identity ? { identity: options.docs.identity } : {}),
      ...(options.docs.soul ? { soul: options.docs.soul } : {}),
      system: options.docs.system
    }
  };
};

export const createTeamScaffoldManifest = (): TeamManifest => ({
  spawnfile_version: "0.1" as const,
  kind: "team" as const,
  name: "my-team",
  docs: {
    system: "TEAM.md"
  },
  members: [],
  structure: {
    mode: "swarm" as const
  }
});
