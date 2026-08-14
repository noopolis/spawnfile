import { fork } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { initializeTargetSecretSourceLifecycle } from "../auth/index.js";
import { createOrganizationAttachmentAuthorization } from "../target/organizationAttachmentAuthority.js";
import { createCanonicalSelectedTargetReceiptBytes, parseOpaqueTargetHandle } from "../target/index.js";
import { createTargetSecretSourceAuthorization } from "../target/dockerSecretsAuthority.js";
import { initializeOrganizationHandoffAuthorityStore } from "../deployment/organizationHandoffAuthorityStore.js";
import { createOrganizationHandoff, parseCanonicalSha256Digest } from "../deployment/organizationHandoffTypes.js";

const CHILD_VERSION = "spawnfile.target-default-authority-child.v1";
const descriptor = `sha256:${"a".repeat(64)}`;
const manifest = `sha256:${"b".repeat(64)}`;
const image = `sha256:${"c".repeat(64)}`;
const selected = Object.freeze({
  fingerprint: `sha256:${"d".repeat(32)}`,
  handle: parseOpaqueTargetHandle(`opaque_${"e".repeat(64)}`),
  version: "spawnfile.target-resource.selected-target.v1" as const
});
const selectedBinding = Object.freeze({ fingerprint: selected.fingerprint, handle: selected.handle });
const selectedDigest = `sha256:${createHash("sha256")
  .update(createCanonicalSelectedTargetReceiptBytes(selected), "utf8").digest("hex")}`;
const labels = Object.freeze({
  "com.spawnfile.compile_fingerprint": "sf1.authority",
  "com.spawnfile.deployment": "authority",
  "com.spawnfile.project": "authority",
  "com.spawnfile.run_id": "run_authority",
  "com.spawnfile.unit": "authority-unit",
  "com.spawnfile.version": "0.1"
});
const roots: string[] = [];
const originalHome = process.env.SPAWNFILE_HOME;

const FAILURE_STAGES = ["config", "init", "secret", "handoff", "dispose"] as const;
type FailureStage = (typeof FAILURE_STAGES)[number];
type ChildResult = Readonly<{ ok: boolean; stage?: FailureStage }>;
interface CapabilityState {
  readonly config: Record<string, unknown>;
  readonly handoff: ReturnType<typeof createOrganizationAttachmentAuthorization>;
  readonly home: string;
  readonly secret: ReturnType<typeof createTargetSecretSourceAuthorization>;
  readonly sourceHandle: string;
}

afterEach(async () => {
  if (originalHome === undefined) delete process.env.SPAWNFILE_HOME;
  else process.env.SPAWNFILE_HOME = originalHome;
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

const exact = (raw: unknown, keys: readonly string[]): Record<string, unknown> | undefined =>
  raw !== null && typeof raw === "object" && !Array.isArray(raw)
  && Object.getPrototypeOf(raw) === Object.prototype
  && Object.keys(raw as Record<string, unknown>).sort().join(",") === [...keys].sort().join(",")
    ? raw as Record<string, unknown> : undefined;

const runChild = (home: string, request: Record<string, unknown>): Promise<ChildResult> =>
  new Promise((resolve, reject) => {
    const child = fork(fileURLToPath(new URL("../../fixtures/support/targetDefaultAuthoritySession.fixture.ts", import.meta.url)), [], {
      env: { SPAWNFILE_HOME: home },
      execArgv: ["--import", createRequire(import.meta.url).resolve("tsx")],
      silent: true
    });
    let ready = false;
    let result: ChildResult | undefined;
    let settled = false;
    let output = 0;
    const fail = (reason = "target default authority child failed"): void => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new Error(reason));
    };
    const timer = setTimeout(() => fail("target default authority child timed out"), 10_000);
    const collect = (chunk: Buffer): void => { output += chunk.length; if (output > 0) fail(); };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    child.on("message", (raw: unknown) => {
      const message = exact(raw, ready ? ["handoff", "kind", "ok", "secret", "version"] : ["kind", "version"])
        ?? exact(raw, ready ? ["kind", "ok", "stage", "version"] : ["kind", "version"]);
      if (!message || message.version !== CHILD_VERSION) return fail();
      if (!ready && message.kind === "ready") {
        ready = true;
        if (Buffer.byteLength(JSON.stringify(request), "utf8") > 16_384 || !child.send(request)) fail();
        return;
      }
      if (ready && message.kind === "result" && typeof message.ok === "boolean"
        && (message.ok === false
          ? FAILURE_STAGES.includes(message.stage as FailureStage)
          : message.handoff === true && message.secret === true)) {
        result = Object.freeze(message.ok === false
          ? { ok: false, stage: message.stage as FailureStage }
          : { ok: true });
        return;
      }
      fail();
    });
    child.on("error", () => fail());
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (settled) return;
      if (!ready || !result || output !== 0 || code !== (result.ok ? 0 : 1)) return fail(`child state ${code} ${JSON.stringify(result)}`);
      settled = true;
      resolve(result);
    });
  });

