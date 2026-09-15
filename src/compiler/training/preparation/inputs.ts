import { execFile } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import type { TrainingPreparationConfig } from "./contract.js";
import { assertInputRoot, copySealed, exactPath, fileIdentity, hashJson, sealFile, sealTree, type SealedFile } from "./files.js";

const execute = promisify(execFile);
const git = async (cwd: string, args: string[]) => (await execute("git", args, { cwd, timeout: 120000, maxBuffer: 8 * 1024 * 1024 })).stdout;
export interface PlannedInput {
  id: string; source: string; destination: string; digest: string;
  git?: { revision: string; tree: string; common: string; overlays: SealedFile[] };
}

export async function planInputs(config: TrainingPreparationConfig, root: string, auth: string[]): Promise<PlannedInput[]> {
  return Promise.all(config.inputs.map(async input => {
    const source = await exactPath(path.resolve(root, input.source));
    assertInputRoot(source, auth);
    if (!input.git) return { id: input.id, source, destination: input.destination, digest: hashJson(fileIdentity(await sealTree(source, "input", { ignoreGit: true, internalSymlinks: true }))) };
    if ((await git(source, ["rev-parse", "--show-prefix"])).trim()) throw Error("Pinned Git input source must be a repository root");
    const common = await exactPath((await git(source, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim());
    const tree = (await git(source, ["rev-parse", `${input.git.revision}^{tree}`])).trim();
    const entries = (await git(source, ["ls-tree", "-rz", "--full-tree", input.git.revision])).split("\0").filter(Boolean);
    if (!/^[a-f0-9]{40}$/u.test(tree) || entries.some(entry => !/^(100644|100755) blob [a-f0-9]{40}\t/u.test(entry))) throw Error("Pinned Git inputs require regular files; symlinks and submodules are unsupported");
    const overlays: SealedFile[] = [];
    for (const overlay of input.git.overlays) {
      const overlaySource = path.resolve(root, overlay.source); assertInputRoot(overlaySource, auth);
      const file = await sealFile(overlaySource, overlay.path);
      if (file.sha256 !== overlay.sha256 || overlays.some(previous => previous.destination === file.destination)) throw Error("Git overlay digest mismatch or duplicate destination");
      overlays.push(file);
    }
    return { id: input.id, source, destination: input.destination, git: { revision: input.git.revision, tree, common, overlays },
      digest: hashJson({ revision: input.git.revision, tree, overlays: fileIdentity(overlays) }) };
  }));
}

/** A real self-contained Git object store, never a copied worktree pointer. */
export async function stageInput(input: PlannedInput, target: string): Promise<string> {
  if (!input.git) return input.source;
  await mkdir(target, { mode: 0o700 });
  await git(target, ["init", "--quiet"]);
  await git(target, ["-c", "protocol.file.allow=always", "fetch", "--quiet", "--depth=1", pathToFileURL(input.git.common).href, input.git.revision]);
  await git(target, ["-c", "advice.detachedHead=false", "checkout", "--quiet", "--detach", input.git.revision]);
  if ((await git(target, ["rev-parse", "HEAD^{tree}"])).trim() !== input.git.tree ||
    (await git(target, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim() !== path.join(target, ".git")) throw Error("Git training snapshot identity mismatch");
  await git(target, ["fsck", "--full", "--no-dangling"]);
  await copySealed(input.git.overlays, target);
  return target;
}

export async function verifyCanonicalPins(inputs: PlannedInput[], sources: readonly { sourcePath: string; sha256: string }[], staged: readonly string[]): Promise<void> {
  for (const source of sources) {
    const index = inputs.findIndex(input => source.sourcePath === input.source || source.sourcePath.startsWith(input.source + path.sep));
    if (index < 0) throw Error("Canonical training source is outside declared inputs");
    if (!inputs[index]!.git) continue;
    const file = path.join(staged[index]!, path.relative(inputs[index]!.source, source.sourcePath));
    if ((await sealFile(file, "pin")).sha256 !== source.sha256) throw Error("Pinned Git snapshot differs from the selected canonical agent");
  }
}

export async function readBoundedJson(file: string): Promise<unknown> {
  const source = await readFile(file, "utf8");
  if (Buffer.byteLength(source) > 1024 * 1024) throw Error("Training preparation JSON exceeds 1 MiB");
  return JSON.parse(source);
}
