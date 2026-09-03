import { describe, expect, it, vi } from "vitest";
import { execFile as execFileCallback } from "node:child_process";
import { chmod, mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import type { CompileReport } from "../report/index.js";
import { createExclusiveReattachVolumeName } from "../shared/index.js";

import type { RuntimeTargetPlan } from "./containerArtifactsTypes.js";
import {
  resolveWorkspaceResourceVolumes,
  type WorkspaceResourcePersistentMount
} from "./containerTargetResources.js";
import { createDockerRunInvocation } from "./runProject.js";
import { removeDirectory } from "../filesystem/index.js";
import type { OrganizationReadinessEvidence } from "./organizationReadyEvidence.js";

const execFile = promisify(execFileCallback);

/**
 * The regression this file exists for.
 *
 * A workspace `kind: volume` and a durable Moltnet sqlite store used to get a
 * BRAND-NEW EMPTY docker volume on every redeploy: the volume name folded in a
 * freshly minted NOOPOLIS_RUN_ID, and `spawnfile run` mounted it with
 * `volume-nocopy`, which also starved the image's `.spawnfile-volume-init`
 * bootstrap preimage. A newsroom's whole message history was destroyed by a
 * routine `docker rm` + recreate.
 *
 * A unit test asserting that `prepare_volume_resource` was *called* passes
 * throughout that entire bug. Only the assertions below — write state, remove
 * the container, change the run id, recreate, read the SAME inode back —
 * catch it.
 */

const AUTHORIZED_UID = 2000;
const NON_DAIMON_UID = 1001;
const DEPLOYMENT_LINEAGE = "newsroom-production";

const readiness: OrganizationReadinessEvidence = {
  compileFingerprint: "sf1:000000000000",
  compileVersion: "0.1",
  hasExternalMoltnet: false,
  networks: [],
  organizationMembers: [],
  projectLabel: "newsroom",
  version: "spawnfile.organization-ready-evidence.v1",
  worldBindings: null
};

const createCompileReport = (
  mounts: Array<{ id: string; mount_path: string; reason: string; volume_name: string }>
): CompileReport => ({
  compile_fingerprint: "sf1:test123",
  diagnostics: [],
  generated_at: "2026-09-01T00:00:00.000Z",
  nodes: [],
  output_directory: "/tmp/spawnfile-durable-out",
  root: "/tmp/Spawnfile",
  spawnfile_version: "0.1",
  container: {
    dockerfile: "Dockerfile",
    entrypoint: "entrypoint.sh",
    env_example: ".env.example",
    internal_ports: [],
    model_secrets_required: [],
    persistent_mounts: mounts,
    port_mappings: [],
    ports: [],
    published_ports: [],
    runtime_homes: [],
    runtime_instances: [],
    runtime_secrets_required: [],
    runtimes_installed: [],
    secrets_required: []
  }
});

/** The real `spawnfile run` mount args for a set of durable mounts. */
const resolveRunMountArgs = async (
  mounts: Array<{ id: string; mount_path: string; reason: string; volume_name: string }>
): Promise<string[]> => {
  const invocation = await createDockerRunInvocation(
    {
      organizationReadinessEvidence: readiness,
      outputDirectory: "/tmp/spawnfile-durable-out",
      report: createCompileReport(mounts),
      reportPath: "/tmp/spawnfile-durable-out/spawnfile-report.json"
    },
    "spawnfile-durable-volume"
  );
  await removeDirectory(invocation.supportDirectory);
  const args: string[] = [];
  for (const [index, value] of invocation.args.entries()) {
    if (value === "--mount" && invocation.args[index + 1]?.startsWith("type=volume,")) {
      args.push("--mount", invocation.args[index + 1]!);
    }
  }
  return args;
};

const dockerVolumes: string[] = [];
const dockerContainers: string[] = [];
const dockerImages: string[] = [];

const cleanupDocker = async (): Promise<void> => {
  for (const container of dockerContainers.splice(0)) {
    await execFile("docker", ["rm", "--force", container]).catch(() => undefined);
  }
  for (const volume of dockerVolumes.splice(0)) {
    await execFile("docker", ["volume", "rm", "--force", volume]).catch(() => undefined);
  }
  for (const image of dockerImages.splice(0)) {
    await execFile("docker", ["image", "rm", "--force", image]).catch(() => undefined);
  }
};

interface DurableFixture {
  mounts: WorkspaceResourcePersistentMount[];
  storeMount: { id: string; lifecycle: "exclusive-reattach"; mount_path: string; reason: string; volume_name: string };
}

const STORE_MOUNT_PATH = "/var/lib/spawnfile/moltnet/networks/clank-newsroom";
const STORE_MOUNT_ID = "moltnet-clank-newsroom-store";
const RESOURCE_MOUNT_PATH =
  "/var/lib/spawnfile/resources/teams/team-newsroom/clank-edition-state";

/**
 * Resolves the durable mounts the compiler emits for this fixture, through the
 * compiler's own naming path. Called once per "compile"; the caller varies
 * NOOPOLIS_RUN_ID between calls and asserts the results are identical.
 */
const resolveDurableMounts = (plan: RuntimeTargetPlan): DurableFixture => ({
  mounts: resolveWorkspaceResourceVolumes([plan]).mounts,
  storeMount: {
    id: STORE_MOUNT_ID,
    lifecycle: "exclusive-reattach",
    mount_path: STORE_MOUNT_PATH,
    reason: "managed Moltnet sqlite store for clank-newsroom",
    // Exactly what moltnetArtifacts.ts derives for a store with an
    // author-declared `persistence.name`.
    volume_name: "clank-newsroom-store"
  }
});

const uniqueSuffix = (): string =>
  `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;

const namespaceVolume = (name: string, suffix: string): string => `${name}-${suffix}`;

/**
 * Rewrites the compiler-derived volume names into test-local ones so a run
 * never touches a developer's real volumes, while preserving the identity
 * relationships the assertions care about.
 */
const namespaceMounts = <T extends { volume_name: string }>(mounts: T[], suffix: string): T[] =>
  mounts.map((mount) => ({ ...mount, volume_name: namespaceVolume(mount.volume_name, suffix) }));

describe("durable volumes reattach across container replacement", () => {
  it("preserves Daimon organization state across a docker rm and a new run id", async () => {
    const suffix = uniqueSuffix();
    const tag = `spawnfile-durable-daimon-${suffix}`;
    const containerName = `${tag}-container`;
    const dockerDirectory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-durable-daimon-"));
    const instanceRoot = "/var/lib/spawnfile/instances/daimon/daimon-organization";
    const workspacePath = `${instanceRoot}/workspace`;
    const sentinelPath = `${RESOURCE_MOUNT_PATH}/.spawnfile-resource-identity`;
    const statePath = `${STORE_MOUNT_PATH}/moltnet.sqlite`;

    const plan: RuntimeTargetPlan = {
      configEnvBindings: [],
      envFiles: [],
      id: "daimon-organization",
      instancePaths: {
        configPath: `${instanceRoot}/daimon/config.json`,
        instanceRoot,
        workspacePath
      },
      meta: {
        configFileName: "daimon/config.json",
        instancePaths: { configPathTemplate: "", workspacePathTemplate: "" },
        standaloneBaseImage: "node:24-bookworm-slim",
        startCommand: ["bash", "/opt/spawnfile/durable-probe.sh"],
        systemDeps: ["bash", "util-linux"]
      },
      modelAuthMethods: {},
      modelSecretsRequired: [],
      packages: [],
      recipeEnv: {},
      resources: [{
        backingPath: RESOURCE_MOUNT_PATH,
        id: "edition-state",
        kind: "volume",
        linkPath: `${workspacePath}/edition`,
        mode: "mutable",
        mount: "./edition",
        name: "clank-edition-state",
        sharing: "team",
        canonicalBackingPath: RESOURCE_MOUNT_PATH,
        ownerId: RESOURCE_MOUNT_PATH,
        persistentMountId: "workspace-resource-edition",
        replacementSentinel: sentinelPath,
        resolvedIdentity: `sha256:${"b".repeat(64)}`,
        volumeName: "clank-edition-state"
      } as NonNullable<RuntimeTargetPlan["resources"]>[number]],
      runtimeName: "daimon",
      runtimeRoot: "/opt/spawnfile/runtime-installs/daimon",
      sourceIds: [],
      targetFiles: [
        { content: "{}\n", path: "daimon/config.json" },
        { content: "#!/usr/bin/env bash\nexit 0\n", mode: 0o755, path: "runtime/daimon-start.sh" }
      ]
    } as unknown as RuntimeTargetPlan;

    // "Compile" twice under two different run ids. An author-declared name is
    // returned verbatim and the derived name never mentions either run id, so
    // the two mount sets MUST be identical — that identity is what makes a
    // redeploy reattach the same host volumes instead of creating empty ones.
    const previousRunId = process.env.NOOPOLIS_RUN_ID;
    let firstCompile: DurableFixture;
    let secondCompile: DurableFixture;
    try {
      process.env.NOOPOLIS_RUN_ID = "run-one";
      firstCompile = resolveDurableMounts(plan);
      process.env.NOOPOLIS_RUN_ID = "run-two";
      secondCompile = resolveDurableMounts(plan);
    } finally {
      if (previousRunId === undefined) delete process.env.NOOPOLIS_RUN_ID;
      else process.env.NOOPOLIS_RUN_ID = previousRunId;
    }
    expect(secondCompile.mounts).toEqual(firstCompile.mounts);
    expect(secondCompile.storeMount).toEqual(firstCompile.storeMount);
    expect(firstCompile.mounts[0]?.volume_name).toBe("clank-edition-state");
    expect(firstCompile.mounts[0]?.lifecycle).toBe("exclusive-reattach");

    const allMounts = namespaceMounts(
      [...firstCompile.mounts, firstCompile.storeMount],
      suffix
    );
    const mountArgs = await resolveRunMountArgs(allMounts);
    // Test 2, in situ: the real invocation carries the exact mount shape and
    // no `volume-nocopy`, which is what lets Docker copy the image's bootstrap
    // preimage into a fresh volume.
    expect(mountArgs.join("\n")).not.toContain("volume-nocopy");
    for (const mount of allMounts) {
      expect(mountArgs).toContain(
        `type=volume,source=${mount.volume_name},target=${mount.mount_path}`
      );
      dockerVolumes.push(mount.volume_name);
    }

    try {
      vi.resetModules();
      vi.doMock("../runtime/index.js", () => ({
        createRuntimeInstallRecipe: vi.fn(async () => ({
          baseImage: "node:24-bookworm-slim",
          commands: [],
          copyCommands: [],
          runtimeName: "daimon",
          runtimeRoot: "/opt/spawnfile/runtime-installs/daimon"
        }))
      }));
      const { createRootfsFiles, renderDockerfile, renderEntrypoint } =
        await import("./containerArtifactsRender.js");
      const mountPaths = allMounts.map((mount) => mount.mount_path);
      const dockerfile = await renderDockerfile([plan], { persistentMountPaths: mountPaths });
      const rootfsFiles = createRootfsFiles([plan], mountPaths, undefined, allMounts);
      await writeFile(
        path.join(dockerDirectory, "entrypoint.sh"),
        renderEntrypoint([plan], [], { persistentMounts: allMounts, persistentMountPaths: mountPaths }),
        { encoding: "utf8", mode: 0o755 }
      );
      const uidEntrypoint = rootfsFiles.find((file) =>
        file.path.endsWith("daimon-uid-entrypoint.sh"))?.content ?? "";
      expect(uidEntrypoint).toContain("require_backed_mount");
      for (const mount of allMounts) {
        expect(uidEntrypoint).toContain(
          `require_backed_mount '${mount.id}' '${mount.mount_path}' '${mount.volume_name}'`
        );
      }

      for (const file of rootfsFiles) {
        const outputPath = path.join(dockerDirectory, file.path);
        await mkdir(path.dirname(outputPath), { recursive: true });
        await writeFile(outputPath, file.content, { encoding: "utf8", mode: file.mode });
      }
      const runtimeBinDirectory = path.join(
        dockerDirectory,
        "container/rootfs/opt/spawnfile/runtime-installs/daimon/bin"
      );
      await chmod(path.join(runtimeBinDirectory, "..", "daimon-start.sh"), 0o755);
      await mkdir(runtimeBinDirectory, { recursive: true });
      await symlink("../daimon-start.sh", path.join(runtimeBinDirectory, "daimon-runtime"));
      await writeFile(path.join(dockerDirectory, ".env.example"), "", "utf8");

      // Writes durable state on the first start, then proves the SAME bytes
      // and the SAME inode came back on every later start.
      await writeFile(path.join(dockerDirectory, "durable-probe.sh"), [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        `if [ ! -e '${statePath}' ]; then printf 'story-pitch\\n' > '${statePath}'; fi`,
        `printf 'state=%s inode=%s owner=%s marker=%s sentinel=%s\\n' \\`,
        `  "$(cat '${statePath}')" "$(stat -c %i '${statePath}')" \\`,
        `  "$(stat -c '%u:%g' '${STORE_MOUNT_PATH}')" \\`,
        `  "$(test -e '${RESOURCE_MOUNT_PATH}/.spawnfile-volume-init' && printf present || printf absent)" \\`,
        `  "$(stat -c '%u:%g' '${RESOURCE_MOUNT_PATH}')"`,
        ""
      ].join("\n"), { encoding: "utf8", mode: 0o755 });

      await writeFile(path.join(dockerDirectory, "Dockerfile"), [
        dockerfile,
        "COPY --chmod=755 durable-probe.sh /opt/spawnfile/durable-probe.sh",
        "RUN chmod 775 /var /var/lib"
      ].join("\n") + "\n", "utf8");

      await execFile("docker", ["build", "--pull=false", "--tag", tag, "."], {
        cwd: dockerDirectory,
        timeout: 180_000
      });
      dockerImages.push(tag);

      const daimonRunArgs = [
        "--cap-drop=ALL", "--cap-add=CHOWN", "--cap-add=SETUID", "--cap-add=SETGID",
        "--cap-add=DAC_READ_SEARCH", "--cap-add=SETPCAP", "--cap-add=KILL",
        "--security-opt=no-new-privileges:true"
      ];

      // First deployment: fresh, empty volumes. Nothing is pre-created and
      // nothing is chowned by hand — copy-up delivers the image's bootstrap
      // preimage and the ownership guard takes it from there.
      dockerContainers.push(containerName);
      await execFile("docker", [
        "create", "--name", containerName, ...daimonRunArgs, ...mountArgs, tag
      ]);
      const first = await execFile("docker", ["start", "-a", containerName], { timeout: 120_000 });
      const firstState = /state=(\S+) inode=(\d+) owner=(\S+) marker=(\S+) sentinel=(\S+)/u
        .exec(first.stdout);
      expect(firstState, first.stdout + first.stderr).not.toBeNull();
      expect(firstState![1]).toBe("story-pitch");
      expect(firstState![3]).toBe(`${AUTHORIZED_UID}:${AUTHORIZED_UID}`);
      expect(firstState![4]).toBe("absent");
      expect(firstState![5]).toBe(`${AUTHORIZED_UID}:${AUTHORIZED_UID}`);

      // The routine operation that destroyed the newsroom.
      await execFile("docker", ["rm", "--force", containerName]);

      // A new run id must not change a single mount argument.
      const rerunPrevious = process.env.NOOPOLIS_RUN_ID;
      process.env.NOOPOLIS_RUN_ID = "run-three";
      let rerunMountArgs: string[];
      try {
        rerunMountArgs = await resolveRunMountArgs(
          namespaceMounts([...resolveDurableMounts(plan).mounts, resolveDurableMounts(plan).storeMount], suffix)
        );
      } finally {
        if (rerunPrevious === undefined) delete process.env.NOOPOLIS_RUN_ID;
        else process.env.NOOPOLIS_RUN_ID = rerunPrevious;
      }
      expect(rerunMountArgs).toEqual(mountArgs);

      await execFile("docker", [
        "create", "--name", containerName, ...daimonRunArgs, ...rerunMountArgs, tag
      ]);
      const second = await execFile("docker", ["start", "-a", containerName], { timeout: 120_000 });
      const secondState = /state=(\S+) inode=(\d+) owner=(\S+) marker=(\S+) sentinel=(\S+)/u
        .exec(second.stdout);
      expect(secondState, second.stdout + second.stderr).not.toBeNull();
      expect(secondState![1]).toBe("story-pitch");
      expect(secondState![2]).toBe(firstState![2]);
      expect(secondState![3]).toBe(`${AUTHORIZED_UID}:${AUTHORIZED_UID}`);
      expect(secondState![4]).toBe("absent");

      // Fail closed: the same image, hand-launched with no volumes at all.
      await expect(execFile("docker", ["run", "--rm", ...daimonRunArgs, tag], { timeout: 60_000 }))
        .rejects.toThrow(/is not backed by a volume/u);

      // And the deliberate opt-out still starts.
      const ephemeral = await execFile("docker", [
        "run", "--rm", ...daimonRunArgs,
        "--env", "SPAWNFILE_ALLOW_EPHEMERAL_STATE=1", tag
      ], { timeout: 120_000 });
      expect(ephemeral.stdout).toContain("state=story-pitch");
    } finally {
      vi.doUnmock("../runtime/index.js");
      vi.resetModules();
      await cleanupDocker();
      await removeDirectory(dockerDirectory);
    }
  }, 600_000);

  it("preserves non-Daimon state across a docker rm and a new run id at uid 1001", async () => {
    const suffix = uniqueSuffix();
    const tag = `spawnfile-durable-openclaw-${suffix}`;
    const containerName = `${tag}-container`;
    const dockerDirectory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-durable-openclaw-"));
    const workspacePath = "/var/lib/spawnfile/instances/openclaw/agent-reporter/home/.openclaw/workspace";
    const backingPath = "/var/lib/spawnfile/resources/teams/team-newsroom/clank-edition-state";
    const statePath = `${backingPath}/edition.txt`;

    const plan: RuntimeTargetPlan = {
      configEnvBindings: [],
      envFiles: [],
      id: "openclaw-reporter",
      instancePaths: {
        configPath: "/var/lib/spawnfile/instances/openclaw/agent-reporter/config.json",
        workspacePath
      },
      meta: {
        configFileName: "config.json",
        instancePaths: { configPathTemplate: "", workspacePathTemplate: "" },
        standaloneBaseImage: "node:24-bookworm-slim",
        startCommand: ["bash", "/opt/spawnfile/durable-probe.sh"],
        systemDeps: ["bash"]
      },
      modelAuthMethods: {},
      modelSecretsRequired: [],
      packages: [],
      recipeEnv: {},
      resources: [{
        backingPath,
        id: "edition-state",
        kind: "volume",
        linkPath: `${workspacePath}/edition`,
        mode: "mutable",
        mount: "./edition",
        name: "clank-edition-state",
        sharing: "team",
        canonicalBackingPath: backingPath,
        ownerId: backingPath,
        persistentMountId: "workspace-resource-edition",
        replacementSentinel: `${backingPath}/.spawnfile-resource-identity`,
        resolvedIdentity: `sha256:${"c".repeat(64)}`,
        volumeName: "clank-edition-state"
      } as NonNullable<RuntimeTargetPlan["resources"]>[number]],
      runtimeName: "openclaw",
      runtimeRoot: "/opt/spawnfile/runtime-installs/openclaw",
      sourceIds: [],
      targetFiles: [{ content: "{}\n", path: "config.json" }]
    } as unknown as RuntimeTargetPlan;

    const mounts = namespaceMounts(resolveWorkspaceResourceVolumes([plan]).mounts, suffix);
    expect(mounts).toHaveLength(1);
    for (const mount of mounts) dockerVolumes.push(mount.volume_name);
    const mountArgs = await resolveRunMountArgs(mounts);
    expect(mountArgs.join("\n")).not.toContain("volume-nocopy");

    try {
      vi.resetModules();
      vi.doMock("../runtime/index.js", () => ({
        createRuntimeInstallRecipe: vi.fn(async () => ({
          baseImage: "node:24-bookworm-slim",
          commands: [],
          copyCommands: [],
          runtimeName: "openclaw",
          runtimeRoot: "/opt/spawnfile/runtime-installs/openclaw"
        }))
      }));
      const { createRootfsFiles, renderDockerfile, renderEntrypoint } =
        await import("./containerArtifactsRender.js");
      const mountPaths = mounts.map((mount) => mount.mount_path);
      const dockerfile = await renderDockerfile([plan], { persistentMountPaths: mountPaths });
      const rootfsFiles = createRootfsFiles([plan], mountPaths, undefined, mounts);
      await writeFile(
        path.join(dockerDirectory, "entrypoint.sh"),
        renderEntrypoint([plan], [], { persistentMounts: mounts, persistentMountPaths: mountPaths }),
        { encoding: "utf8", mode: 0o755 }
      );
      for (const file of rootfsFiles) {
        const outputPath = path.join(dockerDirectory, file.path);
        await mkdir(path.dirname(outputPath), { recursive: true });
        await writeFile(outputPath, file.content, { encoding: "utf8", mode: file.mode });
      }
      await writeFile(path.join(dockerDirectory, ".env.example"), "", "utf8");
      await writeFile(path.join(dockerDirectory, "durable-probe.sh"), [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        `if [ ! -e '${statePath}' ]; then printf 'edition-one\\n' > '${statePath}'; fi`,
        `printf 'state=%s inode=%s owner=%s marker=%s\\n' \\`,
        `  "$(cat '${statePath}')" "$(stat -c %i '${statePath}')" \\`,
        `  "$(stat -c '%u:%g' '${backingPath}')" \\`,
        `  "$(test -e '${backingPath}/.spawnfile-volume-init' && printf present || printf absent)"`,
        ""
      ].join("\n"), { encoding: "utf8", mode: 0o755 });
      await writeFile(path.join(dockerDirectory, "Dockerfile"), [
        dockerfile,
        "COPY --chmod=755 durable-probe.sh /opt/spawnfile/durable-probe.sh"
      ].join("\n") + "\n", "utf8");

      await execFile("docker", ["build", "--pull=false", "--tag", tag, "."], {
        cwd: dockerDirectory,
        timeout: 180_000
      });
      dockerImages.push(tag);

      dockerContainers.push(containerName);
      await execFile("docker", ["create", "--name", containerName, ...mountArgs, tag]);
      const first = await execFile("docker", ["start", "-a", containerName], { timeout: 120_000 });
      const firstState = /state=(\S+) inode=(\d+) owner=(\S+) marker=(\S+)/u.exec(first.stdout);
      expect(firstState, first.stdout + first.stderr).not.toBeNull();
      expect(firstState![1]).toBe("edition-one");
      // `prepare_volume_resource` authenticates the marker as
      // `volume_bootstrap_uid`:`volume_bootstrap_gid` 1001:1001 for a
      // non-Daimon runtime, then removes it.
      expect(firstState![3]).toBe(`${NON_DAIMON_UID}:${NON_DAIMON_UID}`);
      expect(firstState![4]).toBe("absent");

      await execFile("docker", ["rm", "--force", containerName]);
      await execFile("docker", ["create", "--name", containerName, ...mountArgs, tag]);
      const second = await execFile("docker", ["start", "-a", containerName], { timeout: 120_000 });
      const secondState = /state=(\S+) inode=(\d+) owner=(\S+) marker=(\S+)/u.exec(second.stdout);
      expect(secondState, second.stdout + second.stderr).not.toBeNull();
      expect(secondState![1]).toBe("edition-one");
      expect(secondState![2]).toBe(firstState![2]);
      expect(secondState![4]).toBe("absent");

      await expect(execFile("docker", ["run", "--rm", tag], { timeout: 60_000 }))
        .rejects.toThrow(/is not backed by a volume/u);
      const ephemeral = await execFile("docker", [
        "run", "--rm", "--env", "SPAWNFILE_ALLOW_EPHEMERAL_STATE=1", tag
      ], { timeout: 120_000 });
      expect(ephemeral.stdout).toContain("state=edition-one");
    } finally {
      vi.doUnmock("../runtime/index.js");
      vi.resetModules();
      await cleanupDocker();
      await removeDirectory(dockerDirectory);
    }
  }, 600_000);
});

describe("exclusive-reattach volume naming", () => {
  it("derives one host-stable name per mount id and deployment lineage", () => {
    const lineage = `/tmp/Spawnfile ${DEPLOYMENT_LINEAGE}`;
    expect(createExclusiveReattachVolumeName(lineage, "workspace-resource-abc"))
      .toBe(createExclusiveReattachVolumeName(lineage, "workspace-resource-abc"));
    expect(createExclusiveReattachVolumeName(lineage, "workspace-resource-abc"))
      .not.toBe(createExclusiveReattachVolumeName(`/tmp/Spawnfile staging`, "workspace-resource-abc"));
  });
});
