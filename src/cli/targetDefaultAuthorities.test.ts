import { mkdir, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  TARGET_RESOURCE_REQUEST_VERSION,
  parseOpaqueTargetHandle,
  type TargetResourceReceipt
} from "../target/contracts.js";
import { createDockerArtifactSpec } from "../target/dockerArtifactsProvider.js";
import { createWorldServiceAuthorization } from "../target/dockerWorldServiceAuthority.js";
import { createTargetReceiptDigest } from "../target/handles.js";
import { loadTargetDefaultConfig, type TargetDefaultConfig } from "./targetDefaultConfig.js";
import {
  TARGET_DEFAULT_AUTHORITIES_ERROR,
  initializeTargetDefaultAuthoritySession,
  type TargetDefaultAuthoritySession,
  type TargetDefaultAuthorities
} from "./targetDefaultAuthorities.js";

const descriptor = `sha256:${"d".repeat(64)}`;
const manifest = `sha256:${"a".repeat(64)}`;
const imageDigest = `sha256:${"b".repeat(64)}`;
const imageReference = `registry.example/spawn/helper@${imageDigest}`;
const selected = {
  fingerprint: `sha256:${"c".repeat(32)}`,
  handle: parseOpaqueTargetHandle(`opaque_${"e".repeat(64)}`)
};
const roots: string[] = [];
const sessions: TargetDefaultAuthoritySession[] = [];
const originalHome = process.env.SPAWNFILE_HOME;

afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.dispose()));
  if (originalHome === undefined) delete process.env.SPAWNFILE_HOME;
  else process.env.SPAWNFILE_HOME = originalHome;
  await Promise.all(roots.splice(0).map((root) => rm(root, {
    force: true,
    recursive: true
  })));
});

const request = (changes: Record<string, unknown> = {}) => ({
  artifact_manifest_digest: manifest,
  descriptor_digest: descriptor,
  expected_revision: 0,
  idempotency_key: "idem_aaaaaaaaaaaaaaaa",
  operation: "resolve_world_artifact",
  run_id: "run-one",
  selected_target: selected,
  version: TARGET_RESOURCE_REQUEST_VERSION,
  ...changes
});
const setup = async (): Promise<{
  authorities: TargetDefaultAuthorities;
  config: TargetDefaultConfig;
}> => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "target-authorities-")));
  roots.push(root);
  const home = path.join(root, "home");
  const output = path.join(root, "output");
  await mkdir(home, { mode: 0o700 });
  await mkdir(output, { mode: 0o700 });
  const artifactMappings = [{
    artifact_manifest_digest: manifest,
    image_digest: imageDigest,
    image_reference: imageReference
  }];
  process.env.SPAWNFILE_HOME = home;
  const config = await loadTargetDefaultConfig({
    artifactMappings,
    context: "prod_1",
    dockerCommand: "docker-safe",
    evidenceDestination: path.join(output, "evidence.tar"),
    helperArtifactManifestDigest: manifest,
    timeoutMs: 30_000
  });
  const session = await initializeTargetDefaultAuthoritySession(config);
  sessions.push(session);
  return { authorities: session.authorities, config };
};
const completeArtifact = async (
  authorities: TargetDefaultAuthorities,
  rawRequest = request()
) => {
  const authority = await authorities.journals.resolve({
    context: "prod_1",
    request: rawRequest
  });
  const reservation = await authority.journal.reserve(rawRequest);
  if (reservation.kind !== "owner") throw new Error("owner expected");
  const spec = createDockerArtifactSpec({
    artifactManifestDigest: manifest,
    imageDigest,
    imageReference,
    operationHandle: reservation.claim.operationHandle,
    requestDigest: reservation.claim.requestDigest,
    selectedTargetHandle: selected.handle
  });
  await authorities.artifactIdentityStore.bind({
    artifactManifestDigest: manifest,
    imageDigest,
    imageReference,
    operationHandle: reservation.claim.operationHandle,
    requestDigest: reservation.claim.requestDigest,
    resultHandle: spec.resultHandle,
    selectedTargetHandle: selected.handle
  });
  const base = {
    cleanup_state: "not_requested",
    descriptor_digest: descriptor,
    export_state: "not_requested",
    labels: Object.entries(spec.labels).map(([key, value]) => ({ key, value })),
    operation: "resolve_world_artifact",
    operation_handle: reservation.claim.operationHandle,
    receipt_digest: `sha256:${"0".repeat(64)}`,
    request_digest: reservation.claim.requestDigest,
    result_handle: spec.resultHandle,
    resulting_revision: (await authority.journal.read()).revision + 1,
    run_id: "run-one",
    selected_target: selected,
    version: "spawnfile.target-resource.receipt.v1"
  };
  const receipt = {
    ...base,
    receipt_digest: createTargetReceiptDigest(base)
  } as TargetResourceReceipt;
  await authority.journal.complete(reservation.claim, receipt);
  return { authority, reservation, spec };
};

