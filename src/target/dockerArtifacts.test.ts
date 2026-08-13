import { chmod, chown, link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { TARGET_RESOURCE_REQUEST_VERSION, parseOpaqueTargetHandle, type SelectedTargetReceipt } from "./contracts.js";
import { createDockerArtifactOperations } from "./dockerArtifacts.js";
import {
  DOCKER_ARTIFACT_INSPECTION_FORMAT, initializeDockerArtifactIdentityStore,
  type DockerArtifactExecutor, type DockerArtifactIdentityStore
} from "./dockerArtifactsProvider.js";
import { selectTarget } from "./dockerTarget.js";
import { initializeTargetJournal, type TargetJournalStore } from "./journal.js";

const descriptor = `sha256:${"d".repeat(64)}`;
const manifest = `sha256:${"a".repeat(64)}`;
const imageDigest = `sha256:${"b".repeat(64)}`;
const imageReference = `registry.example:5000/sim/world@${imageDigest}`;
const alternateImageDigest = `sha256:${"c".repeat(64)}`;
const alternateImageReference = `registry.example:5000/sim/world@${alternateImageDigest}`;
const context = "test_context";
const mappings = [{ artifact_manifest_digest: manifest, image_digest: imageDigest, image_reference: imageReference }];
const roots: string[] = [];
const key = (index: number): string => `idem_${String(index).padStart(16, "a")}`;
const root = async (): Promise<string> => { const value = await realpath(await mkdtemp(path.join(os.tmpdir(), "spawnfile-artifacts-"))); roots.push(value); return value; };
afterEach(async () => Promise.all(roots.splice(0).map((value) => rm(value, { force: true, recursive: true }))));

interface Deferred { promise: Promise<void>; release(): void; }
interface State { calls: string[][]; imageStarts?: number; inspectGate?: Deferred; inspectPairStarted?: Deferred; inspectStarted?: Deferred; output?: string; }
const deferred = (): Deferred => { let release!: () => void; return { promise: new Promise<void>((resolve) => { release = resolve; }), release }; };
const inspection = (): string => JSON.stringify([{ RepoDigests: [imageReference] }]);
const fake = (state: State, endpoint = "unix:///private/test.sock"): DockerArtifactExecutor => async (file, args) => {
  expect(file).toBe("docker"); state.calls.push(args);
  for (const forbidden of ["list", "ls", "pull", "build", "load", "import", "tag", "create", "run", "save", "export", "remove"]) {
    if (args.includes(forbidden)) throw new Error(`forbidden ${forbidden}`);
  }
  if (args[0] === "context") return { stderr: "", stdout: JSON.stringify(endpoint) };
  if (args[2] !== "image" || args[3] !== "inspect") throw new Error("unexpected provider command");
  state.imageStarts = (state.imageStarts ?? 0) + 1; if (state.imageStarts === 2) state.inspectPairStarted?.release();
  state.inspectStarted?.release(); await state.inspectGate?.promise;
  return { stderr: "", stdout: state.output ?? inspection() };
};
const selectedFor = (executor: DockerArtifactExecutor): Promise<SelectedTargetReceipt> => selectTarget({ context, execFile: executor });
const request = (selected: SelectedTargetReceipt, changes: Record<string, unknown> = {}) => ({
  artifact_manifest_digest: manifest, descriptor_digest: descriptor, expected_revision: 0,
  idempotency_key: key(1), operation: "resolve_world_artifact", run_id: "run-one",
  selected_target: { fingerprint: selected.fingerprint, handle: selected.handle }, version: TARGET_RESOURCE_REQUEST_VERSION, ...changes
});
const setup = async (state: State, supplied?: SelectedTargetReceipt): Promise<{
  identityRoot: string; identityStore: DockerArtifactIdentityStore; journal: TargetJournalStore; selected: SelectedTargetReceipt;
}> => {
  const selected = supplied ?? await selectedFor(fake(state));
  const base = await root(); const identityRoot = path.join(base, "artifact-identities");
  return {
    identityRoot, identityStore: await initializeDockerArtifactIdentityStore(identityRoot),
    journal: await initializeTargetJournal({ context, descriptorDigest: descriptor, root: path.join(base, "journal"), runId: "run-one", selectedTarget: selected }), selected
  };
};

describe("immutable Docker artifact resolution", () => {
  it("rejects a non-exact context identifier at construction", () => {
    expect(() => createDockerArtifactOperations({
      context: `${context}\n`, executor: async () => ({ stderr: "", stdout: "" }),
      identityStore: { bind: async () => undefined, resolveOperation: async () => null }, journal: {} as TargetJournalStore, mappings
    })).toThrow("Docker artifact resolution failed");
  });

  it("inspects one trusted immutable reference and completes one opaque canonical receipt", async () => {
    const state: State = { calls: [] }; const { identityStore, journal, selected } = await setup(state);
    const operations = createDockerArtifactOperations({ context, executor: fake(state), identityStore, journal, mappings });
    const result = await operations.execute(request(selected));
    const imageCalls = state.calls.filter((args) => args[2] === "image");
    expect(imageCalls).toEqual([["--context", context, "image", "inspect", "--format", DOCKER_ARTIFACT_INSPECTION_FORMAT, imageReference]]);
    expect(result.receiptBytes).toBe(JSON.stringify(result.receipt)); expect(result.receipt.resulting_revision).toBe(1);
    expect(result.receipt.result_handle).toMatch(/^opaque_[a-f0-9]{64}$/u); expect(result.receipt.labels).toHaveLength(6);
    const publicBytes = JSON.stringify(result); expect(publicBytes).not.toContain(imageReference); expect(publicBytes).not.toContain(imageDigest); expect(publicBytes).not.toContain(manifest);
    const before = state.calls.length; expect(await operations.execute(request(selected))).toEqual(result); expect(state.calls).toHaveLength(before);
    expect((await journal.read()).revision).toBe(1);
  });

  it("persists one immutable exact identity for the resolved operation", async () => {
    const state: State = { calls: [] }; const setupValue = await setup(state);
    const result = await createDockerArtifactOperations({ context, executor: fake(state), identityStore: setupValue.identityStore, journal: setupValue.journal, mappings }).execute(request(setupValue.selected));
    if (result.receipt.result_handle === null) throw new Error("missing artifact result");
    const entry = (await setupValue.journal.read()).entries[0]!;
    const identity = await (await initializeDockerArtifactIdentityStore(setupValue.identityRoot)).resolveOperation(entry.operation_handle, entry.request_digest);
    expect(identity).toMatchObject({ artifactManifestDigest: manifest, imageDigest, imageReference, resultHandle: result.receipt.result_handle, selectedTargetHandle: setupValue.selected.handle });
    await expect(setupValue.identityStore.bind({ artifactManifestDigest: manifest, imageDigest: alternateImageDigest, imageReference: alternateImageReference, operationHandle: identity!.operationHandle, requestDigest: identity!.requestDigest, resultHandle: identity!.resultHandle, selectedTargetHandle: identity!.selectedTargetHandle })).rejects.toThrow("Docker artifact resolution failed");
  });

  it("migrates private records to a strict disjoint OCI/config-ID union", async () => {
    const state: State = { calls: [] }; const setupValue = await setup(state);
    const config = {
      archiveDigest: `sha256:${"b".repeat(64)}`, artifactManifestDigest: manifest,
      baseImageConfigDigest: `sha256:${"9".repeat(64)}`, buildPolicyDigest: `sha256:${"c".repeat(64)}`,
      bundleDigest: `sha256:${"d".repeat(64)}`, configId: `sha256:${"e".repeat(64)}`,
      daemonEpoch: `sha256:${"8".repeat(64)}`, entrypoint: "bundle.json",
      gcTag: `spfb_${"a".repeat(58)}`,
      identityKind: "docker_image_config_digest" as const,
      launcherDigest: `sha256:${"7".repeat(64)}`, networkAlias: "world",
      operationHandle: parseOpaqueTargetHandle("opaque_aaaaaaaaaaaaaaaa"),
      platform: { architecture: "amd64" as const, os: "linux" as const }, platformDigest: `sha256:${"6".repeat(64)}`,
      preparedOperationHandle: parseOpaqueTargetHandle("opaque_cccccccccccccccc"),
      preparedRequestDigest: `sha256:${"5".repeat(64)}`,
      requestDigest: `sha256:${"f".repeat(64)}`,
      resultHandle: parseOpaqueTargetHandle("opaque_bbbbbbbbbbbbbbbb"),
      selectedTargetHandle: setupValue.selected.handle
    };
    await setupValue.identityStore.bind(config);
    await expect(setupValue.identityStore.resolveOperation(config.operationHandle, config.requestDigest))
      .resolves.toEqual(config);
    await expect((await initializeDockerArtifactIdentityStore(setupValue.identityRoot))
      .resolveOperation(config.operationHandle, config.requestDigest)).resolves.toEqual(config);
    await expect(setupValue.identityStore.bind({ ...config, imageDigest } as never))
      .rejects.toThrow("Docker artifact resolution failed");
    const file = path.join(setupValue.identityRoot,
      (await readdir(setupValue.identityRoot)).find((item) => item.endsWith(".identity.json"))!);
    await writeFile(file, JSON.stringify({ artifact_manifest_digest: manifest, image_digest: imageDigest,
      image_reference: imageReference, operation_handle: config.operationHandle,
      request_digest: config.requestDigest, result_handle: config.resultHandle,
      selected_target_handle: config.selectedTargetHandle,
      version: "spawnfile.target-artifact.identity.v1" }), { mode: 0o600 });
    await expect(setupValue.identityStore.resolveOperation(config.operationHandle, config.requestDigest))
      .rejects.toThrow("Docker artifact resolution failed");
  });

  it("rejects insecure roots and conflicting operation bindings", async () => {
    const state: State = { calls: [] }; const setupValue = await setup(state);
    const filesystemRootBefore = await lstat("/");
    await expect(initializeDockerArtifactIdentityStore("/")).rejects.toThrow("Docker artifact resolution failed");
    expect((await lstat("/")).mode).toBe(filesystemRootBefore.mode);
    await chmod(setupValue.identityRoot, 0o755);
    await expect(initializeDockerArtifactIdentityStore(setupValue.identityRoot)).rejects.toThrow("Docker artifact resolution failed");
    await chmod(setupValue.identityRoot, 0o700);
    if ((process.getuid?.() ?? -1) === 0) {
      await chown(setupValue.identityRoot, 1, -1);
      await expect(initializeDockerArtifactIdentityStore(setupValue.identityRoot)).rejects.toThrow("Docker artifact resolution failed");
      await chown(setupValue.identityRoot, 0, -1);
    }
    const base = { artifactManifestDigest: manifest, imageDigest, imageReference, operationHandle: parseOpaqueTargetHandle("opaque_aaaaaaaaaaaaaaaa"), requestDigest: `sha256:${"d".repeat(64)}`, resultHandle: parseOpaqueTargetHandle("opaque_bbbbbbbbbbbbbbbb"), selectedTargetHandle: setupValue.selected.handle };
    await setupValue.identityStore.bind(base);
    expect(await setupValue.identityStore.resolveOperation(base.operationHandle, base.requestDigest)).toEqual(base);
    await expect(setupValue.identityStore.bind({ ...base, imageDigest: alternateImageDigest, imageReference: alternateImageReference })).rejects.toThrow("Docker artifact resolution failed");
  });

  it("atomically joins same and independent bindings across restarted store instances", async () => {
    const state: State = { calls: [] }; const setupValue = await setup(state); const first = { artifactManifestDigest: manifest, imageDigest, imageReference, operationHandle: parseOpaqueTargetHandle("opaque_aaaaaaaaaaaaaaaa"), requestDigest: `sha256:${"d".repeat(64)}`, resultHandle: parseOpaqueTargetHandle("opaque_bbbbbbbbbbbbbbbb"), selectedTargetHandle: setupValue.selected.handle };
    const second = { ...first, operationHandle: parseOpaqueTargetHandle("opaque_cccccccccccccccc"), requestDigest: `sha256:${"e".repeat(64)}`, resultHandle: parseOpaqueTargetHandle("opaque_dddddddddddddddd") };
    const left = await initializeDockerArtifactIdentityStore(setupValue.identityRoot); const right = await initializeDockerArtifactIdentityStore(setupValue.identityRoot);
    await Promise.all(Array.from({ length: 8 }, (_, index) => index % 2 === 0 ? left.bind(first) : right.bind(first)).concat([left.bind(second), right.bind(second)]));
    const restarted = await initializeDockerArtifactIdentityStore(setupValue.identityRoot);
    await expect(restarted.resolveOperation(first.operationHandle, first.requestDigest)).resolves.toEqual(first); await expect(restarted.resolveOperation(second.operationHandle, second.requestDigest)).resolves.toEqual(second);
  });

  it("joins independent store instances repeatedly without an in-process publication lock", async () => {
    const state: State = { calls: [] }; const setupValue = await setup(state);
    const binding = { artifactManifestDigest: manifest, imageDigest, imageReference, operationHandle: parseOpaqueTargetHandle("opaque_aaaaaaaaaaaaaaaa"), requestDigest: `sha256:${"d".repeat(64)}`, resultHandle: parseOpaqueTargetHandle("opaque_bbbbbbbbbbbbbbbb"), selectedTargetHandle: setupValue.selected.handle };
    for (let round = 0; round < 10; round += 1) {
      const left = await initializeDockerArtifactIdentityStore(setupValue.identityRoot); const right = await initializeDockerArtifactIdentityStore(setupValue.identityRoot);
      await Promise.all(Array.from({ length: 12 }, (_, index) => index % 2 === 0 ? left.bind(binding) : right.bind(binding)));
      await expect((await initializeDockerArtifactIdentityStore(setupValue.identityRoot)).resolveOperation(binding.operationHandle, binding.requestDigest)).resolves.toEqual(binding);
    }
  });

  it("joins when another independent store links the final after the first binder proved pending", async () => {
    const state: State = { calls: [] }; const setupValue = await setup(state);
    const binding = { artifactManifestDigest: manifest, imageDigest, imageReference, operationHandle: parseOpaqueTargetHandle("opaque_aaaaaaaaaaaaaaaa"), requestDigest: `sha256:${"d".repeat(64)}`, resultHandle: parseOpaqueTargetHandle("opaque_bbbbbbbbbbbbbbbb"), selectedTargetHandle: setupValue.selected.handle };
    const proved = deferred(); const release = deferred(); const linked = deferred(); const cleanup = deferred();
    const first = await initializeDockerArtifactIdentityStore(setupValue.identityRoot, { beforeLink: async () => { proved.release(); await release.promise; } });
    const second = await initializeDockerArtifactIdentityStore(setupValue.identityRoot, { afterLinkBeforePendingUnlink: async () => { linked.release(); await cleanup.promise; } });
    const left = first.bind(binding); await proved.promise;
    const right = second.bind(binding); await linked.promise;
    release.release(); await expect(left).resolves.toBeUndefined();
    cleanup.release(); await expect(right).resolves.toBeUndefined();
    await expect((await initializeDockerArtifactIdentityStore(setupValue.identityRoot)).resolveOperation(binding.operationHandle, binding.requestDigest)).resolves.toEqual(binding);
    expect((await readdir(setupValue.identityRoot)).filter((item) => item.endsWith(".pending"))).toEqual([]);
  });

  it("never overwrites a conflicting concurrent claim or accepts conflicting final and pending bytes", async () => {
    const state: State = { calls: [] }; const setupValue = await setup(state);
    const binding = { artifactManifestDigest: manifest, imageDigest, imageReference, operationHandle: parseOpaqueTargetHandle("opaque_aaaaaaaaaaaaaaaa"), requestDigest: `sha256:${"d".repeat(64)}`, resultHandle: parseOpaqueTargetHandle("opaque_bbbbbbbbbbbbbbbb"), selectedTargetHandle: setupValue.selected.handle };
    const conflict = { ...binding, imageDigest: alternateImageDigest, imageReference: alternateImageReference };
    const left = await initializeDockerArtifactIdentityStore(setupValue.identityRoot); const right = await initializeDockerArtifactIdentityStore(setupValue.identityRoot);
    const results = await Promise.allSettled([left.bind(binding), right.bind(conflict)]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const resolved = await (await initializeDockerArtifactIdentityStore(setupValue.identityRoot)).resolveOperation(binding.operationHandle, binding.requestDigest);
    expect([binding, conflict]).toContainEqual(resolved);
    const final = path.join(setupValue.identityRoot, (await readdir(setupValue.identityRoot)).find((item) => item.endsWith(".identity.json"))!);
    const bytesBeforeConflict = await readFile(final, "utf8");
    const pending = path.join(setupValue.identityRoot, `.${path.basename(final)}.pending`);
    await writeFile(pending, JSON.stringify({ conflicting: true }), { mode: 0o600 });
    await expect((await initializeDockerArtifactIdentityStore(setupValue.identityRoot)).resolveOperation(binding.operationHandle, binding.requestDigest)).rejects.toThrow("Docker artifact resolution failed");
    expect(await readFile(final, "utf8")).toBe(bytesBeforeConflict);
  });

  it("recovers a durable pre-link pending identity only for its exact content", async () => {
    const state: State = { calls: [] }; const setupValue = await setup(state); const binding = { artifactManifestDigest: manifest, imageDigest, imageReference, operationHandle: parseOpaqueTargetHandle("opaque_aaaaaaaaaaaaaaaa"), requestDigest: `sha256:${"d".repeat(64)}`, resultHandle: parseOpaqueTargetHandle("opaque_bbbbbbbbbbbbbbbb"), selectedTargetHandle: setupValue.selected.handle };
    const interrupted = await initializeDockerArtifactIdentityStore(setupValue.identityRoot, { beforePublish: async () => { throw new Error("crash"); } });
    await expect(interrupted.bind(binding)).rejects.toThrow("Docker artifact resolution failed");
    await expect(interrupted.resolveOperation(binding.operationHandle, binding.requestDigest)).resolves.toBeNull();
    expect((await readdir(setupValue.identityRoot)).filter((file) => file.endsWith(".identity.json"))).toEqual([]);
    expect((await readdir(setupValue.identityRoot)).filter((file) => file.endsWith(".pending"))).toHaveLength(1);
    const recovered = await initializeDockerArtifactIdentityStore(setupValue.identityRoot);
    await expect(recovered.bind({ ...binding, imageDigest: alternateImageDigest, imageReference: alternateImageReference })).rejects.toThrow("Docker artifact resolution failed");
    await recovered.bind(binding);
    const files = (await readdir(setupValue.identityRoot)).filter((file) => file.endsWith(".identity.json")); expect(files).toHaveLength(1);
    const rootInfo = await lstat(setupValue.identityRoot); const fileInfo = await lstat(path.join(setupValue.identityRoot, files[0]!));
    expect(rootInfo.uid).toBe(process.getuid?.() ?? -1); expect(rootInfo.mode & 0o777).toBe(0o700);
    expect(fileInfo.uid).toBe(process.getuid?.() ?? -1); expect(fileInfo.mode & 0o777).toBe(0o600); expect(fileInfo.nlink).toBe(1);
  });

  it("retries when an EEXIST pending name disappears before it can be read", async () => {
    const state: State = { calls: [] }; const setupValue = await setup(state); const binding = { artifactManifestDigest: manifest, imageDigest, imageReference, operationHandle: parseOpaqueTargetHandle("opaque_aaaaaaaaaaaaaaaa"), requestDigest: `sha256:${"d".repeat(64)}`, resultHandle: parseOpaqueTargetHandle("opaque_bbbbbbbbbbbbbbbb"), selectedTargetHandle: setupValue.selected.handle };
    const crashed = await initializeDockerArtifactIdentityStore(setupValue.identityRoot, { beforePublish: async () => { throw new Error("crash"); } });
    await expect(crashed.bind(binding)).rejects.toThrow("Docker artifact resolution failed");
    const pending = path.join(setupValue.identityRoot, (await readdir(setupValue.identityRoot)).find((item) => item.endsWith(".pending"))!);
    const recovered = await initializeDockerArtifactIdentityStore(setupValue.identityRoot, { afterPendingExists: async () => { await unlink(pending); } });
    await expect(recovered.bind(binding)).resolves.toBeUndefined();
    await expect(recovered.resolveOperation(binding.operationHandle, binding.requestDigest)).resolves.toEqual(binding);
  });

  it("repairs an exact post-link pending record after restart", async () => {
    const state: State = { calls: [] }; const setupValue = await setup(state); const binding = { artifactManifestDigest: manifest, imageDigest, imageReference, operationHandle: parseOpaqueTargetHandle("opaque_aaaaaaaaaaaaaaaa"), requestDigest: `sha256:${"d".repeat(64)}`, resultHandle: parseOpaqueTargetHandle("opaque_bbbbbbbbbbbbbbbb"), selectedTargetHandle: setupValue.selected.handle };
    const interrupted = await initializeDockerArtifactIdentityStore(setupValue.identityRoot, { afterLinkBeforePendingUnlink: async () => { throw new Error("crash"); } });
    await expect(interrupted.bind(binding)).rejects.toThrow("Docker artifact resolution failed");
    const before = (await readdir(setupValue.identityRoot)); expect(before.filter((file) => file.endsWith(".identity.json"))).toHaveLength(1); expect(before.filter((file) => file.endsWith(".pending"))).toHaveLength(1);
    const restarted = await initializeDockerArtifactIdentityStore(setupValue.identityRoot);
    await expect(restarted.resolveOperation(binding.operationHandle, binding.requestDigest)).resolves.toEqual(binding);
    const files = await readdir(setupValue.identityRoot); expect(files.filter((file) => file.endsWith(".pending"))).toEqual([]);
    const final = path.join(setupValue.identityRoot, files.find((file) => file.endsWith(".identity.json"))!); expect((await lstat(final)).nlink).toBe(1);
  });

  it("rejects an extra hardlink that is not the deterministic pending link", async () => {
    const state: State = { calls: [] }; const setupValue = await setup(state); const binding = { artifactManifestDigest: manifest, imageDigest, imageReference, operationHandle: parseOpaqueTargetHandle("opaque_aaaaaaaaaaaaaaaa"), requestDigest: `sha256:${"d".repeat(64)}`, resultHandle: parseOpaqueTargetHandle("opaque_bbbbbbbbbbbbbbbb"), selectedTargetHandle: setupValue.selected.handle };
    await setupValue.identityStore.bind(binding);
    const final = path.join(setupValue.identityRoot, (await readdir(setupValue.identityRoot)).find((file) => file.endsWith(".identity.json"))!);
    await link(final, path.join(setupValue.identityRoot, "attacker-copy"));
    await expect((await initializeDockerArtifactIdentityStore(setupValue.identityRoot)).resolveOperation(binding.operationHandle, binding.requestDigest)).rejects.toThrow("Docker artifact resolution failed");
  });

  it("rejects symlink, malformed, and nonregular canonical identity records", async () => {
    const state: State = { calls: [] }; const setupValue = await setup(state); const binding = { artifactManifestDigest: manifest, imageDigest, imageReference, operationHandle: parseOpaqueTargetHandle("opaque_aaaaaaaaaaaaaaaa"), requestDigest: `sha256:${"d".repeat(64)}`, resultHandle: parseOpaqueTargetHandle("opaque_bbbbbbbbbbbbbbbb"), selectedTargetHandle: setupValue.selected.handle };
    const store = await initializeDockerArtifactIdentityStore(setupValue.identityRoot); await store.bind(binding); const file = path.join(setupValue.identityRoot, (await readdir(setupValue.identityRoot)).find((item) => item.endsWith(".identity.json"))!);
    for (const mode of [0o644, 0o700, 0o400]) {
      await chmod(file, mode);
      await expect(store.resolveOperation(binding.operationHandle, binding.requestDigest)).rejects.toThrow("Docker artifact resolution failed");
    }
    await chmod(file, 0o600);
    await unlink(file); await symlink("/etc/passwd", file); await expect(store.resolveOperation(binding.operationHandle, binding.requestDigest)).rejects.toThrow("Docker artifact resolution failed");
    await unlink(file); await writeFile(file, "{}", { mode: 0o600 }); await expect(store.resolveOperation(binding.operationHandle, binding.requestDigest)).rejects.toThrow("Docker artifact resolution failed");
    await unlink(file); await mkdir(file, { mode: 0o700 }); await expect(store.resolveOperation(binding.operationHandle, binding.requestDigest)).rejects.toThrow("Docker artifact resolution failed");
  });

  it("joins a blocked live inspect and rejects a changed live request before another call", async () => {
    const gate = deferred(); const started = deferred(); const state: State = { calls: [], inspectGate: gate, inspectStarted: started };
    const { identityStore, journal, selected } = await setup(state); const operations = createDockerArtifactOperations({ context, executor: fake(state), identityStore, journal, mappings });
    const first = request(selected); const owner = operations.execute(first); await started.promise;
    const joined = operations.execute(first); const beforeChanged = state.calls.length;
    await expect(operations.execute({ ...first, run_id: "changed" })).rejects.toMatchObject({ message: "Docker artifact resolution failed" });
    expect(state.calls).toHaveLength(beforeChanged); expect(state.calls.filter((args) => args[2] === "image")).toHaveLength(1);
    gate.release(); const [left, right] = await Promise.all([owner, joined]); expect(left.receiptBytes).toBe(right.receiptBytes);
    expect((await journal.read()).revision).toBe(1); expect(state.calls.filter((args) => args[2] === "image")).toHaveLength(1);
  });

  it("binds one identity across concurrent operations instances", async () => {
    const gate = deferred(); const pairStarted = deferred();
    const state: State = { calls: [], inspectGate: gate, inspectPairStarted: pairStarted };
    const setupValue = await setup(state);
    const left = createDockerArtifactOperations({ context, executor: fake(state), identityStore: setupValue.identityStore, journal: setupValue.journal, mappings });
    const rightStore = await initializeDockerArtifactIdentityStore(setupValue.identityRoot);
    const right = createDockerArtifactOperations({ context, executor: fake(state), identityStore: rightStore, journal: setupValue.journal, mappings });
    const first = left.execute(request(setupValue.selected)); const second = right.execute(request(setupValue.selected));
    await pairStarted.promise; gate.release(); const [one, two] = await Promise.all([first, second]);
    expect(one).toEqual(two); expect(state.calls.filter((args) => args[2] === "image")).toHaveLength(2);
    expect((await setupValue.journal.read()).revision).toBe(1);
  });

  it("rejects unknown mappings and stale requests before provider calls", async () => {
    const state: State = { calls: [] }; const { identityStore, journal, selected } = await setup(state);
    const operations = createDockerArtifactOperations({ context, executor: fake(state), identityStore, journal, mappings }); const first = request(selected);
    const beforeUnknown = state.calls.length;
    await expect(operations.execute({ ...first, artifact_manifest_digest: `sha256:${"c".repeat(64)}` })).rejects.toMatchObject({ message: "Docker artifact resolution failed" });
    expect(state.calls).toHaveLength(beforeUnknown); await operations.execute(first); const beforeStale = state.calls.length;
    await expect(operations.execute({ ...first, idempotency_key: key(2) })).rejects.toMatchObject({ message: "Docker artifact resolution failed" });
    expect(state.calls).toHaveLength(beforeStale);
  });

  it("recovers one pending claim and a completion crash by re-inspecting only the pinned reference", async () => {
    const pendingState: State = { calls: [] }; const pendingSetup = await setup(pendingState); const first = request(pendingSetup.selected);
    await pendingSetup.journal.reserve(first);
    const pending = createDockerArtifactOperations({ context, executor: fake(pendingState), identityStore: pendingSetup.identityStore, journal: pendingSetup.journal, mappings });
    await expect(pending.execute(first)).resolves.toMatchObject({ receipt: { resulting_revision: 1 } });
    expect(pendingState.calls.filter((args) => args[2] === "image")).toHaveLength(1);

    const crashState: State = { calls: [] }; const crashSetup = await setup(crashState); let failComplete = true;
    const flaky: TargetJournalStore = {
      withLifecycleLease: (action) => crashSetup.journal.withLifecycleLease(action),
      read: () => crashSetup.journal.read(), reserve: (raw) => crashSetup.journal.reserve(raw),
      resolveCompletedReceipt: (claim) => crashSetup.journal.resolveCompletedReceipt(claim),
      complete: async (claim, receipt) => { if (failComplete) { failComplete = false; throw new Error("secret completion failure"); } return crashSetup.journal.complete(claim, receipt); }
    };
    const crash = createDockerArtifactOperations({ context, executor: fake(crashState), identityStore: crashSetup.identityStore, journal: flaky, mappings });
    await expect(crash.execute(request(crashSetup.selected))).rejects.toMatchObject({ message: "Docker artifact resolution failed" });
    const callsBeforeDrift = crashState.calls.length;
    const drift = createDockerArtifactOperations({
      context, executor: fake(crashState), identityStore: await initializeDockerArtifactIdentityStore(crashSetup.identityRoot), journal: flaky,
      mappings: [{ artifact_manifest_digest: manifest, image_digest: alternateImageDigest, image_reference: alternateImageReference }]
    });
    await expect(drift.execute(request(crashSetup.selected))).rejects.toMatchObject({ message: "Docker artifact resolution failed" });
    expect(crashState.calls).toHaveLength(callsBeforeDrift);
    const recovered = createDockerArtifactOperations({
      context, executor: fake(crashState), identityStore: await initializeDockerArtifactIdentityStore(crashSetup.identityRoot), journal: flaky, mappings
    });
    await expect(recovered.execute(request(crashSetup.selected))).resolves.toMatchObject({ receipt: { resulting_revision: 1 } });
    expect(crashState.calls.filter((args) => args[2] === "image")).toHaveLength(2);
  });

  it("fails target drift and hostile inspect output without leaking provider data", async () => {
    const selectedState: State = { calls: [] }; const selected = await selectedFor(fake(selectedState)); const setupValue = await setup(selectedState, selected);
    const driftState: State = { calls: [] }; const drift = createDockerArtifactOperations({ context, executor: fake(driftState, "unix:///different.sock"), identityStore: setupValue.identityStore, journal: setupValue.journal, mappings });
    await expect(drift.execute(request(selected))).rejects.toMatchObject({ message: "Docker artifact resolution failed" });
    expect(driftState.calls.some((args) => args[2] === "image")).toBe(false);

    const hostileState: State = { calls: [], output: JSON.stringify([{ Id: "secret-provider-id", RepoDigests: [imageReference] }]) };
    const hostileSetup = await setup(hostileState); const hostile = createDockerArtifactOperations({ context, executor: fake(hostileState), identityStore: hostileSetup.identityStore, journal: hostileSetup.journal, mappings });
    await expect(hostile.execute(request(hostileSetup.selected))).rejects.toEqual(expect.objectContaining({ message: "Docker artifact resolution failed" }));
  });
});
