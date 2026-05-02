import { execFile as execFileCallback } from "node:child_process";
import { chmod, readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { ensureDirectory, writeUtf8File } from "../filesystem/index.js";
import { getRuntimeAdapter, type EmittedFile } from "../runtime/index.js";
import { SpawnfileError } from "../shared/index.js";

import type { MoltnetArtifacts } from "./moltnetArtifacts.js";
import { resolveMoltnetCliCommand } from "./moltnetBinaries.js";
import {
  createMoltnetClientConfigFiles,
  resolveMoltnetWorkspaceLayout
} from "./moltnetClientConfig.js";
import type { TeamCompileSupport } from "./teamContextSupport.js";
import type { ResolvedAgentNode, ResolvedTeamNode } from "./types.js";

export { prepareTeamCompileSupport } from "./teamContextSupport.js";
export type { TeamCompileSupport } from "./teamContextSupport.js";

const execFile = promisify(execFileCallback);

export interface CompiledNodeOutput {
  emittedFiles: EmittedFile[];
  kind: "agent" | "team";
  report: {
    output_dir: string | null;
  };
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
  files: EmittedFile[]
): Promise<void> => {
  await Promise.all(
    files.map(async (file) => {
      const targetPath = path.join(outputDirectory, file.path);
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

  await writeEmittedFiles(path.join(outputDirectory, compiled.report.output_dir), filesToWrite);
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

    const runtimeOutputDirectory = path.join(outputDirectory, compiled.report.output_dir);
    const moltnetClientConfigFiles = createMoltnetClientConfigFiles(compiled.value, artifacts);
    if (moltnetClientConfigFiles.length === 0) {
      continue;
    }

    const layout = resolveMoltnetWorkspaceLayout(compiled.value.runtime.name, compiled.value.name);
    const workspacePath = path.join(runtimeOutputDirectory, layout.workspaceRootPath);

    for (const file of moltnetClientConfigFiles) {
      upsertEmittedFile(compiled.emittedFiles, file);
    }
    await writeEmittedFiles(runtimeOutputDirectory, moltnetClientConfigFiles);

    if (!moltnetCliCommand) {
      moltnetCliCommand = await resolveMoltnetCliCommand();
    }

    try {
      await execFile(moltnetCliCommand, [
        "skill",
        "install",
        "--runtime",
        layout.cliRuntime,
        "--workspace",
        workspacePath
      ]);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new SpawnfileError(
        "compile_error",
        `Unable to install the Moltnet skill into ${compiled.value.name}: ${reason}`
      );
    }

    const moltnetSkillFiles = await Promise.all(
      layout.skillPaths.map(async (filePath) => {
        try {
          return {
            content: await readFile(path.join(runtimeOutputDirectory, filePath), "utf8"),
            path: filePath
          };
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          throw new SpawnfileError(
            "compile_error",
            `Moltnet skill install for ${compiled.value.name} did not produce ${filePath}: ${reason}`
          );
        }
      })
    );

    for (const file of moltnetSkillFiles) {
      upsertEmittedFile(compiled.emittedFiles, file);
    }
  }
};
