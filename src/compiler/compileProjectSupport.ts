import path from "node:path";

import { ensureDirectory, writeUtf8File } from "../filesystem/index.js";
import type { EmittedFile } from "../runtime/index.js";

import type { MoltnetArtifacts } from "./moltnetArtifacts.js";
import { createMoltnetSkillFiles } from "./moltnetSkill.js";
import { generateRouterConfig, generateSurfaceRouterScript } from "./surfaceRouter.js";
import { generateTeamMcpScript } from "./teamMcp.js";
import { generateTeamRosters } from "./teamRoster.js";
import type { CompilePlan, ResolvedAgentNode, ResolvedTeamNode } from "./types.js";

export interface CompiledNodeOutput {
  emittedFiles: EmittedFile[];
  kind: "agent" | "team";
  report: {
    output_dir: string | null;
  };
  value: ResolvedAgentNode | ResolvedTeamNode;
}

export interface TeamCompileSupport {
  hasTeamRouter: boolean;
  memberAgentIds: Map<string, string>;
  rosterFiles: Map<string, string>;
  teamMcpScript: string;
}

interface AgentWorkspacePaths {
  agentsMdPath: string;
  spawnfileDirectory: string;
}

const resolveAgentWorkspacePaths = (
  runtimeName: string,
  agentName: string
): AgentWorkspacePaths =>
  runtimeName === "tinyclaw"
    ? {
        agentsMdPath: `workspace/${agentName}/AGENTS.md`,
        spawnfileDirectory: `workspace/${agentName}/.spawnfile`
      }
    : {
        agentsMdPath: "workspace/AGENTS.md",
        spawnfileDirectory: "workspace/.spawnfile"
      };

const upsertEmittedFile = (
  emittedFiles: EmittedFile[],
  nextFile: EmittedFile
): EmittedFile => {
  const existing = emittedFiles.find((file) => file.path === nextFile.path);
  if (existing) {
    existing.content = nextFile.content;
    return existing;
  }

  emittedFiles.push(nextFile);
  return nextFile;
};

export const writeEmittedFiles = async (
  outputDirectory: string,
  files: EmittedFile[]
): Promise<void> => {
  await Promise.all(
    files.map(async (file) => {
      const targetPath = path.join(outputDirectory, file.path);
      await ensureDirectory(path.dirname(targetPath));
      await writeUtf8File(targetPath, file.content);
    })
  );
};

export const prepareTeamCompileSupport = async (
  plan: CompilePlan,
  outputDirectory: string,
  routerPort: number
): Promise<TeamCompileSupport> => {
  const rosterFiles = new Map<string, string>();
  const memberAgentIds = new Map<string, string>();
  const teamMcpScript = generateTeamMcpScript();

  for (const node of plan.nodes) {
    if (node.kind !== "team") {
      continue;
    }

    const teamNode = node.value as ResolvedTeamNode;
    const rosters = generateTeamRosters(teamNode, plan, routerPort);
    for (const [memberId, rosterYaml] of rosters) {
      const memberRef = teamNode.members.find((member) => member.id === memberId);
      if (!memberRef) {
        continue;
      }
      rosterFiles.set(memberRef.nodeSource, rosterYaml);
      memberAgentIds.set(memberRef.nodeSource, memberId);
    }
  }

  const surfaceRouterScript = generateSurfaceRouterScript();
  for (const node of plan.nodes) {
    if (node.kind !== "team") {
      continue;
    }

    const teamNode = node.value as ResolvedTeamNode;
    const routerConfig = generateRouterConfig(teamNode, plan, routerPort);
    await writeUtf8File(path.join(outputDirectory, "surface-router.js"), surfaceRouterScript);
    await writeUtf8File(
      path.join(outputDirectory, "router-config.json"),
      JSON.stringify(routerConfig, null, 2) + "\n"
    );
  }

  return {
    hasTeamRouter: rosterFiles.size > 0,
    memberAgentIds,
    rosterFiles,
    teamMcpScript
  };
};

export const injectTeamCompileSupportFiles = async (
  outputDirectory: string,
  compiled: CompiledNodeOutput,
  support: TeamCompileSupport,
  routerPort: number
): Promise<void> => {
  if (
    compiled.kind !== "agent" ||
    compiled.value.kind !== "agent" ||
    !compiled.report.output_dir
  ) {
    return;
  }

  const rosterYaml = support.rosterFiles.get(compiled.value.source);
  if (!rosterYaml) {
    return;
  }

  const agentName = compiled.value.name;
  const memberId = support.memberAgentIds.get(compiled.value.source) ?? agentName;
  const workspacePaths = resolveAgentWorkspacePaths(compiled.value.runtime.name, agentName);
  const filesToWrite: EmittedFile[] = [
    upsertEmittedFile(compiled.emittedFiles, {
      content: rosterYaml,
      path: `${workspacePaths.spawnfileDirectory}/roster.yaml`
    }),
    upsertEmittedFile(compiled.emittedFiles, {
      content: support.teamMcpScript,
      path: `${workspacePaths.spawnfileDirectory}/team-mcp.js`
    })
  ];

  const rosterBlock =
    "\n\n## Team Roster\n\nYour team roster is available at `.spawnfile/roster.yaml`. " +
    "Read it to discover your teammates and how to reach them via the `team_message` MCP tool.\n\n" +
    "```yaml\n" +
    rosterYaml +
    "```\n";
  const existingAgentsMd = compiled.emittedFiles.find(
    (file) => file.path === workspacePaths.agentsMdPath
  );
  filesToWrite.push(
    existingAgentsMd
      ? (() => {
          existingAgentsMd.content += rosterBlock;
          return existingAgentsMd;
        })()
      : upsertEmittedFile(compiled.emittedFiles, {
          content: rosterBlock.trimStart(),
          path: workspacePaths.agentsMdPath
        })
  );

  if (compiled.value.runtime.name === "tinyclaw") {
    const claudeSettings = {
      mcpServers: {
        spawnfile_team: {
          command: "node",
          args: [".spawnfile/team-mcp.js"],
          env: {
            SPAWNFILE_AGENT_NAME: memberId,
            SPAWNFILE_ROUTER_URL: `http://localhost:${routerPort}`
          }
        }
      }
    };
    filesToWrite.push(
      upsertEmittedFile(compiled.emittedFiles, {
        content: JSON.stringify(claudeSettings, null, 2) + "\n",
        path: `workspace/${agentName}/.claude/settings.json`
      })
    );
  }

  await writeEmittedFiles(path.join(outputDirectory, compiled.report.output_dir), filesToWrite);
};

export const injectMoltnetSkillFiles = async (
  outputDirectory: string,
  compiledNodes: CompiledNodeOutput[],
  artifacts: MoltnetArtifacts | null
): Promise<void> => {
  if (!artifacts) {
    return;
  }

  for (const compiled of compiledNodes) {
    if (
      compiled.kind !== "agent" ||
      compiled.value.kind !== "agent" ||
      !compiled.report.output_dir
    ) {
      continue;
    }

    const moltnetSkillFiles = createMoltnetSkillFiles(compiled.value, artifacts);
    if (moltnetSkillFiles.length === 0) {
      continue;
    }

    for (const file of moltnetSkillFiles) {
      upsertEmittedFile(compiled.emittedFiles, file);
    }
    await writeEmittedFiles(path.join(outputDirectory, compiled.report.output_dir), moltnetSkillFiles);
  }
};
