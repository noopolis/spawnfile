import path from "node:path";
import os from "node:os";
import { mkdtemp } from "node:fs/promises";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ensureDirectory, removeDirectory, readUtf8File, writeUtf8File } from "../filesystem/index.js";
import type { ContainerPersistentMountReport } from "../report/index.js";

import { createFakeMoltnetCli } from "../../fixtures/support/fakeMoltnetCli.js";

import { compileProject } from "./compileProject.js";
import {
  DEV_DEPLOYMENT_LINEAGE_NAMESPACE,
  resolveDeploymentLineage
} from "./deploymentLineage.js";

vi.mock("./moltnetBinaries.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./moltnetBinaries.js")>();
  const { stageTrustedTestMoltnetRelease } = await import(
    "../../fixtures/support/trustedMoltnetRelease.js"
  );
  return {
    ...actual,
    stageMoltnetBinaries: (outputDirectory: string, options: Parameters<
      typeof actual.stageMoltnetBinaries
    >[1]) => stageTrustedTestMoltnetRelease(outputDirectory, options)
  };
});

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(temporaryDirectories.splice(0).map(removeDirectory));
});

/**
 * One project that declares all three durable shapes at once:
 *   - a team `kind: volume` resource WITH an author-declared `name`
 *   - a team `kind: volume` resource WITHOUT one
 *   - a managed Moltnet sqlite store with `persistence.name`
 *
 * Every one of these previously got a brand-new empty docker volume on each
 * `spawnfile run`, because the volume name folded in a freshly minted
 * NOOPOLIS_RUN_ID — and, for the author-named ones, discarded the declared
 * name entirely. This fixture is the regression lock.
 */
const createProject = async (): Promise<string> => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-durable-volume-"));
  temporaryDirectories.push(directory);

  await writeUtf8File(path.join(directory, "TEAM.md"), "# Newsroom\n");
  await writeUtf8File(path.join(directory, "Spawnfile"), [
    'spawnfile_version: "0.1"',
    "kind: team",
    "name: newsroom",
    "shared:",
    "  workspace:",
    "    docs:",
    "      system: TEAM.md",
    "    resources:",
    "      - id: edition-state",
    "        kind: volume",
    "        name: clank-edition-state",
    "        mount: ./edition",
    "        mode: mutable",
    "        sharing: team",
    "      - id: scratch",
    "        kind: volume",
    "        mount: ./scratch",
    "        mode: mutable",
    "        sharing: team",
    "members:",
    "  - id: reporter",
    "    ref: ./agents/reporter",
    "mode: swarm",
    "networks:",
    "  - id: newsroom",
    "    name: Newsroom",
    "    provider: moltnet",
    "    server:",
    "      mode: managed",
    "      listen:",
    "        bind: 0.0.0.0",
    "        port: 8787",
    "      store:",
    "        kind: sqlite",
    "        persistence:",
    "          mode: durable",
    "          name: clank-newsroom-store",
    "      auth:",
    "        mode: none",
    "      human_ingress: true",
    "    rooms:",
    "      - id: floor",
    "        members: [reporter]",
    ""
  ].join("\n"));

  const agentDirectory = path.join(directory, "agents", "reporter");
  await ensureDirectory(agentDirectory);
  await writeUtf8File(path.join(agentDirectory, "AGENTS.md"), "# Reporter\n");
  await writeUtf8File(path.join(agentDirectory, "Spawnfile"), [
    'spawnfile_version: "0.1"',
    "kind: agent",
    "name: reporter",
    "runtime:",
    "  name: pi",
    "  options:",
    "    engine: grok",
    "execution:",
    "  model:",
    "    primary:",
    "      provider: local",
    "      name: grok-cli",
    "      auth:",
    "        method: none",
    "      endpoint:",
    "        compatibility: openai",
    "        base_url: http://127.0.0.1:11434/v1",
    "  sandbox:",
    "    mode: workspace",
    "surfaces:",
    "  moltnet:",
    "    - network: newsroom",
    "      rooms:",
    "        floor:",
    "          wake: mentions",
    "workspace:",
    "  docs:",
    "    system: AGENTS.md",
    ""
  ].join("\n"));

  return directory;
};

