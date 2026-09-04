import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { removeDirectory } from "../filesystem/index.js";
import type { ContainerPersistentMountReport } from "../report/index.js";

/**
 * These are CALL-SITE tests.
 *
 * `resolveDeploymentLineage` and `assertNoDeclaredVolumeNames` are unit-tested
 * in deploymentLineage.test.ts, but deleting BOTH of their calls from
 * upProject.ts left the whole suite green — correct code that nothing proved
 * was reached. That is exactly how the shared-lineage bug survived in the
 * first place (a helper can be right and simply unused), so the wiring gets
 * its own mutation-locked coverage here.
 *
 * `buildProject` is stubbed so the assertions land on what upProject HANDS it
 * and on what upProject does with the report it gets back, with no compile,
 * no docker build, and no container.
 */

const BUILD_SENTINEL = "up-project-lineage-test-sentinel";

interface RecordedBuild {
  deploymentLineage?: string;
}

const recordedBuilds: RecordedBuild[] = [];
let buildOutcome: { kind: "throw" } | { kind: "report"; mounts: ContainerPersistentMountReport[] } =
  { kind: "throw" };

vi.mock("./buildProject.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./buildProject.js")>();
  return {
    ...actual,
    buildProject: vi.fn(async (_inputPath: string, options: RecordedBuild = {}) => {
      recordedBuilds.push({ deploymentLineage: options.deploymentLineage });
      if (buildOutcome.kind === "throw") throw new Error(BUILD_SENTINEL);
      return {
        imageTag: "spawnfile-lineage-test",
        outputDirectory: "/tmp/spawnfile-lineage-test",
        report: {
          container: { persistent_mounts: buildOutcome.mounts },
          root: "/tmp/Spawnfile"
        },
        reportPath: "/tmp/spawnfile-lineage-test/spawnfile-report.json"
      };
    })
  };
});

const { upProject } = await import("./upProject.js");
const { DEV_DEPLOYMENT_LINEAGE_NAMESPACE, resolveDeploymentLineage } =
  await import("./deploymentLineage.js");

const declaredMount = (id: string, declared?: string): ContainerPersistentMountReport => ({
  ...(declared ? { declared_volume_name: declared } : {}),
  id,
  lifecycle: "exclusive-reattach",
  mount_path: `/var/lib/spawnfile/${id}`,
  reason: id,
  volume_name: declared ?? `spawnfile-exclusive-${id}`
});

const temporaryDirectories: string[] = [];

const outputDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-up-lineage-"));
  temporaryDirectories.push(directory);
  return directory;
};

beforeEach(() => {
  recordedBuilds.length = 0;
  buildOutcome = { kind: "throw" };
});

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(removeDirectory));
});

describe("upProject deployment lineage wiring", () => {
  it("folds the lineage namespace into the lineage it hands the build", async () => {
    // Mutation lock: delete the resolveDeploymentLineage() call in upProject
    // and this drops to the bare deployment name.
    await expect(upProject("/tmp/does-not-matter", {
      deploymentLineageNamespace: DEV_DEPLOYMENT_LINEAGE_NAMESPACE,
      detach: true,
      outputDirectory: await outputDirectory()
    })).rejects.toThrow(BUILD_SENTINEL);

    expect(recordedBuilds).toHaveLength(1);
    expect(recordedBuilds[0]?.deploymentLineage)
      .toBe(resolveDeploymentLineage("default", DEV_DEPLOYMENT_LINEAGE_NAMESPACE));
    expect(recordedBuilds[0]?.deploymentLineage).not.toBe("default");
  });

  it("namespaces an explicit --deployment name too, not just the default", async () => {
    await expect(upProject("/tmp/does-not-matter", {
      deploymentLineageNamespace: DEV_DEPLOYMENT_LINEAGE_NAMESPACE,
      deploymentName: "blue",
      detach: true,
      outputDirectory: await outputDirectory()
    })).rejects.toThrow(BUILD_SENTINEL);

    expect(recordedBuilds[0]?.deploymentLineage)
      .toBe(resolveDeploymentLineage("blue", DEV_DEPLOYMENT_LINEAGE_NAMESPACE));
    expect(recordedBuilds[0]?.deploymentLineage).not.toBe("blue");
  });

  it("hands a production deployment the bare deployment name", async () => {
    await expect(upProject("/tmp/does-not-matter", {
      deploymentName: "blue",
      detach: true,
      outputDirectory: await outputDirectory()
    })).rejects.toThrow(BUILD_SENTINEL);

    expect(recordedBuilds[0]?.deploymentLineage).toBe("blue");
  });
});

describe("upProject declared-volume refusal wiring", () => {
  it("refuses a namespaced deployment whose compile declares a volume name", async () => {
    // Mutation lock: delete the assertNoDeclaredVolumeNames() call in
    // upProject and this proceeds into the docker path instead of refusing.
    buildOutcome = {
      kind: "report",
      mounts: [
        declaredMount("moltnet-newsroom-store", "clank-newsroom-store"),
        declaredMount("moltnet-newsroom-causal")
      ]
    };

    await expect(upProject("/tmp/does-not-matter", {
      deploymentLineageNamespace: DEV_DEPLOYMENT_LINEAGE_NAMESPACE,
      detach: true,
      outputDirectory: await outputDirectory()
    })).rejects.toThrow(/clank-newsroom-store/u);
  });

  it("does not refuse when the operator passes the explicit override", async () => {
    buildOutcome = {
      kind: "report",
      mounts: [declaredMount("moltnet-newsroom-store", "clank-newsroom-store")]
    };

    // It still fails further down (there is no real image), but never on the
    // declared-volume refusal.
    await expect(upProject("/tmp/does-not-matter", {
      allowDeclaredVolumeNames: true,
      deploymentLineageNamespace: DEV_DEPLOYMENT_LINEAGE_NAMESPACE,
      detach: true,
      outputDirectory: await outputDirectory()
    })).rejects.not.toThrow(/author-declared/u);
  });

  it("does not refuse a production deployment, which owns those volumes", async () => {
    buildOutcome = {
      kind: "report",
      mounts: [declaredMount("moltnet-newsroom-store", "clank-newsroom-store")]
    };

    await expect(upProject("/tmp/does-not-matter", {
      detach: true,
      outputDirectory: await outputDirectory()
    })).rejects.not.toThrow(/author-declared/u);
  });
});