describe("private target default authorities", () => {
  it("initializes deterministic stores from the fixed host-local authorities", async () => {
    const value = await setup();
    expect(Object.isFrozen(value.authorities)).toBe(true);
    expect(Object.hasOwn(value.config, "resolvers")).toBe(false);
    expect(Object.keys(value.authorities.secretResolver)).toEqual(["resolve"]);
    expect(Object.keys(value.authorities.handoffResolver)).toEqual(["resolve"]);
    expect(Object.keys(value.authorities.journals)).toEqual(["resolve"]);
    expect(Reflect.ownKeys(value.authorities.journals)).toEqual(["resolve"]);
    expect((value.authorities.journals as unknown as {
      resolveIdentity?: unknown;
    }).resolveIdentity).toBeUndefined();
  });

  it("does not initialize a helper resolver when the config has no helper authority", async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "target-authorities-helper-free-")));
    roots.push(root);
    const home = path.join(root, "home");
    const output = path.join(root, "output");
    await mkdir(home, { mode: 0o700 });
    await mkdir(output, { mode: 0o700 });
    process.env.SPAWNFILE_HOME = home;
    const config = await loadTargetDefaultConfig({
      context: "prod_1",
      dockerCommand: "docker-safe",
      evidenceDestination: path.join(output, "evidence.tar"),
      timeoutMs: 30_000
    });
    const session = await initializeTargetDefaultAuthoritySession(config);
    sessions.push(session);
    expect(session.authorities.helperArtifactResolver).toBeUndefined();
  });

  it("owns the B114 worker graph in one idempotent explicit session close", async () => {
    const value = await setup();
    const session = sessions.at(-1);
    if (!session) throw new Error("session expected");
    await Promise.all([session.dispose(), session.dispose(), session.dispose()]);
    await expect(value.authorities.handoffResolver.resolve({ authorization: {} as never }))
      .rejects.toThrow("Organization handoff authority failed");
  });

  it("fails with one bounded authority error before exposing any provider", async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "target-authorities-fail-")));
    roots.push(root);
    const home = path.join(root, "home");
    const output = path.join(root, "output");
    await mkdir(home, { mode: 0o700 });
    await mkdir(output, { mode: 0o700 });
    // B114 refuses a legacy/public authority directory.  This occurs during
    // initialization, before a handler or Docker provider can be constructed.
    await mkdir(path.join(home, "deployments"), { mode: 0o755 });
    process.env.SPAWNFILE_HOME = home;
    const config = await loadTargetDefaultConfig({
      artifactMappings: [{
        artifact_manifest_digest: manifest,
        image_digest: imageDigest,
        image_reference: imageReference
      }],
      context: "prod_1",
      dockerCommand: "docker-safe",
      evidenceDestination: path.join(output, "evidence.tar"),
      helperArtifactManifestDigest: manifest,
      timeoutMs: 30_000
    });
    await expect(initializeTargetDefaultAuthoritySession(config))
      .rejects.toThrow(TARGET_DEFAULT_AUTHORITIES_ERROR);
  });

  it("reuses only the exact journal identity and isolates distinct runs", async () => {
    const value = await setup();
    const first = await value.authorities.journals.resolve({
      context: "prod_1", request: request()
    });
    const again = await value.authorities.journals.resolve({
      context: "prod_1", request: request()
    });
    expect(again.journal).toBe(first.journal);
    const distinct = await value.authorities.journals.resolve({
      context: "prod_1",
      request: request({ idempotency_key: "idem_bbbbbbbbbbbbbbbb", run_id: "run-two" })
    });
    expect(distinct.journal).not.toBe(first.journal);
    expect((await distinct.journal.read()).run_id).toBe("run-two");
    await expect(value.authorities.journals.resolve({
      context: "wrong", request: request()
    })).rejects.toThrow(TARGET_DEFAULT_AUTHORITIES_ERROR);
  });

  it("fails closed for malformed selected identity and pending helper resolution", async () => {
    const value = await setup();
    await expect(value.authorities.journals.resolve({
      context: "prod_1",
      request: request({ selected_target: { ...selected, handle: "wrong" } })
    })).rejects.toThrow(TARGET_DEFAULT_AUTHORITIES_ERROR);
    const authority = await value.authorities.journals.resolve({
      context: "prod_1", request: request()
    });
    await authority.journal.reserve(request());
    await expect(value.authorities.helperArtifactResolver!.resolve({
      context: "prod_1", request: request()
    })).rejects.toThrow(TARGET_DEFAULT_AUTHORITIES_ERROR);
  });

  it("rejects hostile resolver envelopes before getters or authority effects", async () => {
    const value = await setup();
    let reads = 0;
    const accessor = Object.defineProperty({}, "request", {
      enumerable: true,
      get: () => { reads += 1; return request(); }
    });
    Object.defineProperty(accessor, "context", {
      enumerable: true,
      value: "prod_1"
    });
    for (const invoke of [
      () => value.authorities.journals.resolve(accessor as never),
      () => value.authorities.helperArtifactResolver!.resolve(accessor as never),
      () => value.authorities.journals.resolve(new Proxy({
        context: "prod_1", request: request()
      }, {})),
      () => value.authorities.helperArtifactResolver!.resolve({
        context: "prod_1", request: request(), extra: true
      } as never),
      () => value.authorities.worldResolver.resolve(Object.defineProperty({}, "authorization", {
        enumerable: true,
        get: () => { reads += 1; return {}; }
      }) as never)
    ]) {
      await expect(invoke()).rejects.toThrow(TARGET_DEFAULT_AUTHORITIES_ERROR);
    }
    const hidden = { context: "prod_1", request: request() };
    Object.defineProperty(hidden, "context", { enumerable: false, value: "prod_1" });
    await expect(value.authorities.journals.resolve(hidden))
      .rejects.toThrow(TARGET_DEFAULT_AUTHORITIES_ERROR);
    expect(reads).toBe(0);
    expect(await readdir(value.config.paths.journals)).toEqual([]);
  });

  it("resolves one exact completed helper identity across restart", async () => {
    const value = await setup();
    const completed = await completeArtifact(value.authorities);
    const helper = await value.authorities.helperArtifactResolver!.resolve({
      context: "prod_1", request: request()
    });
    expect(helper).toMatchObject({
      artifactIdentity: {
        artifactManifestDigest: manifest,
        imageDigest,
        imageReference,
        resultHandle: completed.spec.resultHandle
      },
      bundle: {
        operation_handle: completed.reservation.claim.operationHandle,
        request_digest: completed.reservation.claim.requestDigest,
        result_handle: completed.spec.resultHandle
      }
    });
    const restarted = await initializeTargetDefaultAuthoritySession(value.config);
    sessions.push(restarted);
    await expect(restarted.authorities.helperArtifactResolver!.resolve({
      context: "prod_1", request: request()
    })).resolves.toEqual(helper);
  });

  it("rejects duplicate completed helper provenance", async () => {
    const value = await setup();
    await completeArtifact(value.authorities);
    await completeArtifact(value.authorities, request({
      expected_revision: 1,
      idempotency_key: "idem_bbbbbbbbbbbbbbbb"
    }));
    await expect(value.authorities.helperArtifactResolver!.resolve({
      context: "prod_1", request: request()
    })).rejects.toThrow(TARGET_DEFAULT_AUTHORITIES_ERROR);
  });

  it("rejects exact receipt-to-identity tuple drift and configured mapping drift", async () => {
    for (const changes of [
      { resultHandle: parseOpaqueTargetHandle("opaque_driftresult000001") },
      { operationHandle: parseOpaqueTargetHandle("opaque_driftoperation001") },
      { requestDigest: `sha256:${"1".repeat(64)}` },
      { artifactManifestDigest: `sha256:${"2".repeat(64)}` },
      { imageDigest: `sha256:${"3".repeat(64)}` },
      { imageReference: `registry.example/spawn/drift@sha256:${"b".repeat(64)}` }
    ]) {
      const value = await setup();
      const completed = await completeArtifact(value.authorities);
      const binding = await value.authorities.artifactIdentityStore.resolveOperation(
        completed.reservation.claim.operationHandle,
        completed.reservation.claim.requestDigest
      );
      if (!binding) throw new Error("binding expected");
      const lookup = vi.spyOn(value.authorities.artifactIdentityStore, "resolveOperation")
        .mockResolvedValue({ ...binding, ...changes });
      try {
        await expect(value.authorities.helperArtifactResolver!.resolve({
          context: "prod_1", request: request()
        })).rejects.toThrow(TARGET_DEFAULT_AUTHORITIES_ERROR);
        expect(lookup).toHaveBeenCalled();
      } finally {
        lookup.mockRestore();
      }
    }
  }, 20_000);

  it("isolates wrong run and descriptor identities from completed helper authority", async () => {
    const value = await setup();
    await completeArtifact(value.authorities);
    for (const changes of [
      { run_id: "run-wrong" },
      { descriptor_digest: `sha256:${"9".repeat(64)}` }
    ]) {
      await expect(value.authorities.helperArtifactResolver!.resolve({
        context: "prod_1",
        request: request({ ...changes, idempotency_key: "idem_cccccccccccccccc" })
      })).rejects.toThrow(TARGET_DEFAULT_AUTHORITIES_ERROR);
    }
  });

  it("resolves a world artifact only by its exact reviewed result handle", async () => {
    const value = await setup();
    const completed = await completeArtifact(value.authorities);
    const authorization = createWorldServiceAuthorization({
      dataNetworkHandle: parseOpaqueTargetHandle("opaque_networkauthority"),
      descriptorDigest: descriptor,
      evidenceMountPath: "/run/world/evidence",
      evidenceVolumeHandle: parseOpaqueTargetHandle("opaque_evidenceauthority"),
      operationHandle: parseOpaqueTargetHandle("opaque_worldoperation01"),
      requestDigest: `sha256:${"f".repeat(64)}`,
      runId: "run-one",
      secretBindingsHandle: parseOpaqueTargetHandle("opaque_secretauthority01"),
      selectedTarget: selected,
      worldArtifactHandle: completed.spec.resultHandle
    });
    await expect(value.authorities.worldResolver.resolve({ authorization }))
      .resolves.toMatchObject({
        artifact: {
          artifact_manifest_digest: manifest,
          result_handle: completed.spec.resultHandle
        },
        authorization
      });
    const wrong = createWorldServiceAuthorization({
      dataNetworkHandle: authorization.data_network_handle,
      descriptorDigest: descriptor,
      evidenceMountPath: authorization.evidence_mount_path,
      evidenceVolumeHandle: authorization.evidence_volume_handle,
      operationHandle: authorization.operation_handle,
      requestDigest: authorization.request_digest,
      runId: "run-one",
      secretBindingsHandle: authorization.secret_bindings_handle,
      selectedTarget: selected,
      worldArtifactHandle: parseOpaqueTargetHandle("opaque_wrongartifact001")
    });
    await expect(value.authorities.worldResolver.resolve({ authorization: wrong }))
      .rejects.toThrow(TARGET_DEFAULT_AUTHORITIES_ERROR);
  });
});