const prepare = async (): Promise<CapabilityState> => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "target-default-authority-child-")));
  roots.push(root);
  const home = path.join(root, "home");
  const output = path.join(root, "output");
  await mkdir(home, { mode: 0o700 });
  await mkdir(output, { mode: 0o700 });
  process.env.SPAWNFILE_HOME = home;
  const config = {
    artifactMappings: [{
      artifact_manifest_digest: manifest,
      image_digest: image,
      image_reference: `registry.example/authority@${image}`
    }],
    context: "authority_1",
    dockerCommand: "docker-safe",
    evidenceDestination: path.join(output, "evidence.tar"),
    helperArtifactManifestDigest: manifest,
    timeoutMs: 30_000
  };
  const lifecycle = await initializeTargetSecretSourceLifecycle();
  const source = await lifecycle.author(new TextEncoder().encode("S4_PARENT_ONLY_SECRET"));
  await lifecycle.grant({
    descriptor_digest: descriptor,
    name: "token",
    run_id: "run_authority",
    scope: "world",
    selected_target: selected,
    source_handle: source.source_handle
  });
  const secret = createTargetSecretSourceAuthorization({
    descriptorDigest: descriptor,
    name: "token",
    operationHandle: parseOpaqueTargetHandle(`opaque_${"f".repeat(64)}`),
    requestDigest: `sha256:${"1".repeat(64)}`,
    runId: "run_authority",
    scope: "world",
    selectedTarget: selectedBinding,
    sourceHandle: source.source_handle
  });
  await lifecycle.resolver.resolve({ authorization: secret });
  const handoff = createOrganizationHandoff("run_authority", {
    bindingDigest: parseCanonicalSha256Digest(`sha256:${"2".repeat(64)}`),
    networkAttachmentHandle: parseOpaqueTargetHandle(`opaque_${"3".repeat(64)}`),
    selectedTargetReceiptDigest: parseCanonicalSha256Digest(selectedDigest)
  });
  const store = await initializeOrganizationHandoffAuthorityStore();
  const pending = await store.reserve({
    bindingDigest: handoff.binding_digest,
    containerName: "authority-container",
    deploymentLabels: labels,
    descriptorDigest: descriptor,
    handoff,
    selectedTarget: selected,
    selectedTargetReceiptDigest: selectedDigest
  });
  const finalized = await store.finalize(pending.pending_key, {
    containerId: "4".repeat(64), deploymentLabels: labels
  });
  const attachment = createOrganizationAttachmentAuthorization({
    descriptorDigest: descriptor,
    operationHandle: parseOpaqueTargetHandle(`opaque_${"5".repeat(64)}`),
    organizationHandoffHandle: finalized.organization_handoff_handle,
    requestDigest: `sha256:${"6".repeat(64)}`,
    runId: "run_authority",
    selectedTarget: selected
  });
  await store.resolver.resolve({ authorization: attachment });
  await store.dispose();
  return Object.freeze({
    config, handoff: attachment, home, secret,
    sourceHandle: source.source_handle
  });
};

const request = (state: CapabilityState, changes: Record<string, unknown> = {}) => ({
  config: state.config,
  handoff: state.handoff,
  secret: state.secret,
  version: CHILD_VERSION,
  ...changes
});

describe("target default authority session cross-process", () => {
  it("resolves the exact B113 and B114 capabilities from fixed parent-authored stores", async () => {
    const state = await prepare();
    await expect(runChild(state.home, request(state))).resolves.toEqual({ ok: true });
  }, 30_000);

  it("fails closed for missing, malformed, cross-host, duplicate, drifted, legacy, and revoked inputs", async () => {
    const state = await prepare();
    const missing = { ...state.secret, sourceHandle: parseOpaqueTargetHandle(`opaque_${"7".repeat(64)}`) };
    const malformed = { ...state.secret, sourceHandle: "not-an-opaque-handle" };
    const crossHost = {
      ...state.secret,
      selectedTarget: { fingerprint: `sha256:${"8".repeat(32)}`, handle: selected.handle }
    };
    const drifted = { ...state.handoff, descriptor_digest: `sha256:${"9".repeat(64)}` };
    const duplicateConfig = { ...state.config, artifactMappings: [
      ...(state.config.artifactMappings as readonly unknown[]),
      (state.config.artifactMappings as readonly unknown[])[0]
    ] };
    for (const [changed, stage] of [
      [{ secret: missing }, "secret"],
      [{ secret: malformed }, "secret"],
      [{ secret: crossHost }, "secret"],
      [{ handoff: drifted }, "handoff"],
      [{ config: duplicateConfig }, "config"]
    ] as const) await expect(runChild(state.home, request(state, changed))).resolves.toEqual({ ok: false, stage });

    const legacy = await realpath(await mkdtemp(path.join(os.tmpdir(), "target-default-authority-legacy-")));
    roots.push(legacy);
    const legacyHome = path.join(legacy, "home");
    const legacyOutput = path.join(legacy, "output");
    await mkdir(legacyHome, { mode: 0o700 });
    await mkdir(legacyOutput, { mode: 0o700 });
    await mkdir(path.join(legacyHome, "deployments"), { mode: 0o700 });
    await chmod(path.join(legacyHome, "deployments"), 0o755);
    await expect(runChild(legacyHome, request(state, {
      config: { ...state.config, evidenceDestination: path.join(legacyOutput, "evidence.tar") }
    }))).resolves.toEqual({ ok: false, stage: "init" });

    await expect(runChild(state.home, request(state))).resolves.toEqual({ ok: true });

    const lifecycle = await initializeTargetSecretSourceLifecycle();
    await lifecycle.revokeGrant(state.sourceHandle);
    await expect(runChild(state.home, request(state))).resolves.toEqual({ ok: false, stage: "secret" });
  }, 60_000);
});
