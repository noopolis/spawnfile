import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { TrainingDockerProcess } from "../container/process.js";
import type { TrainingImageBuild } from "./contract.js";
import { assertInputRoot, copySealed, fileIdentity, hashJson, sealFile, sealTree, type SealedFile } from "./files.js";
import type { SealMemo } from "./sealMemo.js";
import { normalizeTrainingContext } from "./contextModes.js";

const packageRoot = fileURLToPath(new URL("../../../../", import.meta.url));
export const trainingAssets = path.extname(fileURLToPath(import.meta.url)) === ".ts"
  ? path.join(packageRoot, "runtime-images/training") : fileURLToPath(new URL("./assets/", import.meta.url));
export interface TrainingImagePlan { digest: string; files: SealedFile[]; dockerfile: string; entry: string; build: TrainingImageBuild }

async function packageFiles(root: string, target: string, withDist: boolean, lockSource = path.join(root, "package-lock.json"), memo?: SealMemo): Promise<SealedFile[]> {
  const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const lock = JSON.parse(await readFile(lockSource, "utf8"));
  if (![2, 3].includes(lock.lockfileVersion) || !lock.packages?.[""] ||
    JSON.stringify(manifest.dependencies ?? {}) !== JSON.stringify(lock.packages[""].dependencies ?? {})) throw Error(`Training package manifest/lock mismatch: ${target}`);
  if (Object.values(lock.packages).some(entry => {
    const item = entry as { link?: boolean; resolved?: string };
    return item.link || item.resolved?.startsWith("file:") || item.resolved?.startsWith("../");
  })) throw Error(`Training package ${target} has unsupported local dependencies; provide a complete registry-locked distribution`);
  return [await sealFile(path.join(root, "package.json"), `${target}/package.json`, memo),
    await sealFile(lockSource, `${target}/package-lock.json`, memo),
    ...withDist ? await sealTree(path.join(root, "dist"), `${target}/dist`, { ignoreDevelopment: true, memo }) : []];
}

/** `memo` only skips plan-side rehashing; staged context copies are always fully rehashed before a build. */
export async function planTrainingImage(build: TrainingImageBuild, root: string, auth: readonly string[], ownRoot = packageRoot, memo?: SealMemo): Promise<TrainingImagePlan> {
  const resolve = (value: string) => path.resolve(root, value);
  for (const source of [build.paideia, build.bridge, build.claude, build.grok.source, build.integration.source, ...build.compiler ? [build.compiler] : [], ...build.bootstrap ? [build.bootstrap] : []]) assertInputRoot(resolve(source), auth);
  const assets = ownRoot === packageRoot ? trainingAssets : path.join(ownRoot, "runtime-images/training");
  const dockerfile = await readFile(path.join(assets, "Dockerfile"), "utf8");
  const ownLock = path.extname(fileURLToPath(import.meta.url)) === ".ts" || ownRoot !== packageRoot
    ? path.join(ownRoot, "package-lock.json") : path.join(assets, "package-lock.json");
  const files = [
    ...await packageFiles(resolve(build.paideia), "paideia", true, undefined, memo),
    ...await packageFiles(ownRoot, "spawnfile", true, ownLock, memo),
    ...await packageFiles(build.compiler ? resolve(build.compiler) : ownRoot, "compiler", true,
      build.compiler ? path.join(resolve(build.compiler), "package-lock.json") : ownLock, memo),
    ...await packageFiles(resolve(build.claude), "claude", false, undefined, memo),
    ...await sealTree(resolve(build.bridge), "bridge", { ignoreDevelopment: true, memo }),
    ...await sealTree(resolve(build.integration.source), "integration", { ignoreDevelopment: true, memo }),
    ...build.bootstrap ? await sealTree(resolve(build.bootstrap), "bootstrap", { ignoreDevelopment: true, memo }) : [],
    await sealFile(resolve(build.grok.source), "grok", memo),
    await sealFile(path.join(ownRoot, "runtimes.yaml"), "spawnfile/runtimes.yaml", memo),
    await sealFile(path.join(ownRoot, "moltnet-releases.json"), "spawnfile/moltnet-releases.json", memo),
    ...await Promise.all(["runtimes.yaml", "moltnet-releases.json"].map(name =>
      sealFile(path.join(build.compiler ? resolve(build.compiler) : ownRoot, name), `compiler/${name}`, memo)))
  ];
  if (files.find(file => file.destination === "grok")!.sha256 !== build.grok.sha256) throw Error("Grok executable digest mismatch");
  for (const required of [`integration/${build.integration.entry}`, "bridge/pyproject.toml", "bridge/requirements.lock", "bridge/paideia_dspy/__init__.py", "paideia/dist/src/cli/main.js", "spawnfile/dist/cli/index.js", "compiler/dist/cli/index.js"]) {
    if (!files.some(file => file.destination === required)) throw Error(`Training distribution is missing ${required}`);
  }
  const entry = `#!/bin/sh\nexec /usr/local/bin/node --experimental-strip-types ${JSON.stringify(`/opt/training/integration/${build.integration.entry}`)} "$@"\n`;
  const digest = hashJson({ recipe: build.recipe, nativeImage: build.nativeImage, pythonImage: build.pythonImage, platform: build.platform,
    files: fileIdentity(files), dockerfile, entry });
  return { digest, files, dockerfile, entry, build };
}

