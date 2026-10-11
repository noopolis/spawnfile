import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { TeamWorkspaceResource } from "../../../manifest/index.js";
import { deployedResource } from "./deployedResource.js";
import { historyKey } from "./history.js";
import { assertLocalGitRepository } from "./gitHistory.js";
import { assertCommitNotFuture, commitAt, commitInstant, resolveRewindCommit, rewindGit } from "./gitProcess.js";
import { exportGitTree, extractOverrideBundle } from "./gitTree.js";
import { resolveRecordedCommit } from "./recordedCommit.js";
import { materializeRecordedBundle } from "./recordedBundle.js";
import type { InputContext, InputResult } from "./types.js";

export { commitAt, commitInstant, resolveRewindCommit, rewindGit, rewindGitEnvironment, rewindGitSync, selectCommitAt } from "./gitProcess.js";
export { exportGitTree } from "./gitTree.js";
export { assertLocalGitRepository } from "./gitHistory.js";

type GitResource = Extract<TeamWorkspaceResource, { kind: "git" }>;
type BundleResource = Extract<TeamWorkspaceResource, { kind: "bundle" }>;
const FULL_OBJECT = /^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/u;

export const localRepositoryPath = (location: string, base: string): string => {
  if (location.startsWith("file://")) {
    const url = new URL(location);
    if (url.hostname && url.hostname !== "localhost") throw new Error("Rewind only reads local repositories; remote file hosts are forbidden");
    return fileURLToPath(url);
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(location) || /^[^/]+@[^:]+:/u.test(location)) throw new Error("Rewind only reads local repositories; network access is forbidden");
  return path.resolve(base, location);
};

/** Import only the transitive object set of the selected commit; no source refs or config survive. */
export const materializeCleanRepository = async (repository: string, commit: string, destination: string): Promise<void> => {
  const format = (await rewindGit(repository, ["rev-parse", "--show-object-format"])).toString().trim();
  const pack = await rewindGit(repository, ["pack-objects", "--revs", "--stdout"], Buffer.from(`${commit}\n`));
  await mkdir(destination, { recursive: true });
  await rewindGit(destination, ["init", "--quiet", "--template=", "--initial-branch=moment", `--object-format=${format}`]);
  await rewindGit(destination, ["config", "core.logAllRefUpdates", "false"]);
  await rewindGit(destination, ["index-pack", "--stdin"], pack);
  await rewindGit(destination, ["update-ref", "refs/heads/moment", commit]);
  await rewindGit(destination, ["read-tree", commit]);
  await rewindGit(destination, ["checkout-index", "--all", "--force"]);
  for (const name of ["FETCH_HEAD", "ORIG_HEAD", "logs", "packed-refs"]) await rm(path.join(destination, ".git", name), { recursive: true, force: true });
};

const selectorOf = (resource: GitResource | BundleResource): string => resource.kind === "git"
  ? resource.ref || (resource.branch ? `refs/heads/${resource.branch}` : resource.tag ? `refs/tags/${resource.tag}` : "HEAD")
  : resource.build?.files?.ref ?? "HEAD";

const localRoot = (resource: GitResource | BundleResource): string | undefined => resource.kind === "git" ? resource.url
  : resource.build?.files?.root ?? resource.build?.dependencies?.directory ?? resource.build?.generated?.cwd ?? resource.build?.generated?.inputs[0]?.root;

