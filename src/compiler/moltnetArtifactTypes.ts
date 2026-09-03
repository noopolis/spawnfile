import type { EmittedFile } from "../runtime/index.js";
import type { TeamNetworkServer } from "../manifest/index.js";
import type { MoltnetSecretPatch } from "./moltnetConfigLowering.js";
import type { MoltnetExternalParticipantArtifactV1 } from "./moltnetExternalParticipantArtifact.js";

export interface MoltnetServerPlan {
  baseUrl: string;
  configPath?: string;
  id: string;
  mode: "external" | "managed";
  name: string;
  networkId: string;
  port?: number;
  rooms: Array<{
    federation?: "all" | "none" | string[];
    id: string;
    members: string[];
    name?: string;
    visibility?: "public" | "private";
    write_policy?: "members" | "operators" | "registered_agents";
  }>;
  server: TeamNetworkServer;
  secretPatches: MoltnetSecretPatch[];
  teamSource: string;
}

export interface MoltnetNodePlan {
  configPath: string;
  credentialAgentId?: string;
  credentialId?: string;
  credentialSecret?: string;
  memberId?: string;
  networkId: string;
  receiptStorePath?: string;
}

export interface MoltnetPersistentMount {
  id: string;
  /**
   * `exclusive-reattach` marks state that MUST survive container replacement
   * and redeploy: its volume name is deployment-stable (never run-scoped) and
   * only one live container may hold it at a time.
   */
  lifecycle?: "exclusive-reattach";
  mountPath: string;
  reason: string;
  volumeName: string;
}

export interface MoltnetArtifacts {
  externalParticipantArtifacts?: MoltnetExternalParticipantArtifactV1[];
  files: EmittedFile[];
  nodePlans: MoltnetNodePlan[];
  persistentMounts: MoltnetPersistentMount[];
  ports: number[];
  publishedPorts: number[];
  serverPlans: MoltnetServerPlan[];
}
