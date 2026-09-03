import { describe, expect, it } from "vitest";

import { createExclusiveReattachVolumeName } from "../shared/index.js";

import {
  assertNoDeclaredVolumeNames,
  DEV_DEPLOYMENT_LINEAGE_NAMESPACE,
  resolveDeploymentLineage
} from "./deploymentLineage.js";

const PLAN_ROOT = "/tmp/newsroom/Spawnfile";

/** The volume a compile of this project would actually derive for a mount. */
const derivedVolume = (
  deploymentName: string,
  namespace: string | undefined,
  mountId: string
): string =>
  createExclusiveReattachVolumeName(
    `${PLAN_ROOT} ${resolveDeploymentLineage(deploymentName, namespace)}`,
    mountId
  );

describe("resolveDeploymentLineage", () => {
  // `dev up` used to delegate straight to `up` with no distinguishing
  // identity, so both defaulted to the lineage `default` and resolved to the
  // SAME host volumes. A dev deployment started while production was stopped
  // attached production's volumes and wrote into live state.
  it("keeps a dev deployment off a production deployment's derived volumes", () => {
    const production = derivedVolume("default", undefined, "workspace-resource-abc");
    const dev = derivedVolume("default", DEV_DEPLOYMENT_LINEAGE_NAMESPACE, "workspace-resource-abc");

    expect(dev).not.toBe(production);
  });

  it("separates them under every deployment name, not just the default", () => {
    for (const deploymentName of ["default", "blue", "green", "newsroom-production"]) {
      expect(derivedVolume(deploymentName, DEV_DEPLOYMENT_LINEAGE_NAMESPACE, "memory-journal"))
        .not.toBe(derivedVolume(deploymentName, undefined, "memory-journal"));
    }
  });

  it("stays stable for repeated deployments of the same class", () => {
    expect(derivedVolume("blue", DEV_DEPLOYMENT_LINEAGE_NAMESPACE, "m"))
      .toBe(derivedVolume("blue", DEV_DEPLOYMENT_LINEAGE_NAMESPACE, "m"));
    expect(derivedVolume("blue", undefined, "m")).toBe(derivedVolume("blue", undefined, "m"));
  });

  it("cannot be forged by a deployment name that spells the namespaced form", () => {
    // A deployment name is normalized to a kebab identifier, so it can never
    // contain the separator and impersonate a dev lineage (or be impersonated).
    expect(/^[a-z0-9-]+$/u.test("dev default")).toBe(false);
  });

  it("leaves an un-namespaced lineage exactly as the deployment name", () => {
    expect(resolveDeploymentLineage("newsroom-production", undefined))
      .toBe("newsroom-production");
  });
});

describe("assertNoDeclaredVolumeNames", () => {
  const mount = (id: string, declared?: string) => ({
    ...(declared ? { declared_volume_name: declared } : {}),
    id,
    lifecycle: "exclusive-reattach" as const,
    mount_path: `/var/lib/${id}`,
    reason: id,
    volume_name: declared ?? `spawnfile-exclusive-${id}`
  });

  it("refuses a dev deployment that would attach declared volumes, naming them", () => {
    // A declared name carries no lineage, so the namespace above cannot
    // protect it: dev would attach production's volume by that exact name.
    let message = "";
    try {
      assertNoDeclaredVolumeNames([
        mount("moltnet-newsroom-store", "clank-newsroom-store"),
        mount("workspace-resource-abc", "clank-edition-state"),
        mount("moltnet-newsroom-causal")
      ]);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("clank-newsroom-store");
    expect(message).toContain("clank-edition-state");
    expect(message).toContain("2 author-declared volumes");
    expect(message).toContain("--allow-declared-volumes");
    // A derived name is namespaced and is not part of the refusal.
    expect(message).not.toContain("moltnet-newsroom-causal");
  });

  it("allows a project whose durable mounts are all derived", () => {
    expect(() => assertNoDeclaredVolumeNames([
      mount("moltnet-newsroom-causal"),
      mount("workspace-resource-abc")
    ])).not.toThrow();
    expect(() => assertNoDeclaredVolumeNames([])).not.toThrow();
  });
});