/** Preserve the authored root's prefix when its checkout exists; otherwise use a plain manifest-relative root. */
const bundlePrefix = async (root: string, base: string): Promise<string> => {
  const absolute = path.resolve(base, root);
  try { return (await rewindGit(absolute, ["rev-parse", "--show-prefix"])).toString().trim().replace(/\/$/u, ""); }
  catch {
    if (path.isAbsolute(root) || root.split(/[\\/]/u).includes("..")) throw new Error(`Cannot determine historical repository prefix for bundle root ${root}; keep its local checkout or use a repository-relative root`);
    return root.replace(/^\.\//u, "").replace(/\/$/u, "").replace(/^\.$/u, "");
  }
};

const materializeBundle = async (resource: BundleResource, context: InputContext, repository: string, commit: string): Promise<boolean> => {
  const build = resource.build;
  if (!build) { await exportGitTree(repository, commit, context.destination); return false; }
  if (build.files) {
    await exportGitTree(repository, commit, context.destination, { root: await bundlePrefix(build.files.root, context.input.declarationBase), exclude: build.files.exclude });
    return false;
  }
  if (build.dependencies) {
    await exportGitTree(repository, commit, context.destination, { root: await bundlePrefix(build.dependencies.directory, context.input.declarationBase) });
  } else {
    const origins = await Promise.all(build.generated!.inputs.map(async (input) => {
      try { return (await rewindGit(path.resolve(context.input.declarationBase, input.root), ["rev-parse", "--show-toplevel"])).toString().trim(); }
      catch { return null; } // Missing relative roots are mapped against the retained repository below.
    }));
    if (new Set(origins.filter((origin) => origin !== null)).size > 1) {
      throw new Error("Generated bundle inputs span multiple git repositories; one recorded repository/commit cannot rewind them correctly");
    }
    // Keep repository-relative paths: trial preparation can restore the declared cwd/input relationship.
    for (const input of build.generated!.inputs) {
      if (input.ref !== undefined) throw new Error("Generated bundle inputs cannot pin a ref: the deferred command reads the work tree");
      const root = await bundlePrefix(input.root, context.input.declarationBase);
      await exportGitTree(repository, commit, context.destination, { root, prefix: root, exclude: input.exclude, mergeIdentical: true });
    }
  }
  return true;
};

export const materializeGit = async (context: InputContext): Promise<InputResult> => {
  const { input, history } = context;
  if (input.section !== "resources" || input.declaration.kind === "volume") throw new Error("Git rewind requires a git or bundle resource");
  const resource = input.declaration, selector = selectorOf(resource), pinned = FULL_OBJECT.test(selector);
  const matchingRecord = input.overridden ? undefined : context.record?.resources.find((entry) => entry.id === input.id);
  const candidateCommits = input.overridden ? [] : context.candidateRecords?.flatMap((candidate) =>
    candidate.resources.flatMap((entry) => entry.id === input.id && entry.kind === "git" ? [entry.commit] : [])) ?? [];
  if (matchingRecord && matchingRecord.kind !== resource.kind) throw new Error(`Moment resource ${input.id} kind disagrees with its declaration`);
  const deployed = !input.overridden && !matchingRecord && !(resource.kind === "git" && pinned)
    ? await deployedResource(context) : null;
  if (deployed && deployed.pin.kind !== resource.kind) throw new Error(`Deployment resource ${input.id} kind disagrees with its declaration`);
  const effectivePin = matchingRecord ?? deployed?.pin;
  const bundlePin = effectivePin?.kind === "bundle" ? effectivePin : undefined;
  if (bundlePin && await materializeRecordedBundle(history, bundlePin.sha256, context.destination)) {
    return { fidelity: deployed && !deployed.exact ? "approximate" : "exact", basis: deployed ? "deploy-log" : "record",
      source: { sha256: bundlePin.sha256 }, notes: deployed?.notes ?? [], instant: context.at };
  }
  if (deployed && bundlePin) throw new Error(`Deployment bundle ${bundlePin.sha256} could not be reproduced from retained archive bytes`);
  const bundleNote = bundlePin ? `Recorded bundle ${bundlePin.sha256} could not be reproduced from retained archive bytes.` : undefined;
  const gitPin = effectivePin?.kind === "git" ? effectivePin : undefined;
  const record = pinned ? undefined : gitPin;
  if (input.overridden && resource.kind === "bundle" && resource.source) {
    await extractOverrideBundle(localRepositoryPath(resource.source, input.declarationBase), context.destination, resource.sha256);
    return { fidelity: "overridden", basis: "override", source: {}, notes: [], instant: context.at };
  }
  if (resource.kind === "bundle" && resource.source) throw new Error(`${bundleNote ?? "Prebuilt bundle has no matching recorded archive"} and cannot be rewound; provide an override`);
  let repository = input.overridden ? null : await history?.repository(`git/${historyKey(input)}`);
  const fromHistory = Boolean(repository);
  if ((gitPin || candidateCommits.length) && !repository) throw new Error(`Missing git history for recorded resource ${input.id}`);
  if (!repository && (pinned || input.overridden)) {
    const declared = localRoot(resource);
    if (declared) repository = localRepositoryPath(declared, input.declarationBase);
  }
  if (!repository) throw new Error(`Missing git history for ${input.id}; unpinned resources require --history`);
  await assertLocalGitRepository(repository, !input.overridden && history && repository.startsWith(`${history.root}${path.sep}`) ? history : undefined);
  for (const commit of candidateCommits) await resolveRecordedCommit(repository, commit);
  const recordedCommit = gitPin ? await resolveRecordedCommit(repository, gitPin.commit) : null;
  const selected = pinned || record || input.overridden
    ? await (record ? Promise.resolve(recordedCommit!) : resolveRewindCommit(repository, selector))
      .then(async (commit) => ({ commit, instant: await commitInstant(repository!, commit) }))
    : await commitAt(repository, selector, context.at);
  if (!selected) throw new Error(`No first-parent commit for ${selector} exists at or before ${context.at}`);
  await assertCommitNotFuture(repository, selected.commit, context.at);
  const deferred = resource.kind === "bundle" ? await materializeBundle(resource, context, repository, selected.commit) : false;
  if (resource.kind === "git") await materializeCleanRepository(repository, selected.commit, context.destination);
  return {
    fidelity: input.overridden ? "overridden" : resource.kind === "bundle" ? "approximate"
      : deployed ? deployed.exact ? "exact" : "approximate" : pinned || record ? "exact" : "approximate",
    basis: input.overridden ? "override" : pinned ? "pinned" : deployed ? "deploy-log" : record ? "record" : "selector-at",
    source: { commit: selected.commit, ...(!fromHistory ? { repository } : {}) }, instant: selected.instant,
    notes: [...(deployed?.notes ?? []), ...(pinned || record || input.overridden ? [] : ["Commit dates do not establish when a commit reached the selected ref."]),
      ...(!input.overridden && resource.kind === "bundle" ? [bundleNote ?? "Source reconstruction has no matching recorded bundle digest."] : [])],
    ...(deferred ? { build: "deferred" } : {})
  };
};
