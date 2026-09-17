/**
 * Docker-deferred check that the staged-mode training recipe reproduces the former
 * recursive-chmod image exactly. Builds both images from the same sealed plan and
 * compares mode, owner, group, type and link target of every entry.
 *
 * npx tsx scripts/verify-training-image-modes.ts --build-config <training.json> \
 *   [--root <dir>] [--control-ref 47050be] [--docker-context default] [--keep-images]
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertControlRecipe, assertNewRecipe, diffModeListings, identicalModes, LISTING_ROOTS, MODE_LISTING_FORMAT } from "./training-image-modes.ts";

type ImageModule = typeof import("../src/compiler/training/preparation/image.js");
type FilesModule = typeof import("../src/compiler/training/preparation/files.js");
type ModesModule = typeof import("../src/compiler/training/preparation/contextModes.js");
type ContractModule = typeof import("../src/compiler/training/preparation/contract.js");

const repository = fileURLToPath(new URL("../", import.meta.url));

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function docker(context: string, args: string[], capture = false): string {
  const result = spawnSync("docker", ["--context", context, ...args], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024,
    stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit" });
  if (result.status !== 0) throw Error(`docker ${args[0]} failed with exit ${result.status}`);
  return capture ? result.stdout : "";
}

async function main(): Promise<void> {
  const configPath = option("--build-config");
  if (!configPath) throw Error("--build-config <training preparation or image build JSON> is required");
  const controlRef = option("--control-ref") ?? "47050be";
  const dockerContext = option("--docker-context") ?? "default";
  const { planTrainingImage } = await import("../src/compiler/training/preparation/image.js") as ImageModule;
  const { copySealed } = await import("../src/compiler/training/preparation/files.js") as FilesModule;
  const { normalizeTrainingContext } = await import("../src/compiler/training/preparation/contextModes.js") as ModesModule;
  const { trainingBuildSchema } = await import("../src/compiler/training/preparation/contract.js") as ContractModule;

  const raw = JSON.parse(await readFile(configPath, "utf8")) as { image?: { build?: unknown } };
  const build = trainingBuildSchema.parse(raw.image?.build ?? raw);
  const root = path.resolve(option("--root") ?? path.dirname(configPath));
  const plan = await planTrainingImage(build, root, [], repository);
  const controlRecipe = execFileSync("git", ["-C", repository, "show", `${controlRef}:runtime-images/training/Dockerfile`], { encoding: "utf8" });
  assertNewRecipe(plan.dockerfile);
  assertControlRecipe(controlRecipe);

  // `copySealed` re-seals every staged file through `exactPath`, which refuses a symlinked
  // ancestor; macOS `os.tmpdir()` is `/var/folders/...` and `/var` is a symlink.
  const parent = await realpath(await mkdtemp(path.join(os.tmpdir(), "spawnfile-training-modes-")));
  const tags = { next: "spawnfile-training-modes:new", control: "spawnfile-training-modes:control" };
  try {
    // Mirror buildTrainingImage staging; only the new side normalizes modes, as in each recipe's era.
    const stage = async (name: string, dockerfile: string, normalize: boolean) => {
      const staging = path.join(parent, name);
      await mkdir(staging, { mode: 0o700 });
      await copySealed(plan.files, staging);
      await mkdir(path.join(staging, "bootstrap"), { recursive: true, mode: 0o700 });
      await writeFile(path.join(staging, "Dockerfile"), dockerfile, { mode: 0o600 });
      await writeFile(path.join(staging, "train"), plan.entry, { mode: 0o755 });
      if (normalize) await normalizeTrainingContext(staging);
      return staging;
    };
    const buildArgs = ["--platform", build.platform, "--build-arg", `NATIVE_IMAGE=${build.nativeImage}`, "--build-arg", `PYTHON_IMAGE=${build.pythonImage}`];
    docker(dockerContext, ["build", ...buildArgs, "--tag", tags.next, await stage("new", plan.dockerfile, true)]);
    docker(dockerContext, ["build", ...buildArgs, "--tag", tags.control, await stage("control", controlRecipe, false)]);
    const listing = (tag: string) => docker(dockerContext, ["run", "--rm", "--platform", build.platform, "--user", "0:0", "--network", "none",
      "--entrypoint", "find", tag, ...LISTING_ROOTS, "-printf", MODE_LISTING_FORMAT], true);
    const diff = diffModeListings(listing(tags.next), listing(tags.control));
    if (!identicalModes(diff)) {
      for (const entry of diff.onlyNew.slice(0, 50)) console.error(`only in new: ${entry}`);
      for (const entry of diff.onlyControl.slice(0, 50)) console.error(`only in control: ${entry}`);
      for (const change of diff.changed.slice(0, 50)) console.error(`differs: ${change.path}\n  new     ${change.next}\n  control ${change.control}`);
      console.error(`MODE VERDICT: FAIL (onlyNew=${diff.onlyNew.length}, onlyControl=${diff.onlyControl.length}, changed=${diff.changed.length})`);
      process.exitCode = 1;
      return;
    }
    console.log("MODE VERDICT: PASS (modes, owners, groups, types and link targets identical)");
  } finally {
    await rm(parent, { recursive: true, force: true });
    if (!process.argv.includes("--keep-images")) spawnSync("docker", ["--context", dockerContext, "image", "rm", "-f", tags.next, tags.control], { stdio: "ignore" });
  }
}

main().catch(error => { console.error(`MODE VERDICT: ERROR ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; });
