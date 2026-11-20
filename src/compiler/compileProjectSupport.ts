import { chmod } from "node:fs/promises";
import path from "node:path";

import { assertOutputRelativePath, ensureDirectory, resolveOutputFilePaths, writeUtf8File } from "../filesystem/index.js";
import { getRuntimeAdapter, type EmittedFile } from "../runtime/index.js";
import { SpawnfileError } from "../shared/index.js";

import type { MoltnetArtifacts } from "./moltnetArtifacts.js";
import { resolveMoltnetCliCommand } from "./moltnetBinaries.js";
import {
  createMoltnetClientConfigFiles,
  resolveMoltnetWorkspaceLayout
} from "./moltnetClientConfig.js";
import { assertMoltnetSkillLayout, installMoltnetSkillFiles } from "./moltnetSkillInstall.js";
import type { TeamCompileSupport } from "./teamContextSupport.js";
import type { CapabilityReport } from "../report/index.js";
import type { RuntimeCompileContext } from "../runtime/types.js";
import type { CompilePlanNode, ResolvedAgentNode, ResolvedTeamNode } from "./types.js";

export { prepareTeamCompileSupport } from "./teamContextSupport.js";
export type { TeamCompileSupport } from "./teamContextSupport.js";

export const createTeamCapabilities = (
  outcome: CapabilityReport["outcome"],
  message: string
): CapabilityReport[] => [
  { key: "team.members", message, outcome },
  { key: "team.mode", message, outcome },
  { key: "team.lead", message, outcome },
  { key: "team.external", message, outcome },
  { key: "team.shared", message, outcome },
  { key: "team.nested", message, outcome }
];

/** Each adapter sees only helpers explicitly declared by this parent. */
export function createSubagentContexts(nodes: readonly CompilePlanNode[]) {
  const agents = new Map(nodes.flatMap(({ value, slug }) => value.kind === "agent" ? [[value.source, { value, slug }] as const] : []));
  return ({ value }: CompilePlanNode): RuntimeCompileContext => ({
    subagents: value.kind === "agent" ? value.subagents.map(({ id, nodeSource }) => {
      const child = agents.get(nodeSource);
      if (!child) throw new SpawnfileError("compile_error", `Missing resolved subagent ${id} of ${value.name}`);
      return { id, slug: child.slug, node: child.value };
    }) : []
  });
}

export interface CompiledNodeOutput {
  emittedFiles: EmittedFile[];
  kind: "agent" | "team";
  report: {
    output_dir: string | null;
  };
  slug?: string;
  value: ResolvedAgentNode | ResolvedTeamNode;
}

interface AgentWorkspacePaths {
  systemInstructionPath: string;
  spawnfileDirectory: string;
}

const resolveAgentWorkspacePaths = (
  node: ResolvedAgentNode
): AgentWorkspacePaths | null => {
  const systemInstructionSurface = getRuntimeAdapter(node.runtime.name).systemInstructionSurface;
  if (!systemInstructionSurface) {
    return null;
  }

  const systemInstructionPath = systemInstructionSurface.resolvePath({ node });
  assertOutputRelativePath(systemInstructionPath);
  const systemInstructionDirectory = path.posix.dirname(systemInstructionPath);

  return {
    systemInstructionPath,
    spawnfileDirectory:
      systemInstructionDirectory === "."
        ? ".spawnfile"
        : `${systemInstructionDirectory}/.spawnfile`
  };
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
  files: EmittedFile[],
  relativeDirectory?: string
): Promise<void> => {
  const targets = await resolveOutputFilePaths(outputDirectory, files.map((file) => file.path), relativeDirectory);
  await Promise.all(
    files.map(async (file, index) => {
      const targetPath = targets[index]!;
      await ensureDirectory(path.dirname(targetPath));
      await writeUtf8File(targetPath, file.content);
      if (file.mode !== undefined) {
        await chmod(targetPath, file.mode);
      }
    })
  );
};

export const injectTeamCompileSupportFiles = async (
  outputDirectory: string,
  compiled: CompiledNodeOutput,
  support: TeamCompileSupport
): Promise<void> => {
  if (
    compiled.kind !== "agent" ||
    compiled.value.kind !== "agent" ||
    !compiled.report.output_dir
  ) {
    return;
  }

  const supportFiles = support.filesByAgentSource.get(compiled.value.source);
  if (!supportFiles || supportFiles.length === 0) {
    return;
  }

  const workspacePaths = resolveAgentWorkspacePaths(compiled.value);
  if (!workspacePaths) {
    return;
  }

  const filesToWrite: EmittedFile[] = supportFiles.map((file) =>
    upsertEmittedFile(compiled.emittedFiles, {
      ...file,
      path: file.path.startsWith(".spawnfile/") || file.path === "TEAM.md"
        ? path.posix.join(path.posix.dirname(workspacePaths.spawnfileDirectory), file.path)
        : file.path
    })
  );

  const rosterBlock =
    "\n\n<!-- spawnfile-team-context:start -->\n" +
    "## Spawnfile Team Context\n\n" +
    "Read `.spawnfile/team-contexts.md` and `.spawnfile/team-contexts.yaml` for generated team membership, representative context, and surface bindings.\n" +
    "<!-- spawnfile-team-context:end -->\n";
  const existingAgentsMd = compiled.emittedFiles.find(
    (file) => file.path === workspacePaths.systemInstructionPath
  );
  filesToWrite.push(
    existingAgentsMd
      ? (() => {
          existingAgentsMd.content += rosterBlock;
          return existingAgentsMd;
        })()
      : upsertEmittedFile(compiled.emittedFiles, {
          content: rosterBlock.trimStart(),
          path: workspacePaths.systemInstructionPath
        })
  );

  await writeEmittedFiles(outputDirectory, filesToWrite, compiled.report.output_dir);
};

export const injectMoltnetWorkspaceFiles = async (
  outputDirectory: string,
  compiledNodes: CompiledNodeOutput[],
  artifacts: MoltnetArtifacts | null
): Promise<void> => {
  if (!artifacts) {
    return;
  }

  let moltnetCliCommand: string | null = null;

  for (const compiled of compiledNodes) {
    if (
      compiled.kind !== "agent" ||
      compiled.value.kind !== "agent" ||
      !compiled.report.output_dir
    ) {
      continue;
    }

    const moltnetClientConfigFiles = createMoltnetClientConfigFiles(
      compiled.value,
      artifacts,
      compiled.slug
    );
    if (moltnetClientConfigFiles.length === 0) {
      continue;
    }

    const layout = resolveMoltnetWorkspaceLayout(compiled.value.runtime.name, compiled.value.name);
    assertMoltnetSkillLayout(layout, compiled.value.name);

    for (const file of moltnetClientConfigFiles) {
      upsertEmittedFile(compiled.emittedFiles, file);
    }
    await writeEmittedFiles(outputDirectory, moltnetClientConfigFiles, compiled.report.output_dir);

    if (layout.installSkill === false) {
      continue;
    }

    if (!moltnetCliCommand) {
      moltnetCliCommand = await resolveMoltnetCliCommand();
    }

    const moltnetSkillFiles = await installMoltnetSkillFiles({
      agentName: compiled.value.name,
      cliCommand: moltnetCliCommand,
      emittedFiles: compiled.emittedFiles,
      layout
    });
    await writeEmittedFiles(outputDirectory, moltnetSkillFiles, compiled.report.output_dir);

    for (const file of moltnetSkillFiles) {
      upsertEmittedFile(compiled.emittedFiles, file);
    }
  }
};