/** Cache is content-addressed and still requires a matching immutable image and label. */
export async function buildTrainingImage(plan: TrainingImagePlan, options: {
  parent: string; dockerContext: string; process: TrainingDockerProcess; timeoutMs: number; signal?: AbortSignal;
  streams: { stdout(line: string): void; stderr(line: string): void };
}): Promise<{ imageId: string; cached: boolean }> {
  const tag = `spawnfile-training:${plan.digest.slice(7)}`;
  const call = (args: string[], stream = false) => options.process(["--context", options.dockerContext, ...args], {
    timeoutMs: options.timeoutMs, signal: options.signal, ...stream ? options.streams : {}
  });
  const inspect = async (): Promise<string | undefined> => {
    const result = await call(["image", "inspect", tag, "--format", '{{json .Id}}\n{{json (index .Config.Labels "com.spawnfile.training.recipe")}}']);
    if (result.code !== 0) return undefined;
    try { const [id, digest] = result.stdout.trim().split("\n").map(line => JSON.parse(line));
      return /^sha256:[a-f0-9]{64}$/u.test(id) && digest === plan.digest ? id : undefined;
    } catch { return undefined; }
  };
  const cached = await inspect(); if (cached) return { imageId: cached, cached: true };
  const staging = await mkdtemp(path.join(options.parent, ".spawnfile-training-image-"));
  try {
    await copySealed(plan.files, staging);
    await mkdir(path.join(staging, "bootstrap"), { recursive: true, mode: 0o700 });
    await writeFile(path.join(staging, "Dockerfile"), `${plan.dockerfile}\nLABEL com.spawnfile.training.recipe=${JSON.stringify(plan.digest)}\n`, { mode: 0o600 });
    await writeFile(path.join(staging, "train"), plan.entry, { mode: 0o755 });
    await normalizeTrainingContext(staging);
    const result = await call(["build", "--platform", plan.build.platform, "--build-arg", `NATIVE_IMAGE=${plan.build.nativeImage}`,
      "--build-arg", `PYTHON_IMAGE=${plan.build.pythonImage}`, "--tag", tag, staging], true);
    if (result.code !== 0) throw Error("Training image build failed; inspect the streamed build diagnostic");
    const imageId = await inspect(); if (!imageId) throw Error("Training image build did not produce a verified immutable image");
    return { imageId, cached: false };
  } finally { await rm(staging, { recursive: true, force: true }); }
}
