import type { ResolvedAgentNode, ResolvedDocument, ResolvedSkill } from "../compiler/types.js";
import type { CapabilityReport, DiagnosticReport } from "../report/index.js";

import { EmittedFile } from "./types.js";

const ROLE_FILE_NAMES: Record<string, string> = {
  heartbeat: "HEARTBEAT.md",
  identity: "IDENTITY.md",
  memory: "MEMORY.md",
  soul: "SOUL.md",
  system: "AGENTS.md"
};

export const createCapability = (
  key: string,
  outcome: CapabilityReport["outcome"],
  message = ""
): CapabilityReport => ({
  key,
  message,
  outcome
});

export const createDiagnostic = (
  level: DiagnosticReport["level"],
  message: string
): DiagnosticReport => ({
  level,
  message
});

export const createDocumentFiles = (
  baseDirectory: string,
  documents: ResolvedDocument[]
): EmittedFile[] =>
  documents.map((document) => ({
    content: document.content,
    path:
      document.role in ROLE_FILE_NAMES
        ? `${baseDirectory}/${ROLE_FILE_NAMES[document.role]}`
        : `${baseDirectory}/extras/${document.role.replace(/^extras\./, "")}.md`
  }));

export const createSkillFiles = (
  baseDirectory: string,
  skills: ResolvedSkill[]
): EmittedFile[] =>
  skills.map((skill) => ({
    content: skill.content,
    path: `${baseDirectory}/${skill.name}/SKILL.md`
  }));

export const createAgentCapabilities = (
  node: ResolvedAgentNode,
  options: {
    mcpOutcome?: CapabilityReport["outcome"];
    sandboxOutcome?: CapabilityReport["outcome"];
    subagentOutcome?: CapabilityReport["outcome"];
    workspaceOutcome?: CapabilityReport["outcome"];
  } = {}
): CapabilityReport[] => {
  const capabilities: CapabilityReport[] = [];

  for (const document of node.docs) {
    capabilities.push(createCapability(`docs.${document.role}`, "supported"));
  }

  for (const skill of node.skills) {
    capabilities.push(createCapability(`skills.${skill.name}`, "supported"));
  }

  for (const server of node.mcpServers) {
    capabilities.push(createCapability(`mcp.${server.name}`, options.mcpOutcome ?? "supported"));
  }

  if (node.execution?.model) {
    capabilities.push(createCapability("execution.model", "supported"));
  }

  if (node.execution?.workspace) {
    capabilities.push(
      createCapability("execution.workspace", options.workspaceOutcome ?? "supported")
    );
  }

  if (node.execution?.sandbox) {
    capabilities.push(
      createCapability("execution.sandbox", options.sandboxOutcome ?? "supported")
    );
  }

  if (node.surfaces?.discord) {
    capabilities.push(createCapability("surfaces.discord", "supported"));
  }

  if (node.surfaces?.telegram) {
    capabilities.push(createCapability("surfaces.telegram", "supported"));
  }

  if (node.subagents.length > 0) {
    capabilities.push(
      createCapability("agent.subagents", options.subagentOutcome ?? "supported")
    );
  }

  return capabilities;
};
