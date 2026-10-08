import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";

import type { WorkspaceBundleBuild } from "../manifest/index.js";
import { SpawnfileError } from "../shared/index.js";

import {
  resolveBundleRoot,
  resolveCommittedFiles,
  resolveDevFiles,
  resolveReleaseFiles,
  writeBundleFiles,
  type BundleFilesInput
} from "./workspaceBundleFiles.js";
import {
  computeRecipeBundleKey,
  computeWorkspaceBundleKey,
  filesIdentity,
  type BundleBuildContext,
  type BundleBuildPlan
} from "./workspaceBundleKey.js";
import { containerArgv, runBundleCommand } from "./workspaceBundleRun.js";
import { walkBuiltTree } from "./workspaceBundleTree.js";

type FilesSpec = NonNullable<WorkspaceBundleBuild["files"]>;
type GeneratedSpec = NonNullable<WorkspaceBundleBuild["generated"]>;

const DEFAULT_TIMEOUT_SECONDS = 600;
const TOOL_TIMEOUT_MS = 120_000;
const CONTAINER_WORKDIR = "/spawnfile/work", CONTAINER_OUTPUT = "/spawnfile/output";
export const GENERATED_OUTPUT_PLACEHOLDER = "${output}";

/** The compile output is never an input, even when an input root contains it. */
const withOutputExcluded = (root: string, exclude: readonly string[] | undefined, outputReal: string): readonly string[] | undefined => {
  const inside = path.relative(root, outputReal);
  return inside && !inside.startsWith("..") && !path.isAbsolute(inside) ? [...(exclude ?? []), inside.split(path.sep).join("/")] : exclude;
};

/** Git identity for one declared file input: a pinned ref, a clean commit (release) or the work tree (dev). */
export const resolveFilesInput = async (spec: FilesSpec, context: BundleBuildContext): Promise<BundleFilesInput> => {
  const root = await resolveBundleRoot(spec.root), exclude = withOutputExcluded(root, spec.exclude, context.outputReal);
  if (spec.ref !== undefined) return resolveCommittedFiles(root, spec.ref, exclude);
  return context.identity === "release" ? resolveReleaseFiles(root, exclude) : resolveDevFiles(root, exclude);
};

export const planFilesBundle = async (spec: FilesSpec, context: BundleBuildContext): Promise<BundleBuildPlan> => {
  const input = await resolveFilesInput(spec, context);
  return { input: "files", key: computeWorkspaceBundleKey(input, context.platform), write: (temporaryTar) => writeBundleFiles(input, temporaryTar) };
};

/**
 * `generated`: a declared command writes an output directory from declared
 * inputs. The key is every input's git identity, the command and working
 * directory, the pinned image (when the command runs in one, on the target
 * platform) and the captured stdout of each declared tool-version command;
 * the command runs only on a cache miss. Undeclared inputs and host
 * environment are not part of the key, so declare everything the command
 * reads. Inputs come from the work tree the command reads, so `ref` is
 * refused here.
 */
export const planGeneratedBundle = async (spec: GeneratedSpec, context: BundleBuildContext): Promise<BundleBuildPlan> => {
  if (spec.inputs.some((input) => input.ref !== undefined)) {
    throw new SpawnfileError("validation_error", "Generated bundle inputs cannot pin a ref: the command reads the work tree");
  }
  const cwd = await resolveBundleRoot(spec.cwd!);
  const inputs = await Promise.all(spec.inputs.map((input) => resolveFilesInput(input, context)));
  const container = (argv: readonly string[], mounts: ReadonlyArray<readonly [string, string]>) => containerArgv({
    argv, dockerCommand: context.dockerCommand, image: spec.image!, mounts, platform: context.platform, workdir: CONTAINER_WORKDIR
  });
  const tools = await Promise.all((spec.tools ?? []).map(async (tool) => ({
    argv: tool,
    output: (await runBundleCommand({
      argv: spec.image ? container(tool, [[cwd, CONTAINER_WORKDIR]]) : tool, cwd, timeoutMs: TOOL_TIMEOUT_MS
    }, `Generated bundle tool ${tool.join(" ")}`)).trim()
  })));
  const recipe = {
    command: spec.command, cwd, image: spec.image ?? null,
    inputs: inputs.map((input) => ({ entries: filesIdentity(input), root: input.directory })),
    tools
  };
  return {
    input: "generated",
    key: computeRecipeBundleKey("generated", recipe, context.platform),
    write: async (temporaryTar) => {
      await mkdir(context.workRoot, { mode: 0o700, recursive: true });
      const output = await mkdtemp(path.join(context.workRoot, "generated-"));
      try {
        const target = spec.image ? CONTAINER_OUTPUT : output;
        const argv = spec.command.map((part) => part.split(GENERATED_OUTPUT_PLACEHOLDER).join(target));
        await runBundleCommand({
          argv: spec.image ? containerArgv({
            argv, dockerCommand: context.dockerCommand, env: { SPAWNFILE_BUNDLE_OUTPUT: target }, image: spec.image,
            mounts: [[cwd, CONTAINER_WORKDIR], [output, CONTAINER_OUTPUT]], platform: context.platform, workdir: CONTAINER_WORKDIR
          }) : argv,
          cwd, env: { ...process.env, SPAWNFILE_BUNDLE_OUTPUT: target },
          timeoutMs: (spec.timeout_seconds ?? DEFAULT_TIMEOUT_SECONDS) * 1_000
        }, `Generated bundle command ${spec.command.join(" ")}`);
        return await writeBundleFiles(await walkBuiltTree(output), temporaryTar);
      } finally {
        await rm(output, { force: true, recursive: true });
      }
    }
  };
};
