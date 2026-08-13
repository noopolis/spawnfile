import { createHash } from "node:crypto";
import { lstat, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";

import { ensureDirectory } from "../filesystem/index.js";
import type { CompileReport } from "../report/index.js";

import {
  copyContainerFileToHost,
  type DockerArtifactExecFile,
} from "./artifactsExportDocker.js";
import type { ExportIndexFile } from "./artifactsExportTypes.js";
import type { DeploymentRecord } from "./record.js";

interface PrivateDirectoryPlan {
  readonly containerPath: string;
  readonly relativePath: string;
}

const plans = (report: CompileReport): readonly PrivateDirectoryPlan[] =>
  (report.container?.runtime_instances ?? [])
    .filter((instance) =>
      (instance.runtime === "pi" || instance.runtime === "daimon")
      && instance.home_path !== null)
    .flatMap((instance) => {
      const instanceRoot = path.posix.dirname(instance.home_path!);
      return (instance.node_ids ?? [])
        .filter((nodeId) => nodeId.startsWith("agent:"))
        .map((nodeId) => nodeId.slice("agent:".length))
        .filter((slug) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(slug))
        .map((slug) => Object.freeze({
          containerPath:
            `${instanceRoot}/runtime/agents/${slug}/private-training/pi/raw`,
          relativePath: `private/daimon/${slug}/private-training/pi/raw`,
        }));
    });

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
}>): Promise<PrivateArtifactsExportResult> => {
  const output: ExportIndexFile[] = [];
  const missing: string[] = [];
  for (const plan of plans(input.report)) {
    const destination = path.join(
      input.destinationDirectory,
      ...plan.relativePath.split("/"),
    );
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
    for (const relative of await filesUnder(destination)) {
      const bytes = await readFile(path.join(destination, ...relative.split("/")));
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
