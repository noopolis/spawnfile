import { describe, expect, it } from "vitest";

import { parseOpaqueTargetHandle } from "./contracts.js";
import { createDockerArtifactSpec, createDockerConfigArtifactSpec } from "./dockerArtifactsProvider.js";
import {
  createWorldServiceAuthorization,
  parseWorldServiceAuthorization,
  parseWorldServiceResolution
} from "./dockerWorldServiceAuthority.js";

const digest = (value: string): string => `sha256:${value.repeat(64)}`;
const handle = (value: string) => parseOpaqueTargetHandle(`opaque_${value.repeat(16)}`);
const selectedTarget = {
  fingerprint: `sha256:${"f".repeat(32)}`,
  handle: handle("t")
};

const authorizationInput = () => ({
  dataNetworkHandle: handle("n"),
  descriptorDigest: digest("d"),
  evidenceMountPath: "/run/world/evidence",
  evidenceVolumeHandle: handle("v"),
  operationHandle: handle("o"),
  requestDigest: digest("e"),
  runId: "run-world-service",
  secretBindingsHandle: handle("s"),
  selectedTarget,
  worldArtifactHandle: artifact().resultHandle
});

const authorization = () => createWorldServiceAuthorization(authorizationInput());

const artifact = () => createDockerArtifactSpec({
  artifactManifestDigest: digest("a"),
  imageDigest: digest("1"),
  imageReference: `registry.example/world@${digest("1")}`,
  operationHandle: handle("p"),
  requestDigest: digest("c"),
  selectedTargetHandle: selectedTarget.handle
});

const resolution = () => {
  const issued = authorization();
  const resolved = artifact();
  return {
    artifact: {
      artifact_manifest_digest: digest("a"),
      identity_kind: "oci_image_manifest" as const,
      image_digest: resolved.imageDigest,
      image_reference: resolved.imageReference,
      operation_handle: handle("p"),
      request_digest: digest("c"),
      result_handle: resolved.resultHandle
    },
    authorization: issued
  };
};

