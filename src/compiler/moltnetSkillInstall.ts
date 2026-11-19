import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import {
  assertOutputRelativePath,
  ensureDirectory,
  readStagedRegularFiles,
  resolveOutputFilePaths,
  writeUtf8File
} from "../filesystem/index.js";
import type { EmittedFile, RuntimeMoltnetWorkspace } from "../runtime/index.js";
import { SpawnfileError } from "../shared/index.js";

const execFile = promisify(execFileCallback);

const stripWorkspaceRoot = (workspaceRootPath: string, filePath: string): string | undefined =>
  filePath.startsWith(`${workspaceRootPath}/`) ? filePath.slice(workspaceRootPath.length + 1) : undefined;

/** Adapter layouts are confined to the agent output before any installer or readback I/O. */
export const assertMoltnetSkillLayout = (layout: RuntimeMoltnetWorkspace, agentName: string): void => {
  assertOutputRelativePath(layout.workspaceRootPath);
  for (const filePath of [layout.clientConfigPath, ...layout.skillPaths]) {
    assertOutputRelativePath(filePath);
    if (stripWorkspaceRoot(layout.workspaceRootPath, filePath) === undefined) {
      throw new SpawnfileError(
        "compile_error",
        `Moltnet workspace path ${JSON.stringify(filePath)} for ${agentName} is outside ${layout.workspaceRootPath}`
      );
    }
  }
};

export interface InstallMoltnetSkillOptions {
  agentName: string;
  cliCommand: string;
  /** Files already emitted for the workspace, seeded into the private stage. */
  clientConfigFiles: readonly EmittedFile[];
  layout: RuntimeMoltnetWorkspace;
}

/**
 * Runs the native installer against a private temporary workspace, then
 * returns only the adapter's expected skill files as emitted files. The caller
 * writes them through the validated emitted-file writer.
 */
export const installMoltnetSkillFiles = async (options: InstallMoltnetSkillOptions): Promise<EmittedFile[]> => {
  const { agentName, cliCommand, layout } = options;
  assertMoltnetSkillLayout(layout, agentName);
  const stage = await mkdtemp(path.join(os.tmpdir(), "spawnfile-moltnet-skill-"));
  try {
    const seeds = options.clientConfigFiles.flatMap((file) => {
      const relative = stripWorkspaceRoot(layout.workspaceRootPath, file.path);
      return relative === undefined ? [] : [{ ...file, path: relative }];
    });
    const workspace = path.join(stage, "workspace");
    await ensureDirectory(workspace);
    const seedTargets = await resolveOutputFilePaths(workspace, seeds.map((file) => file.path));
    for (const [index, file] of seeds.entries()) {
      await ensureDirectory(path.dirname(seedTargets[index]!));
      await writeUtf8File(seedTargets[index]!, file.content);
    }
    try {
      await execFile(cliCommand, ["skill", "install", "--runtime", layout.cliRuntime, "--workspace", workspace]);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new SpawnfileError("compile_error", `Unable to install the Moltnet skill into ${agentName}: ${reason}`);
    }
    const relativePaths = layout.skillPaths.map((filePath) => stripWorkspaceRoot(layout.workspaceRootPath, filePath)!);
    let contents: string[];
    try {
      contents = await readStagedRegularFiles(workspace, relativePaths);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new SpawnfileError("compile_error", `Moltnet skill install for ${agentName} did not produce its expected files: ${reason}`);
    }
    return layout.skillPaths.map((filePath, index) => ({ content: contents[index]!, path: filePath }));
  } finally {
    await rm(stage, { force: true, recursive: true });
  }
};