interface CompiledDurableState {
  distributionMounts: Array<{ declared_volume_name?: string; id: string }>;
  mounts: ContainerPersistentMountReport[];
  resourceVolumeNames: Record<string, string | null | undefined>;
}

const compileUnderRunId = async (
  projectDirectory: string,
  runId: string,
  deploymentLineage = "newsroom-production"
): Promise<CompiledDurableState> => {
  const outputDirectory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-durable-volume-out-"));
  temporaryDirectories.push(outputDirectory);
  // These tests deliberately drive the real `compileProject`, which shells
  // out to the Moltnet CLI while injecting workspace files. Resolving it
  // from PATH would make them pass only on a machine with Moltnet installed;
  // point the documented escape hatch at a stand-in so the real compile path
  // stays under test everywhere.
  vi.stubEnv("SPAWNFILE_MOLTNET_CLI", await createFakeMoltnetCli((directory) => {
    temporaryDirectories.push(directory);
  }));
  const previous = process.env.NOOPOLIS_RUN_ID;
  process.env.NOOPOLIS_RUN_ID = runId;
  try {
    const result = await compileProject(projectDirectory, {
      deploymentLineage,
      outputDirectory
    });
    const distribution = JSON.parse(
      await readUtf8File(path.join(outputDirectory, "distribution-report.json"))
    ) as { persistent_mounts: Array<{ declared_volume_name?: string; id: string }> };
    return {
      distributionMounts: distribution.persistent_mounts,
      mounts: result.report.container?.persistent_mounts ?? [],
      resourceVolumeNames: Object.fromEntries(
        (result.report.container?.workspace_resources ?? []).map(
          (resource) => [resource.id, resource.volume_name]
        )
      )
    };
  } finally {
    if (previous === undefined) delete process.env.NOOPOLIS_RUN_ID;
    else process.env.NOOPOLIS_RUN_ID = previous;
  }
};

const mountById = (
  state: CompiledDurableState,
  predicate: (mount: ContainerPersistentMountReport) => boolean
): ContainerPersistentMountReport => {
  const found = state.mounts.find(predicate);
  expect(found).toBeDefined();
  return found!;
};

