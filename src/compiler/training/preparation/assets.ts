import path from "node:path";
import { lstat, realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { TrainingPlan } from "../plan/contract.js";
import type { TrainingImageBuild, TrainingPreparationConfig } from "./contract.js";
import { assertNotEvaluatorStorage, sealFile, trainingTreeFiles, within } from "./files.js";

export const TRAINING_ASSETS_INPUT_ID = "training-assets";
export const TRAINING_ASSETS_DESTINATION = "/run/training/inputs/training-assets";

/** The authoring references are the entire allowlist; never walk the private root. */
export async function addTrainingAssetsInput(config: TrainingPreparationConfig, assets: TrainingPlan["assets"]): Promise<void> {
  if (!assets) return;
  if (config.inputs.some(input => input.id === TRAINING_ASSETS_INPUT_ID)) throw Error("training-assets is a reserved input identity");
  const paths: string[] = [];
  for (const file of assets.files) {
    const expected = path.resolve(assets.root, file.path);
    if (!within(assets.root, expected) || expected === assets.root || expected !== file.sourcePath || paths.includes(file.path)) {
      throw Error("Invalid or duplicate private training asset allowlist entry");
    }
    const sealed = await sealFile(file.sourcePath, file.path);
    if (sealed.sha256 !== file.sha256) throw Error("Private training asset changed since plan loading");
    paths.push(file.path);
  }
  config.inputs.push({ id: TRAINING_ASSETS_INPUT_ID, source: assets.root,
    destination: TRAINING_ASSETS_DESTINATION, include: paths });
}

/** Check image source trees before reading packages or materializing a build context. */
export async function assertTrainingImageExcludesAssets(build: TrainingImageBuild, root: string, privateRoot?: string | readonly string[],
  ownRoot = fileURLToPath(new URL("../../../../", import.meta.url))): Promise<void> {
  const recipeRoot = path.extname(fileURLToPath(import.meta.url)) === ".ts"
    ? path.join(ownRoot, "runtime-images/training") : path.join(ownRoot, "dist/compiler/training/preparation/assets");
  const protectedRoots = typeof privateRoot === "string" ? [privateRoot] : privateRoot ?? [];
  assertNotEvaluatorStorage(ownRoot);
  const sources = [path.join(ownRoot, "dist"), recipeRoot, path.join(ownRoot, "package.json"),
    path.join(ownRoot, "runtimes.yaml"), path.join(ownRoot, "moltnet-releases.json"), build.paideia, build.bridge, build.claude, build.integration.source,
    ...build.compiler ? [build.compiler] : [], ...build.bootstrap ? [build.bootstrap] : []];
  for (const source of sources) {
    const absolute = path.resolve(root, source);
    assertNotEvaluatorStorage(absolute);
    const canonical = await realpath(absolute).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return absolute; // Image planning owns missing-distribution diagnostics.
      throw error;
    });
    assertNotEvaluatorStorage(canonical);
    if (protectedRoots.some(protectedRoot => within(protectedRoot, canonical) || within(canonical, protectedRoot))) {
      throw Error("Private training assets must not enter image inputs");
    }
  }
  const trees = [path.join(ownRoot, "dist"), path.resolve(root, build.paideia, "dist"),
    path.resolve(root, build.bridge), path.resolve(root, build.integration.source),
    ...build.compiler ? [path.resolve(root, build.compiler, "dist")] : [],
    ...build.bootstrap ? [path.resolve(root, build.bootstrap)] : []];
  for (const tree of trees) {
    const present = await lstat(tree).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error; // Image planning owns missing-distribution diagnostics.
      return undefined;
    });
    if (present) await trainingTreeFiles(tree, "image", { ignoreDevelopment: true, rejectEvaluatorStorage: true });
  }
}
