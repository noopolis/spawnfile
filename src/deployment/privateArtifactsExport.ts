import { createHash } from "node:crypto";
import { lstat, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";

import { ensureDirectory } from "../filesystem/index.js";
import { resolveOutputFilePaths } from "../filesystem/outputPaths.js";
import type { CompileReport } from "../report/index.js";
import type { RuntimePrivateExportDirectory } from "../runtime/operations.js";
import { getRuntimeOperations } from "../runtime/registry.js";

import {
  copyContainerFileToHost,
  type DockerArtifactExecFile,
} from "./artifactsExportDocker.js";
import { resolveArtifactOutputPaths } from "./artifactExportPublication.js";
import { requireCompileReportAdapters } from "./artifactsExportPlan.js";
import type { ExportIndexFile } from "./artifactsExportTypes.js";
import type { DeploymentRecord } from "./record.js";

export const planPrivateArtifactExports = (report: CompileReport) => {
  requireCompileReportAdapters(report, "export private runtime artifacts");
  return (report.container?.runtime_instances ?? []).flatMap((instance) =>
    getRuntimeOperations(instance.runtime)?.privateExportDirectories?.(instance) ?? []);
};

const filesUnder = async (root: string): Promise<readonly string[]> => {
  if (!(await lstat(root)).isDirectory()) {
    throw new Error("Private artifact export source is not a directory");
  }
  const files: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const child = path.join(directory, entry.name);
      if (entry.isSymbolicLink() || !entry.isDirectory() && !entry.isFile()) {
        throw new Error("Private artifact export rejects non-regular entries");
      }
      if (entry.isDirectory()) pending.push(child);
      else files.push(path.relative(root, child).split(path.sep).join("/"));
    }
  }
  return Object.freeze(files.sort());
};

const digest = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

export interface PrivateArtifactsExportResult {
  readonly files: readonly ExportIndexFile[];
  readonly missing: readonly string[];
}

/** Explicit opt-in egress for unredacted runtime training artifacts. */
export const exportPrivateRuntimeArtifacts = async (input: Readonly<{
  containerRef: string;
  destinationDirectory: string;
  dockerCommand: string;
  execFile: DockerArtifactExecFile;
  report: CompileReport;
  target: DeploymentRecord["target"];
  timeoutMs: number;
}>, directories: readonly RuntimePrivateExportDirectory[] = planPrivateArtifactExports(input.report)): Promise<PrivateArtifactsExportResult> => {
  const destinations = await resolveArtifactOutputPaths(input.destinationDirectory, directories.map((entry) => entry.relativePath));
  const output: ExportIndexFile[] = [];
  const missing: string[] = [];
  for (const [i, plan] of directories.entries()) {
    const destination = destinations[i]!;
    await ensureDirectory(path.dirname(destination));
    const copied = await copyContainerFileToHost({
      containerPath: plan.containerPath,
      containerRef: input.containerRef,
      dockerCommand: input.dockerCommand,
      execFile: input.execFile,
      hostPath: destination,
      target: input.target,
      timeoutMs: input.timeoutMs,
    });
    if (!copied) {
      await rm(destination, { force: true, recursive: true });
      missing.push(plan.relativePath);
      continue;
    }
    const relatives = await filesUnder(destination);
    const checked = await resolveOutputFilePaths(destination, relatives);
    for (const [i, relative] of relatives.entries()) {
      const bytes = await readFile(checked[i]!);
      output.push({
        bytes: bytes.byteLength,
        path: `${plan.relativePath}/${relative}`,
        sha256: digest(bytes),
        source: {
          kind: "container",
          ref: `${input.containerRef}:${plan.containerPath}/${relative}`,
        },
      });
    }
  }
  return Object.freeze({
    files: Object.freeze(output),
    missing: Object.freeze(missing),
  });
};