describe("durable volumes survive a redeploy", () => {
  it("keeps every durable volume name identical across two different run ids", async () => {
    const projectDirectory = await createProject();

    const first = await compileUnderRunId(projectDirectory, "run-alpha");
    const second = await compileUnderRunId(projectDirectory, "run-beta");

    // The author-declared names, verbatim. A live deployment reattaches
    // hand-created volumes under exactly these names; any change here strands
    // real paid-for state.
    expect(first.resourceVolumeNames["edition-state"]).toBe("clank-edition-state");
    expect(second.resourceVolumeNames["edition-state"]).toBe("clank-edition-state");
    const store = mountById(first, (mount) => mount.id === "moltnet-newsroom-store");
    expect(store.volume_name).toBe("clank-newsroom-store");
    expect(mountById(second, (mount) => mount.id === "moltnet-newsroom-store").volume_name)
      .toBe("clank-newsroom-store");

    // The derived name for an unnamed volume is equally stable, and carries no
    // trace of either run id.
    const scratch = first.resourceVolumeNames["scratch"];
    expect(scratch).toBeTruthy();
    expect(second.resourceVolumeNames["scratch"]).toBe(scratch);
    expect(scratch).not.toContain("run-alpha");
    expect(scratch).not.toContain("run-beta");

    // The published image must carry the declared names too: image mode has no
    // access to the creator's plan root, so without this an operator who
    // pre-created `clank-newsroom-store` and deployed the image would silently
    // get an empty volume.
    const declared = Object.fromEntries(first.distributionMounts.map(
      (mount) => [mount.id, mount.declared_volume_name]
    ));
    expect(declared["moltnet-newsroom-store"]).toBe("clank-newsroom-store");
    expect(Object.values(declared)).toContain("clank-edition-state");
    // A DERIVED name never travels: it encodes the creator's plan root.
    expect(first.distributionMounts.find((mount) => mount.id === "moltnet-newsroom-causal")
      ?.declared_volume_name).toBeUndefined();
    expect(second.distributionMounts).toEqual(first.distributionMounts);

    // Every durable mount, not just the three named above.
    const durable = (state: CompiledDurableState): Array<[string, string]> => state.mounts
      .filter((mount) => mount.lifecycle === "exclusive-reattach")
      .map((mount) => [mount.id, mount.volume_name] as [string, string])
      .sort(([left], [right]) => left.localeCompare(right));
    expect(durable(first).length).toBeGreaterThanOrEqual(3);
    expect(durable(second)).toEqual(durable(first));
  }, 120_000);

  it("marks the store and both workspace volumes exclusive-reattach", async () => {
    const projectDirectory = await createProject();
    const state = await compileUnderRunId(projectDirectory, "run-gamma");

    expect(mountById(state, (mount) => mount.id === "moltnet-newsroom-store").lifecycle)
      .toBe("exclusive-reattach");
    const workspaceMounts = state.mounts.filter((mount) => mount.id.startsWith("workspace-resource-"));
    expect(workspaceMounts).toHaveLength(2);
    for (const mount of workspaceMounts) {
      expect(mount.lifecycle).toBe("exclusive-reattach");
    }
    expect(new Set(workspaceMounts.map((mount) => mount.volume_name)))
      .toContain("clank-edition-state");

    // The causal event log stays deliberately run-scoped: specs/CAUSAL.md
    // stamps every event with the run id, so its log is a per-run artifact and
    // must not be reattached across runs.
    const causal = mountById(state, (mount) => mount.id === "moltnet-newsroom-causal");
    expect(causal.lifecycle).toBeUndefined();
    expect(causal.volume_name).toContain("run-gamma");
  }, 120_000);
});

describe("a dev deployment never shares a production deployment's volumes", () => {
  // `spawnfile dev up` delegated straight to `spawnfile up` with no
  // distinguishing identity, so both compiled under the lineage `default` and
  // derived the SAME host volumes. A dev deployment started while production
  // was stopped attached production's volumes and wrote into live state —
  // corruption, where the rest of this branch fixed loss.
  it("derives different volumes for the dev and production lineages of one project", async () => {
    const projectDirectory = await createProject();
    const production = await compileUnderRunId(projectDirectory, "run-alpha", "default");
    const dev = await compileUnderRunId(
      projectDirectory,
      "run-alpha",
      resolveDeploymentLineage("default", DEV_DEPLOYMENT_LINEAGE_NAMESPACE)
    );

    const derived = (state: CompiledDurableState): string[] => state.mounts
      .filter((mount) => mount.lifecycle === "exclusive-reattach" && !mount.declared_volume_name)
      .map((mount) => mount.volume_name)
      .sort();
    expect(derived(production).length).toBeGreaterThan(0);
    for (const volume of derived(dev)) {
      expect(derived(production)).not.toContain(volume);
    }

    // An author-declared name deliberately carries no lineage, so dev WOULD
    // attach production's volume by that exact name. That is why `dev up`
    // refuses these outright unless --allow-declared-volumes is passed.
    const declared = (state: CompiledDurableState): string[] => state.mounts
      .flatMap((mount) => mount.declared_volume_name ? [mount.declared_volume_name] : [])
      .sort();
    expect(declared(dev)).toEqual(declared(production));
    expect(declared(production)).toContain("clank-newsroom-store");
  }, 120_000);
});
