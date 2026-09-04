import { describe, expect, it } from "vitest";

import { createExclusiveReattachVolumeName } from "../shared/index.js";
import { normalizeDeploymentName } from "../deployment/names.js";

import {
  assertNoDeclaredVolumeNames,
  DEV_DEPLOYMENT_LINEAGE_NAMESPACE,
  resolveDeploymentLineage
} from "./deploymentLineage.js";

const PLAN_ROOT = "/tmp/newsroom/Spawnfile";

/**
 * The volume a compile of this project would actually derive for a mount.
 *
 * The `\0` join mirrors the compiler exactly (containerArtifactsPlans.ts,
 * memoryArtifacts.ts, moltnetArtifacts.ts, containerTargetResources.ts all
 * build `${planRoot}\0${deploymentLineage}`). An earlier version of this
 * helper joined with a space, which still produced correct inequalities but
 * was not reproducing the names the compiler emits.
 */
const derivedVolume = (
  deploymentName: string,
  namespace: string | undefined,
  mountId: string
): string =>
  createExclusiveReattachVolumeName(
    `${PLAN_ROOT}\0${resolveDeploymentLineage(deploymentName, namespace)}`,
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

  it("cannot be forged: no accepted deployment name reaches a dev lineage", () => {
    // The separation only holds if a production `up --deployment <x>` can never
    // produce the lineage a dev deployment produces. Proven against the real
    // normalizer rather than a hand-written regex: every spelling of the
    // namespaced form is REJECTED as a deployment name, so it can never be
    // supplied, and the ones that are accepted resolve to something different.
    const devLineage = resolveDeploymentLineage("default", DEV_DEPLOYMENT_LINEAGE_NAMESPACE);
    for (const attempt of ["dev default", `dev\0default`, "dev\u0000default", "dev/default"]) {
      expect(() => normalizeDeploymentName(attempt)).toThrow(/kebab-case/u);
    }
    for (const accepted of ["dev", "dev-default", "default", "devdefault"]) {
      expect(normalizeDeploymentName(accepted)).toBe(accepted);
      expect(resolveDeploymentLineage(accepted, undefined)).not.toBe(devLineage);
    }
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