describe("world service authority", () => {
  it("round-trips one exact authorization and artifact binding", () => {
    const issued = authorization();
    expect(parseWorldServiceAuthorization(issued)).toEqual(issued);
    const parsed = parseWorldServiceResolution(resolution());
    expect(parsed.authorization).toEqual(issued);
    expect(parsed.artifact.result_handle).toBe(issued.world_artifact_handle);
    expect(Object.isFrozen(parsed)).toBe(true);
  });

  it("admits a local config ID only as the exact prepared-artifact variant", () => {
    const config = createDockerConfigArtifactSpec({
      archiveDigest: digest("9"), artifactManifestDigest: digest("a"), baseImageConfigDigest: digest("8"),
      buildPolicyDigest: digest("b"), bundleDigest: digest("c"), configId: digest("1"), daemonEpoch: digest("7"),
      entrypoint: "bundle.json", launcherDigest: digest("6"), networkAlias: "world", operationHandle: handle("p"),
      requestDigest: digest("d"), selectedTargetHandle: selectedTarget.handle,
      platform: { architecture: "amd64", os: "linux" }, platformDigest: digest("5")
    });
    const issued = createWorldServiceAuthorization({
      dataNetworkHandle: handle("n"), descriptorDigest: digest("d"), evidenceMountPath: "/run/world/evidence", evidenceVolumeHandle: handle("v"),
      operationHandle: handle("o"), requestDigest: digest("e"), runId: "run-world-service",
      secretBindingsHandle: handle("s"), selectedTarget, worldArtifactHandle: config.resultHandle
    });
    const value = {
      artifact: {
        archive_digest: digest("9"), artifact_manifest_digest: digest("a"), base_image_config_digest: digest("8"),
        build_policy_digest: digest("b"), bundle_digest: digest("c"), config_id: config.configId, daemon_epoch: digest("7"),
        entrypoint: "bundle.json", gc_tag: `spfb_${"a".repeat(58)}`, identity_kind: "docker_image_config_digest" as const,
        image_digest: config.configId, image_reference: config.configId,
        launcher_digest: digest("6"), network_alias: "world", operation_handle: handle("p"),
        platform: { architecture: "amd64", os: "linux" }, platform_digest: digest("5"),
        prepared_operation_handle: handle("q"), prepared_request_digest: digest("4"),
        request_digest: digest("d"), result_handle: config.resultHandle
      }, authorization: issued
    };
    expect(parseWorldServiceResolution(value).artifact).toMatchObject({
      config_id: config.configId, identity_kind: "docker_image_config_digest"
    });
    expect(() => parseWorldServiceResolution({ ...value, artifact: {
      ...value.artifact, image_reference: `registry.example/world@${config.configId}`
    } })).toThrow("Docker world-service lifecycle failed");
  });

  it.each([
    ["malformed authorization", (value: ReturnType<typeof resolution>) => ({
      ...value,
      authorization: { ...value.authorization, run_id: "not allowed" }
    })],
    ["artifact handle drift", (value: ReturnType<typeof resolution>) => ({
      ...value,
      artifact: { ...value.artifact, result_handle: handle("x") }
    })],
    ["mutable image", (value: ReturnType<typeof resolution>) => ({
      ...value,
      artifact: { ...value.artifact, image_reference: "registry.example/world:latest" }
    })],
    ["extra field", (value: ReturnType<typeof resolution>) => ({
      ...value,
      artifact: { ...value.artifact, private_id: "forbidden" }
    })]
  ])("rejects %s", (_name, mutate) => {
    expect(() => parseWorldServiceResolution(mutate(resolution()))).toThrow(
      "Docker world-service lifecycle failed"
    );
  });

  it("rejects accessors and proxies without executing them", () => {
    let hits = 0;
    const hostile = resolution();
    Object.defineProperty(hostile.artifact, "image_digest", {
      enumerable: true,
      get: () => { hits += 1; return digest("1"); }
    });
    expect(() => parseWorldServiceResolution(hostile)).toThrow();
    expect(hits).toBe(0);
    expect(() => parseWorldServiceResolution(new Proxy(resolution(), {
      ownKeys: () => { hits += 1; return []; }
    }))).toThrow();
    expect(hits).toBe(0);
  });

  it.each([
    ["a non-record selected target", { selectedTarget: null }],
    ["a malformed descriptor digest", { descriptorDigest: "sha256:nope" }],
    ["a malformed request digest", { requestDigest: null }],
    ["a malformed operation handle", { operationHandle: "opaque_short" }],
    ["a malformed run id", { runId: "contains spaces" }]
  ])("rejects authorization input with %s", (_name, replacement) => {
    expect(() => createWorldServiceAuthorization({
      ...authorizationInput(),
      ...replacement
    })).toThrow("Docker world-service lifecycle failed");
  });

  it.each([
    ["a non-string path", null],
    ["an overlong path", `/run/${"a".repeat(252)}`],
    ["an unapproved root", "/tmp/world/evidence"],
    ["an empty segment", "/run/world//evidence"],
    ["a trailing separator", "/run/world/evidence/"],
    ["a current-directory segment", "/run/world/./evidence"],
    ["a parent-directory segment", "/var/lib/world/../evidence"],
    ["the secret root", "/run/spawnfile-secrets"],
    ["a secret descendant", "/run/spawnfile-secrets/world"],
    ["an ancestor of the secret root", "/run"]
  ])("rejects authorization input with %s", (_name, evidenceMountPath) => {
    expect(() => createWorldServiceAuthorization({
      ...authorizationInput(),
      evidenceMountPath
    })).toThrow("Docker world-service lifecycle failed");
  });

  it.each([
    ["null", null],
    ["an array", []],
    ["an extra authorization field", { ...authorization(), private_id: "forbidden" }],
    ["the wrong authorization version", { ...authorization(), version: "v2" }],
    ["a null selected target", { ...authorization(), selected_target: null }],
    ["an extra selected-target field", {
      ...authorization(), selected_target: { ...authorization().selected_target, private_id: "forbidden" }
    }],
    ["a non-string selected-target fingerprint", {
      ...authorization(), selected_target: { ...authorization().selected_target, fingerprint: null }
    }],
    ["a malformed selected-target fingerprint", {
      ...authorization(), selected_target: { ...authorization().selected_target, fingerprint: "sha256:nope" }
    }]
  ])("rejects %s as an authorization packet", (_name, value) => {
    expect(() => parseWorldServiceAuthorization(value)).toThrow(
      "Docker world-service lifecycle failed"
    );
  });

  it("accepts the exact legacy OCI artifact shape and rejects malformed envelopes", () => {
    const value = resolution();
    const { identity_kind: _identityKind, ...legacyArtifact } = value.artifact;
    expect(parseWorldServiceResolution({
      artifact: legacyArtifact,
      authorization: value.authorization
    }).artifact.identity_kind).toBe("oci_image_manifest");

    expect(() => parseWorldServiceResolution(null)).toThrow("Docker world-service lifecycle failed");
    expect(() => parseWorldServiceResolution([])).toThrow("Docker world-service lifecycle failed");
    expect(() => parseWorldServiceResolution({
      ...value,
      private_id: "forbidden"
    })).toThrow("Docker world-service lifecycle failed");
    expect(() => parseWorldServiceResolution({
      ...value,
      artifact: null
    })).toThrow("Docker world-service lifecycle failed");
    expect(() => parseWorldServiceResolution({
      ...value,
      artifact: { ...value.artifact, identity_kind: 1 }
    })).toThrow("Docker world-service lifecycle failed");
    expect(() => parseWorldServiceResolution({
      ...value,
      artifact: { ...value.artifact, identity_kind: "unknown" }
    })).toThrow("Docker world-service lifecycle failed");
  });
});
