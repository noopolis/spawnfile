import { createHash } from "node:crypto";
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
import { bundleContainerName, runBundleCommand, runContainerStep } from "./workspaceBundleRun.js";
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

const inside = (root: string, candidate: string): boolean => {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
};

/**
 * The recipe a generated bundle is keyed by: every input's git identity, the
 * command, `cwd`, the image, and each tool command with its exact captured
 * stdout (or, without capture, just its argv). Captured output is hashed as
 * bytes, so whitespace changes count.
 */
const generatedRecipe = async (spec: GeneratedSpec, cwd: string, context: BundleBuildContext, captureTools: boolean) => {
  const inputs = await Promise.all(spec.inputs.map((input) => resolveFilesInput(input, context)));
  const tools = await Promise.all((spec.tools ?? []).map(async (tool) => ({
    argv: tool,
    output: captureTools ? createHash("sha256").update(spec.image
      ? await runContainerStep({ argv: tool, dockerCommand: context.dockerCommand, image: spec.image, mounts: [[cwd, CONTAINER_WORKDIR]], name: bundleContainerName(), platform: context.platform, workdir: CONTAINER_WORKDIR }, TOOL_TIMEOUT_MS, `Generated bundle tool ${tool.join(" ")}`, cwd)
      : await runBundleCommand({ argv: tool, cwd, timeoutMs: TOOL_TIMEOUT_MS }, `Generated bundle tool ${tool.join(" ")}`)).digest("hex") : null
  })));
  return {
    command: spec.command, cwd, image: spec.image ?? null,
    inputs: inputs.map((input) => ({ entries: filesIdentity(input), root: input.directory })),
    tools
  };
};

/**
 * `generated`: a declared command writes an output directory from declared
 * inputs. The key is the recipe above plus the target platform; the command
 * runs only on a cache miss. After it runs the recipe is computed again and
 * the build fails if any input or tool changed meanwhile, so output is never
 * cached under a key that does not describe what it was built from.
 * Undeclared inputs and host environment are not part of the key, so declare
 * everything the command reads. Inputs come from the work tree the command
 * reads, so `ref` is refused; with `image`, only `cwd` is mounted, so every
 * input must live inside it. `captureTools: false` keys tools by argv only and
 * runs nothing (used for pins).
 */
export const planGeneratedBundle = async (spec: GeneratedSpec, context: BundleBuildContext, options: { captureTools?: boolean } = {}): Promise<BundleBuildPlan> => {
  if (spec.inputs.some((input) => input.ref !== undefined)) {
    throw new SpawnfileError("validation_error", "Generated bundle inputs cannot pin a ref: the command reads the work tree");
  }
  const cwd = await resolveBundleRoot(spec.cwd!), captureTools = options.captureTools ?? true;
  if (spec.image && (await Promise.all(spec.inputs.map((input) => resolveBundleRoot(input.root)))).some((root) => !inside(cwd, root))) {
    throw new SpawnfileError("validation_error", "Generated bundle inputs must live inside cwd when the command runs in an image: only cwd is mounted");
  }
  const recipe = await generatedRecipe(spec, cwd, context, captureTools);
  return {
    input: "generated",
    key: computeRecipeBundleKey("generated", recipe, context.platform),
    write: async (temporaryTar) => {
      await mkdir(context.workRoot, { mode: 0o700, recursive: true });
      const output = await mkdtemp(path.join(context.workRoot, "generated-"));
      try {
        const target = spec.image ? CONTAINER_OUTPUT : output;
        const argv = spec.command.map((part) => part.split(GENERATED_OUTPUT_PLACEHOLDER).join(target));
        const label = `Generated bundle command ${spec.command.join(" ")}`, timeoutMs = (spec.timeout_seconds ?? DEFAULT_TIMEOUT_SECONDS) * 1_000;
        if (spec.image) {
          await runContainerStep({
            argv, dockerCommand: context.dockerCommand, env: { SPAWNFILE_BUNDLE_OUTPUT: target }, image: spec.image,
            mounts: [[cwd, CONTAINER_WORKDIR], [output, CONTAINER_OUTPUT]], name: bundleContainerName(), platform: context.platform, workdir: CONTAINER_WORKDIR
          }, timeoutMs, label, cwd);
        } else {
          await runBundleCommand({ argv, cwd, env: { ...process.env, SPAWNFILE_BUNDLE_OUTPUT: target }, timeoutMs }, label);
        }
        if (JSON.stringify(await generatedRecipe(spec, cwd, context, captureTools)) !== JSON.stringify(recipe)) {
          throw new SpawnfileError("validation_error", `${label}: inputs or tools changed while it ran; nothing was cached, retry`);
        }
        return await writeBundleFiles(await walkBuiltTree(output), temporaryTar);
      } finally {
        await rm(output, { force: true, recursive: true });
      }
    }
  };
};
