import { describe, expect, it } from "vitest";

import type { DeploymentRecord } from "../deployment/index.js";

import { collectRegistryDriftObservations } from "./registryDrift.js";

const imageRecord = (
  overrides: { digest?: string | null; ref?: string } = {}
): DeploymentRecord => ({
  auth_profile: null,
  compile_fingerprint: "sf1:abc",
  created_at: "2026-06-13T00:00:00.000Z",
  manager: "docker",
  name: "research",
  output_directory: null,
  source: {
    digest: overrides.digest === undefined ? "sha256:recorded" : overrides.digest,
    kind: "image",
    ref: overrides.ref ?? "you/org:1.0.0"
  },
  target: {
    endpoint_fingerprint: "sha256:0123456789abcdef0123456789abcdef",
    kind: "context",
    name: "default"
  },
  units: [
    {
      container_id: "c1",
      container_name: "spawnfile-research",
      contains: [],
      id: "research-container",
      image_id: "i1",
      image_tag: "you/org:1.0.0",
      kind: "container",
      runtime_instances: []
    }
  ],
  version: "spawnfile.deployment.v2"
});

describe("collectRegistryDriftObservations", () => {
  it("warns when the registry digest differs from the recorded digest", async () => {
    const observations = await collectRegistryDriftObservations({
      deployments: [imageRecord()],
      resolveDigest: async () => "sha256:newer"
    });
    expect(observations[0]).toMatchObject({ severity: "warn" });
    expect(observations[0]?.message).toContain("newer build");
  });

  it("reports ok when the digest matches", async () => {
    const observations = await collectRegistryDriftObservations({
      deployments: [imageRecord()],
      resolveDigest: async () => "sha256:recorded"
    });
    expect(observations[0]).toMatchObject({ severity: "ok" });
  });

  it("skips digest-pinned refs as ok", async () => {
    const observations = await collectRegistryDriftObservations({
      deployments: [imageRecord({ ref: "you/org@sha256:" + "a".repeat(64) })],
      resolveDigest: async () => {
        throw new Error("should not be called");
      }
    });
    expect(observations[0]).toMatchObject({ severity: "ok" });
    expect(observations[0]?.message).toContain("digest-pinned");
  });

  it("reports unknown when the recorded digest is null", async () => {
    const observations = await collectRegistryDriftObservations({
      deployments: [imageRecord({ digest: null })],
      resolveDigest: async () => "sha256:newer"
    });
    expect(observations[0]).toMatchObject({ severity: "unknown" });
  });

  it("reports unknown when the registry digest cannot be resolved", async () => {
    const observations = await collectRegistryDriftObservations({
      deployments: [imageRecord()],
      resolveDigest: async () => null
    });
    expect(observations[0]).toMatchObject({ severity: "unknown" });
  });

  it("passes host-target base args to the resolver", async () => {
    const hostRecord: DeploymentRecord = {
      ...imageRecord(),
      target: { kind: "host", value: "ssh://ops@vm" }
    };
    let seenArgs: string[] = [];
    await collectRegistryDriftObservations({
      deployments: [hostRecord],
      resolveDigest: async (_ref, baseArgs) => {
        seenArgs = baseArgs;
        return "sha256:recorded";
      }
    });
    expect(seenArgs).toEqual(["--host", "ssh://ops@vm"]);
  });

  it("skips project deployments entirely", async () => {
    const projectRecord = {
      ...imageRecord(),
      output_directory: "/p/.spawn",
      source: { kind: "project" as const, root: "/p" }
    };
    const observations = await collectRegistryDriftObservations({
      deployments: [projectRecord],
      resolveDigest: async () => "sha256:x"
    });
    expect(observations).toHaveLength(0);
  });
});
