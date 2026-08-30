import { createHash } from "node:crypto";
import { fork } from "node:child_process";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { createOrganizationHandoff, parseCanonicalSha256Digest } from "./organizationHandoffTypes.js";
import { createOrganizationHandoffCapabilityPending, createOrganizationHandoffHandle, createOrganizationHandoffRecoveryKey } from "./organizationHandoffAuthorityTypes.js";
import { initializeOrganizationHandoffAuthorityStore, resolveOrganizationHandoffAuthorityRoot } from "./organizationHandoffAuthorityStore.js";
import { parseOrganizationAttachmentResolution } from "../target/organizationAttachmentAuthority.js";

const homes: string[] = []; const originalHome = process.env.SPAWNFILE_HOME;
const authorities: Array<Awaited<ReturnType<typeof initializeOrganizationHandoffAuthorityStore>>> = [];
const digest = (value: string): string => `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
const selected = { fingerprint: `sha256:${"a".repeat(32)}`, handle: `opaque_${"b".repeat(16)}`, version: "spawnfile.target-resource.selected-target.v1" } as const;
const selectedDigest = digest(JSON.stringify(selected));
const labels = {
  "com.spawnfile.compile_fingerprint": "sf1.abc", "com.spawnfile.deployment": "football",
  "com.spawnfile.project": "football", "com.spawnfile.run_id": "run-one",
  "com.spawnfile.unit": "football-container", "com.spawnfile.version": "0.1"
};
const input = (descriptor = `sha256:${"c".repeat(64)}`) => ({
  bindingDigest: `sha256:${"d".repeat(64)}`, containerName: "football", deploymentLabels: labels,
  descriptorDigest: descriptor, handoff: createOrganizationHandoff("run-one", {
    bindingDigest: parseCanonicalSha256Digest(`sha256:${"d".repeat(64)}`), networkAttachmentHandle: `opaque_${"e".repeat(16)}` as never,
    selectedTargetReceiptDigest: parseCanonicalSha256Digest(selectedDigest)
  }), selectedTarget: selected, selectedTargetReceiptDigest: selectedDigest
});
const alternativeHandoff = createOrganizationHandoff("run-one", {
  bindingDigest: parseCanonicalSha256Digest(`sha256:${"1".repeat(64)}`),
  networkAttachmentHandle: `opaque_${"2".repeat(16)}` as never,
  selectedTargetReceiptDigest: parseCanonicalSha256Digest(selectedDigest)
});
const alternativeInput = {
  ...input(),
  bindingDigest: alternativeHandoff.binding_digest,
  handoff: alternativeHandoff
};
const close = (authority: Awaited<ReturnType<typeof initializeOrganizationHandoffAuthorityStore>>, final: { readonly organization_handoff_handle: string; readonly handoff: unknown }) =>
  authority.close({ expectedHandoff: final.handoff, organizationHandoffHandle: final.organization_handoff_handle });
const auth = (handle: string, descriptor = `sha256:${"c".repeat(64)}`) => ({
  descriptor_digest: descriptor, operation_handle: `opaque_${"f".repeat(16)}`, organization_handoff_handle: handle,
  request_digest: `sha256:${"0".repeat(64)}`, run_id: "run-one",
  selected_target: { fingerprint: selected.fingerprint, handle: selected.handle },
  version: "spawnfile.target-organization-attachment.authorization.v1"
});

afterEach(async () => {
  await Promise.all(authorities.splice(0).map(async (authority) => authority.dispose()));
  if (originalHome === undefined) delete process.env.SPAWNFILE_HOME; else process.env.SPAWNFILE_HOME = originalHome;
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});
const initialize = async (options?: Parameters<typeof initializeOrganizationHandoffAuthorityStore>[0]) => {
  const authority = await initializeOrganizationHandoffAuthorityStore(options); authorities.push(authority); return authority;
};
const store = async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "spawnfile-handoff-authority-")); homes.push(home); process.env.SPAWNFILE_HOME = home;
  return initialize();
};

describe("organization handoff authority store", () => {
  it("rolls back every acquired helper and directory anchor when worker startup fails", async () => {
    for (const failAt of [2, 3]) {
      const home = await mkdtemp(path.join(os.tmpdir(), "spawnfile-handoff-authority-")); homes.push(home); process.env.SPAWNFILE_HOME = home;
      const root = resolveOrganizationHandoffAuthorityRoot(); const parts = ["pending", "finalized", "finalized-pending", "attach-closed"];
      await Promise.all(parts.map((part) => mkdir(path.join(root, part), { mode: 0o700, recursive: true })));
      let calls = 0; const disposed: string[] = [];
      await expect(initializeOrganizationHandoffAuthorityStore({ testInitializeFsClient: async (clientOptions) => {
        calls += 1; if (calls === failAt) throw new Error("injected worker startup failure");
        const part = path.basename(clientOptions.cwd);
        return {
          create: async () => false,
          dispose: async () => { disposed.push(part); }, read: async () => null,
          write: async () => undefined
        };
      } })).rejects.toThrow("Organization handoff authority failed");
      expect(disposed).toHaveLength(failAt - 1); expect(new Set(disposed).size).toBe(failAt - 1);
      const released = `${root}-released-${failAt}`;
      await rename(root, released); await rm(released, { recursive: true, force: true });
    }
  });

  it("publishes exact immutable pending/finalized records and resolves through B93's unchanged shape", async () => {
    const first = await store(); const pending = await first.reserve(input());
    const final = await first.finalize(pending.pending_key, { containerId: "1".repeat(64), deploymentLabels: labels });
    const root = resolveOrganizationHandoffAuthorityRoot();
    expect((await lstat(root)).mode & 0o777).toBe(0o700);
    const resolution = parseOrganizationAttachmentResolution(await first.resolver.resolve({ authorization: auth(final.organization_handoff_handle) }));
    expect(resolution.handoff).toEqual(input().handoff); expect(resolution.network_attachment.container_id).toBe("1".repeat(64));
    const second = await initialize();
    expect(await second.resolver.resolve({ authorization: auth(final.organization_handoff_handle) })).toEqual(await first.resolver.resolve({ authorization: auth(final.organization_handoff_handle) }));
  });

  it("is replay-stable, separates full reservation identity from public correlation, and never treats deployment_handle as authority", async () => {
    const value = await store(); const pending = await value.reserve(input());
    await expect(value.reserve(input())).resolves.toEqual(pending);
    await expect(value.reserve(input(`sha256:${"9".repeat(64)}`))).resolves.toMatchObject({ descriptor_digest: `sha256:${"9".repeat(64)}` });
    const final = await value.finalize(pending.pending_key, { containerId: "2".repeat(64), deploymentLabels: labels });
    expect(final.organization_handoff_handle).not.toBe(input().handoff.deployment_handle);
    await expect(value.resolver.resolve({ authorization: auth(input().handoff.deployment_handle) })).rejects.toThrow("Organization handoff authority failed");
    await expect(value.reserve({ ...input(), selectedTargetReceiptDigest: digest("wrong") })).rejects.toThrow();
    await expect(value.resolver.resolve({ authorization: { ...auth(final.organization_handoff_handle), operation_handle: input().handoff.network_attachment_handle } })).rejects.toThrow();
  });

  it("rejects a swapped pair of otherwise-valid capabilities without closing either", async () => {
    const value = await store();
    const firstPending = await value.reserve(input());
    const first = await value.finalize(firstPending.pending_key, { containerId: "7".repeat(64), deploymentLabels: labels });
    const secondPending = await value.reserve(alternativeInput);
    const second = await value.finalize(secondPending.pending_key, { containerId: "8".repeat(64), deploymentLabels: labels });

    await expect(value.close({
      expectedHandoff: second.handoff,
      organizationHandoffHandle: first.organization_handoff_handle
    })).rejects.toThrow("Organization handoff authority failed");

    await expect(value.resolver.resolve({ authorization: auth(first.organization_handoff_handle) })).resolves.toBeTruthy();
    await expect(value.resolver.resolve({ authorization: auth(second.organization_handoff_handle) })).resolves.toBeTruthy();
  });

  it("elects one Docker mutator and replays only an exact durable observation after restart", async () => {
    const first = await store(); const peer = await initialize();
    const [left, right] = await Promise.all([first.begin(input()), peer.begin(input())]);
    expect([left.created, right.created].filter(Boolean)).toHaveLength(1);
    expect(left.pending).toEqual(right.pending);
    const pending = left.pending;
    const leaf = `${Buffer.from(createOrganizationHandoffRecoveryKey(pending.pending_key), "utf8").toString("hex")}.json`;
    expect(await readdir(path.join(resolveOrganizationHandoffAuthorityRoot(), "recovery-reserved"))).toEqual([leaf]);
    await expect(first.finalize(pending.pending_key, { containerId: "9".repeat(64), deploymentLabels: labels })).rejects.toThrow();
    expect(await peer.readDockerMutation(pending.pending_key)).toBeNull();
    for (const invalidImageId of ["not-a-digest", "sha256:short", `sha256:${"A".repeat(64)}`, `sha256:${"a".repeat(65)}`]) {
      await expect(first.observeDockerMutation(pending.pending_key, { containerId: "9".repeat(64), deploymentLabels: labels, imageId: invalidImageId })).rejects.toThrow();
      expect(await peer.readDockerMutation(pending.pending_key)).toBeNull();
    }
    const imageId = `sha256:${"9".repeat(64)}`;
    await first.observeDockerMutation(pending.pending_key, { containerId: "9".repeat(64), deploymentLabels: labels, imageId });
    const restarted = await initialize();
    expect(await restarted.readDockerMutation(pending.pending_key)).toEqual({
      container_id: "9".repeat(64), deployment_labels: labels, image_id: imageId,
      pending_key: pending.pending_key, version: "spawnfile.organization-handoff-recovery.private.v1"
    });
    await expect(restarted.observeDockerMutation(pending.pending_key, { containerId: "8".repeat(64), deploymentLabels: labels, imageId: `sha256:${"8".repeat(64)}` })).rejects.toThrow();
    const finalized = await restarted.finalize(pending.pending_key, { containerId: "9".repeat(64), deploymentLabels: labels });
    expect(finalized.container_id).toBe("9".repeat(64));
  });

  it("settles exact stale publication sidecars when a fresh worker joins a reservation", async () => {
    const initial = await store(); const started = await initial.begin(input());
    const name = `${Buffer.from(createOrganizationHandoffRecoveryKey(started.pending.pending_key), "utf8").toString("hex")}.json`;
    const directory = path.join(resolveOrganizationHandoffAuthorityRoot(), "recovery-reserved");
    const record = JSON.stringify(started.pending); const leaf = path.join(directory, name);
    await writeFile(`${leaf}.pending`, record, { mode: 0o600 });
    await writeFile(`${leaf}.recovery`, record, { mode: 0o600 });
    await initial.dispose();
    const restarted = await initialize();
    await expect(restarted.begin(input())).resolves.toEqual({ created: false, pending: started.pending });
    expect(await readdir(directory)).toEqual([name]);
  });

  it("reconstructs a durable crash while both recovery publication leaves are prefixes", async () => {
    const value = await store(); const pending = createOrganizationHandoffCapabilityPending(input());
    const name = `${Buffer.from(createOrganizationHandoffRecoveryKey(pending.pending_key), "utf8").toString("hex")}.json`;
    const directory = path.join(resolveOrganizationHandoffAuthorityRoot(), "recovery-reserved");
    const prefix = JSON.stringify(pending).slice(0, 32); const leaf = path.join(directory, name);
    await writeFile(`${leaf}.pending`, prefix, { mode: 0o600 });
    await writeFile(`${leaf}.recovery`, prefix, { mode: 0o600 });
    await expect(value.begin(input())).resolves.toEqual({ created: true, pending });
    expect(await readdir(directory)).toEqual([name]);
  });

  it("fails closed for closure, corruption, symlinked authority, and a changed authorization before any provider seam", async () => {
    const value = await store(); const pending = await value.reserve(input());
    const final = await value.finalize(pending.pending_key, { containerId: "3".repeat(64), deploymentLabels: labels });
    await close(value, final);
    await expect(value.resolver.resolve({ authorization: auth(final.organization_handoff_handle) })).rejects.toThrow();
    const openStore = await store(); const openPending = await openStore.reserve(input());
    const openFinal = await openStore.finalize(openPending.pending_key, { containerId: "4".repeat(64), deploymentLabels: labels });
    await expect(openStore.resolver.resolve({ authorization: auth(openFinal.organization_handoff_handle, `sha256:${"8".repeat(64)}`) })).rejects.toThrow();
    const file = path.join(resolveOrganizationHandoffAuthorityRoot(), "finalized", `${Buffer.from(openFinal.organization_handoff_handle).toString("hex")}.json`);
    await writeFile(file, "{}", "utf8"); await expect(openStore.resolver.resolve({ authorization: auth(openFinal.organization_handoff_handle) })).rejects.toThrow();
    const foreign = path.join(path.dirname(resolveOrganizationHandoffAuthorityRoot()), "foreign"); await writeFile(foreign, "x");
    const pendingFile = path.join(resolveOrganizationHandoffAuthorityRoot(), "pending", `${Buffer.from(openPending.pending_key).toString("hex")}.json`);
    await unlink(pendingFile); await symlink(foreign, pendingFile);
    await expect(openStore.reserve(input())).rejects.toThrow();
  });

  it("recovers exact zero/prefix and link-published crash states, but rejects mode and hardlink drift", async () => {
    const value = await store(); const pending = await value.reserve(input());
    const final = await value.finalize(pending.pending_key, { containerId: "5".repeat(64), deploymentLabels: labels });
    const file = path.join(resolveOrganizationHandoffAuthorityRoot(), "finalized", `${Buffer.from(final.organization_handoff_handle).toString("hex")}.json`);
    await link(file, `${file}.pending`);
    await expect(value.resolver.resolve({ authorization: auth(final.organization_handoff_handle) })).resolves.toBeTruthy();
    await expect(lstat(`${file}.pending`)).rejects.toMatchObject({ code: "ENOENT" });
    await chmod(file, 0o644); await expect(value.resolver.resolve({ authorization: auth(final.organization_handoff_handle) })).rejects.toThrow();
    await chmod(file, 0o600); await link(file, `${file}.foreign`);
    await expect(value.resolver.resolve({ authorization: auth(final.organization_handoff_handle) })).rejects.toThrow();

    const other = await store(); const otherPending = await other.reserve(input());
    const otherFinal = await other.finalize(otherPending.pending_key, { containerId: "6".repeat(64), deploymentLabels: labels });
    const zero = path.join(resolveOrganizationHandoffAuthorityRoot(), "finalized", `${Buffer.from(otherFinal.organization_handoff_handle).toString("hex")}.json`);
    await writeFile(zero, "", "utf8"); await expect(other.resolver.resolve({ authorization: auth(otherFinal.organization_handoff_handle) })).rejects.toThrow();

    const incomplete = await store(); const incompleteInput = input();
    const provisional = createOrganizationHandoffCapabilityPending(incompleteInput);
    const pendingPath = path.join(resolveOrganizationHandoffAuthorityRoot(), "pending", `${Buffer.from(provisional.pending_key).toString("hex")}.json.pending`);
    await writeFile(pendingPath, "", { mode: 0o600 });
    await expect(incomplete.reserve(incompleteInput)).resolves.toMatchObject({ pending_key: provisional.pending_key });
    const prefixInput = input(`sha256:${"7".repeat(64)}`);
    const prefix = createOrganizationHandoffCapabilityPending(prefixInput);
    const prefixPath = path.join(resolveOrganizationHandoffAuthorityRoot(), "pending", `${Buffer.from(prefix.pending_key).toString("hex")}.json.pending`);
    await writeFile(prefixPath, "{\"binding_digest\"", { mode: 0o600 });
    await expect(incomplete.reserve(prefixInput)).resolves.toMatchObject({ pending_key: prefix.pending_key });
  });

  it.each([["zero", ""], ["prefix", "{\"binding_digest\""]])("reconstructs %s publication records for every state transition", async (_mode, prefix) => {
      const pendingStore = await store(); const pending = createOrganizationHandoffCapabilityPending(input());
      const pendingFile = path.join(resolveOrganizationHandoffAuthorityRoot(), "pending", `${Buffer.from(pending.pending_key).toString("hex")}.json.pending`);
      await writeFile(pendingFile, prefix, { mode: 0o600 });
      await expect(pendingStore.reserve(input())).resolves.toMatchObject({ pending_key: pending.pending_key });

      const finalStore = await store(); const finalPending = await finalStore.reserve(input()); const containerId = "a".repeat(64);
      const finalHandle = createOrganizationHandoffHandle(finalPending, containerId);
      const finalBytes = JSON.stringify({ ...finalPending, container_id: containerId, organization_handoff_handle: finalHandle, state: "finalized" });
      const finalFile = path.join(resolveOrganizationHandoffAuthorityRoot(), "finalized", `${Buffer.from(finalHandle).toString("hex")}.json.pending`);
      await writeFile(finalFile, finalBytes.slice(0, prefix.length), { mode: 0o600 });
      const finalized = await finalStore.finalize(finalPending.pending_key, { containerId, deploymentLabels: labels });
      expect(finalized.organization_handoff_handle).toBe(finalHandle);

      const closeStore = await store(); const closePending = await closeStore.reserve(input()); const closeContainer = "b".repeat(64);
      const closeFinal = await closeStore.finalize(closePending.pending_key, { containerId: closeContainer, deploymentLabels: labels });
      const closedBytes = JSON.stringify({ ...closeFinal, state: "attach_closed" });
      const closedFile = path.join(resolveOrganizationHandoffAuthorityRoot(), "attach-closed", `${Buffer.from(closeFinal.organization_handoff_handle).toString("hex")}.json.pending`);
      await writeFile(closedFile, closedBytes.slice(0, prefix.length), { mode: 0o600 });
      await expect(close(closeStore, closeFinal)).resolves.toBeUndefined();
  });

  it("joins simultaneous cross-process-shaped publication and leaves a conflicting prefix untouched", async () => {
    const first = await store(); const second = await initialize();
    const [left, right] = await Promise.all([first.reserve(input()), second.reserve(input())]);
    expect(left).toEqual(right);
    const [leftFinal, rightFinal] = await Promise.all([
      first.finalize(left.pending_key, { containerId: "c".repeat(64), deploymentLabels: labels }),
      second.finalize(right.pending_key, { containerId: "c".repeat(64), deploymentLabels: labels })
    ]);
    expect(leftFinal).toEqual(rightFinal);
    const bad = await store(); const provisional = createOrganizationHandoffCapabilityPending(input());
    const file = path.join(resolveOrganizationHandoffAuthorityRoot(), "pending", `${Buffer.from(provisional.pending_key).toString("hex")}.json.pending`);
    await writeFile(file, "not-a-prefix", { mode: 0o600 });
    await expect(bad.reserve(input())).rejects.toThrow();
    expect(await readFile(file, "utf8")).toBe("not-a-prefix");
  });

  it("rejects deterministic directory replacement before reserve/finalize/close/resolve can use the attacker path", async () => {
    const replace = async (kind: "close" | "finalize" | "reserve" | "resolve") => {
      const root = resolveOrganizationHandoffAuthorityRoot(); const victim = path.join(root, "pending");
      const moved = path.join(root, "pending-real"); const attacker = path.join(root, `attacker-${kind}`);
      await rename(victim, moved); await mkdir(attacker, { mode: 0o700 }); await symlink(attacker, victim);
      return attacker;
    };
    await store(); let attacker = "";
    const hookedReserve = await initialize({ testHooks: { beforeLeafOperation: async () => { attacker = await replace("reserve"); } } });
    await expect(hookedReserve.reserve(input())).rejects.toThrow(); expect(await readdir(attacker)).toEqual([]);

  });

  it("keeps authority publication in the original directory across an ABA pathname replacement", async () => {
    await store();
    const root = resolveOrganizationHandoffAuthorityRoot(); const victim = path.join(root, "pending");
    const moved = path.join(root, "pending-original"); const attacker = path.join(root, "pending-attacker");
    const anchored = await initialize({ testHooks: { duringLeafOperation: async (_kind, operation) => {
      await rename(victim, moved); await mkdir(attacker, { mode: 0o700 }); await symlink(attacker, victim);
      try {
        await operation();
        expect(await readdir(attacker)).toEqual([]);
      } finally {
        await unlink(victim); await rename(moved, victim);
      }
    } } });
    const pending = await anchored.reserve(input());
    const record = path.join(victim, `${Buffer.from(pending.pending_key).toString("hex")}.json`);
    expect(JSON.parse(await readFile(record, "utf8"))).toEqual(pending);
    expect(await readdir(attacker)).toEqual([]);
  });

  it("reaps a helper when its parent is killed abruptly", async () => {
    await store(); const directory = path.join(resolveOrganizationHandoffAuthorityRoot(), "pending");
    const parent = fork(fileURLToPath(new URL("./organizationHandoffAuthorityFsWorkerParent.fixture.ts", import.meta.url)), [directory], {
      execArgv: ["--import", createRequire(import.meta.url).resolve("tsx")], silent: true
    });
    parent.stdout?.resume(); parent.stderr?.resume();
    const workerPid = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("fixture did not start")), 2_000);
      parent.once("message", (message: unknown) => {
        clearTimeout(timer); const pid = (message as { worker_pid?: unknown } | null)?.worker_pid;
        if (!Number.isSafeInteger(pid) || (pid as number) < 1) reject(new Error("fixture returned no worker")); else resolve(pid as number);
      });
      parent.once("exit", () => { clearTimeout(timer); reject(new Error("fixture exited before readiness")); });
    });
    parent.kill("SIGKILL"); await new Promise<void>((resolve) => parent.once("exit", () => resolve()));
    for (let attempt = 0; attempt < 30; attempt += 1) {
      try { process.kill(workerPid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return; throw error; }
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("orphaned organization handoff worker");
  });

  const poison = async (part: string, label: string): Promise<string> => {
    const root = resolveOrganizationHandoffAuthorityRoot(); const victim = path.join(root, part);
    const moved = path.join(root, `${part}-real-${label}`); const attacker = path.join(root, `attacker-${label}`);
    await rename(victim, moved); await mkdir(attacker, { mode: 0o700 }); await symlink(attacker, victim); return attacker;
  };

  it("rejects replacement in finalize before any redirected authority use", async () => {
    const finalBase = await store(); const finalPending = await finalBase.reserve(input()); let attacker = "";
    const finalHooked = await initialize({ testHooks: { beforeLeafOperation: async () => { attacker = await poison("finalized", "finalize"); } } });
    await expect(finalHooked.finalize(finalPending.pending_key, { containerId: "d".repeat(64), deploymentLabels: labels })).rejects.toThrow(); expect(await readdir(attacker)).toEqual([]);
    await finalBase.dispose(); await finalHooked.dispose();
  });

  it("rejects replacement in close before any redirected authority use", async () => {
    let attacker = "";
    const closeBase = await store(); const closePending = await closeBase.reserve(input()); const closeFinal = await closeBase.finalize(closePending.pending_key, { containerId: "e".repeat(64), deploymentLabels: labels });
    const closeHooked = await initialize({ testHooks: { beforeLeafOperation: async () => { attacker = await poison("attach-closed", "close"); } } });
    await expect(close(closeHooked, closeFinal)).rejects.toThrow(); expect(await readdir(attacker)).toEqual([]);
    await closeBase.dispose(); await closeHooked.dispose();
  });

  it("rejects replacement in resolve before any redirected authority use", async () => {
    let attacker = "";
    const resolveBase = await store(); const resolvePending = await resolveBase.reserve(input()); const resolveFinal = await resolveBase.finalize(resolvePending.pending_key, { containerId: "f".repeat(64), deploymentLabels: labels });
    const resolveHooked = await initialize({ testHooks: { beforeLeafOperation: async () => { attacker = await poison("finalized", "resolve"); } } });
    await expect(resolveHooked.resolver.resolve({ authorization: auth(resolveFinal.organization_handoff_handle) })).rejects.toThrow(); expect(await readdir(attacker)).toEqual([]);
    await resolveBase.dispose(); await resolveHooked.dispose();
  });
});
