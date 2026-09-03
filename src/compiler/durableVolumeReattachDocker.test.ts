import { describe, expect, it, vi } from "vitest";
import { execFile as execFileCallback } from "node:child_process";
import { chmod, mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import type { CompileReport } from "../report/index.js";
import { createExclusiveReattachVolumeName } from "../shared/index.js";

import type { RuntimeTargetPlan } from "./containerArtifactsTypes.js";
import { escapeMountInfoPath } from "./containerBackedMountRender.js";
import { generateMoltnetArtifacts } from "./moltnetArtifacts.js";
import type { CompilePlan } from "./types.js";
import {
  resolveTargetResources,
  resolveWorkspaceResourceVolumes,
  type WorkspaceResourcePersistentMount
} from "./containerTargetResources.js";
import type { ResolvedAgentNode } from "./types.js";
import type { ContainerTarget, ContainerTargetInput, RuntimeContainerMeta } from "../runtime/index.js";
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

const STORE_MOUNT_ID = "moltnet-clank-newsroom-store";

const PLAN_ROOT = "/tmp/newsroom/Spawnfile";

/**
 * The declared team volume, exactly as an author writes it: an explicit `name`
 * an operator can pre-create on the host.
 */
const declaredVolumeResource = (declaredName: string) => ({
  id: "edition-state",
  kind: "volume" as const,
  mode: "mutable" as const,
  mount: "./edition",
  name: declaredName,
  scope: { kind: "team" as const, key: PLAN_ROOT, name: "newsroom" },
  sharing: "team" as const
});

const createTargetInput = (
  slug: string,
  runtimeName: string,
  declaredName: string
): ContainerTargetInput => ({
  emittedFiles: [],
  id: `agent:${slug}`,
  kind: "agent",
  slug,
  value: {
    description: "", docs: [], env: {}, execution: undefined, kind: "agent",
    mcpServers: [], name: slug, policyMode: null, policyOnDegrade: null,
    runtime: { name: runtimeName, options: {} }, secrets: [], skills: [],
    source: `${PLAN_ROOT}/agents/${slug}`, subagents: [],
    workspaceResources: [declaredVolumeResource(declaredName)]
  } as unknown as ResolvedAgentNode
});

/**
 * Runs the compiler's REAL workspace-resource derivation — the code path that
 * produced run-scoped names and discarded author-declared ones — and returns
 * both the resolved resource plans and the durable mounts they imply.
 *
 * Callers vary NOOPOLIS_RUN_ID around this call. Nothing here may depend on it.
 */
const resolveDurableResources = (
  slug: string,
  runtimeName: string,
  declaredName: string,
  instancePaths: RuntimeTargetPlan["instancePaths"],
  meta: RuntimeContainerMeta
): NonNullable<RuntimeTargetPlan["resources"]> => {
  const input = createTargetInput(slug, runtimeName, declaredName);
  const target: ContainerTarget = { files: [], id: `${runtimeName}-target`, sourceIds: [input.id] };
  return resolveTargetResources(target, [input], instancePaths, meta, PLAN_ROOT, DEPLOYMENT_LINEAGE);
};

/**
 * A team declaring one managed Moltnet network whose durable sqlite store
 * carries an author-declared `persistence.name`. Fed to the REAL
 * `generateMoltnetArtifacts` so the store mount below is derived, not asserted
 * against a literal — the same gap that made the resource side of this test
 * survive a naming mutation.
 */
const moltnetPlan = (): CompilePlan => ({
  edges: [],
  nodes: [{
    id: "team-newsroom",
    kind: "team",
    runtimeName: null,
    slug: "newsroom",
    value: {
      description: "", docs: [], external: [], kind: "team", lead: "reporter",
      members: [{ id: "reporter", kind: "agent", nodeSource: `${PLAN_ROOT}/agents/reporter`, runtimeName: "daimon" }],
      mode: "swarm", name: "newsroom",
      networks: [{
        expose: false, id: "clank-newsroom", name: "Clank Newsroom", provider: "moltnet",
        rooms: [{ id: "floor", members: ["reporter"] }],
        server: {
          auth: { mode: "none" as const },
          listen: { bind: "127.0.0.1", port: 8787 },
          mode: "managed" as const,
          store: {
            kind: "sqlite" as const,
            persistence: { mode: "durable" as const, name: "clank-newsroom-store" }
          }
        }
      }],
      policyMode: null, policyOnDegrade: null,
      shared: { env: {}, mcpServers: [], secrets: [], skills: [] },
      source: `${PLAN_ROOT}`
    }
  }],
  root: PLAN_ROOT,
  runtimes: { daimon: { nodeIds: [] } }
} as unknown as CompilePlan);

const resolveStoreMount = async (): Promise<DurableFixture["storeMount"]> => {
  const artifacts = await generateMoltnetArtifacts(moltnetPlan(), DEPLOYMENT_LINEAGE);
  const store = artifacts?.persistentMounts.find((mount) => mount.id === STORE_MOUNT_ID);
  expect(store, `no ${STORE_MOUNT_ID} mount in ${JSON.stringify(artifacts?.persistentMounts)}`)
    .toBeDefined();
  return {
    id: store!.id,
    lifecycle: store!.lifecycle!,
    mount_path: store!.mountPath,
    reason: store!.reason,
    volume_name: store!.volumeName
  };
};

const resolveDurableMounts = async (plan: RuntimeTargetPlan): Promise<DurableFixture> => ({
  mounts: resolveWorkspaceResourceVolumes([plan]).mounts,
  storeMount: await resolveStoreMount()
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

    const instancePaths = {
      configPath: `${instanceRoot}/daimon/config.json`,
      instanceRoot,
      workspacePath
    };
    const meta = {
      configFileName: "daimon/config.json",
      instancePaths: { configPathTemplate: "", workspacePathTemplate: "" },
      standaloneBaseImage: "node:24-bookworm-slim",
      startCommand: ["bash", "/opt/spawnfile/durable-probe.sh"],
      systemDeps: ["bash", "util-linux"]
    } as unknown as RuntimeContainerMeta;

    // A whole "compile" of this fixture: the REAL resource derivation, then
    // the REAL mount projection over its result.
    const compile = async (): Promise<{ plan: RuntimeTargetPlan } & DurableFixture> => {
      const plan = {
        configEnvBindings: [],
        envFiles: [],
        id: "daimon-organization",
        instancePaths,
        meta,
        modelAuthMethods: {},
        modelSecretsRequired: [],
        packages: [],
        recipeEnv: {},
        resources: resolveDurableResources(
          "reporter", "daimon", "clank-edition-state", instancePaths, meta
        ),
        runtimeName: "daimon",
        runtimeRoot: "/opt/spawnfile/runtime-installs/daimon",
        sourceIds: [],
        targetFiles: [
          { content: "{}\n", path: "daimon/config.json" },
          { content: "#!/usr/bin/env bash\nexit 0\n", mode: 0o755, path: "runtime/daimon-start.sh" }
        ]
      } as unknown as RuntimeTargetPlan;
      return { plan, ...(await resolveDurableMounts(plan)) };
    };

    // "Compile" twice under two different run ids. An author-declared name is
    // returned verbatim and the derived name never mentions either run id, so
    // the two mount sets MUST be identical — that identity is what makes a
    // redeploy reattach the same host volumes instead of creating empty ones.
    const previousRunId = process.env.NOOPOLIS_RUN_ID;
    let firstCompile: { plan: RuntimeTargetPlan } & DurableFixture;
    let secondCompile: { plan: RuntimeTargetPlan } & DurableFixture;
    try {
      process.env.NOOPOLIS_RUN_ID = "run-one";
      firstCompile = await compile();
      process.env.NOOPOLIS_RUN_ID = "run-two";
      secondCompile = await compile();
    } finally {
      if (previousRunId === undefined) delete process.env.NOOPOLIS_RUN_ID;
      else process.env.NOOPOLIS_RUN_ID = previousRunId;
    }
    expect(secondCompile.mounts).toEqual(firstCompile.mounts);
    expect(secondCompile.storeMount).toEqual(firstCompile.storeMount);
    expect(firstCompile.mounts[0]?.volume_name).toBe("clank-edition-state");
    expect(firstCompile.mounts[0]?.lifecycle).toBe("exclusive-reattach");
    const plan = firstCompile.plan;
    const storeMountPath = firstCompile.storeMount.mount_path;
    const statePath = `${storeMountPath}/moltnet.sqlite`;
    expect(firstCompile.storeMount.volume_name).toBe("clank-newsroom-store");
    expect(firstCompile.storeMount.lifecycle).toBe("exclusive-reattach");
    // Never hardcoded: the backing path carries compile-derived hash segments.
    const resourceMountPath = firstCompile.mounts[0]!.mount_path;

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
          `require_backed_mount '${mount.id}' '${escapeMountInfoPath(mount.mount_path)}' '${mount.mount_path}' '${mount.volume_name}'`
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
      const editionPath = `${resourceMountPath}/edition.txt`;
      await writeFile(path.join(dockerDirectory, "durable-probe.sh"), [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        `if [ ! -e '${statePath}' ]; then printf 'story-pitch\\n' > '${statePath}'; fi`,
        `if [ ! -e '${editionPath}' ]; then printf 'assignment\\n' > '${editionPath}'; fi`,
        `printf 'state=%s inode=%s owner=%s marker=%s sentinel=%s edition=%s edition_inode=%s\\n' \\`,
        `  "$(cat '${statePath}')" "$(stat -c %i '${statePath}')" \\`,
        `  "$(stat -c '%u:%g' '${storeMountPath}')" \\`,
        `  "$(test -e '${resourceMountPath}/.spawnfile-volume-init' && printf present || printf absent)" \\`,
        `  "$(stat -c '%u:%g' '${resourceMountPath}')" \\`,
        `  "$(cat '${editionPath}')" "$(stat -c %i '${editionPath}')"`,
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
      const probe = /state=(\S+) inode=(\d+) owner=(\S+) marker=(\S+) sentinel=(\S+) edition=(\S+) edition_inode=(\d+)/u;
      const firstState = probe.exec(first.stdout);
      expect(firstState, first.stdout + first.stderr).not.toBeNull();
      expect(firstState![1]).toBe("story-pitch");
      expect(firstState![3]).toBe(`${AUTHORIZED_UID}:${AUTHORIZED_UID}`);
      expect(firstState![4]).toBe("absent");
      expect(firstState![5]).toBe(`${AUTHORIZED_UID}:${AUTHORIZED_UID}`);
      expect(firstState![6]).toBe("assignment");

      // The routine operation that destroyed the newsroom.
      await execFile("docker", ["rm", "--force", containerName]);

      // A new run id must not change a single mount argument.
      const rerunPrevious = process.env.NOOPOLIS_RUN_ID;
      process.env.NOOPOLIS_RUN_ID = "run-three";
      let rerunMountArgs: string[];
      try {
        const rerun = await compile();
        rerunMountArgs = await resolveRunMountArgs(
          namespaceMounts([...rerun.mounts, rerun.storeMount], suffix)
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
      const secondState = probe.exec(second.stdout);
      expect(secondState, second.stdout + second.stderr).not.toBeNull();
      expect(secondState![1]).toBe("story-pitch");
      expect(secondState![2]).toBe(firstState![2]);
      expect(secondState![3]).toBe(`${AUTHORIZED_UID}:${AUTHORIZED_UID}`);
      expect(secondState![4]).toBe("absent");
      // The workspace `kind: volume` — the mount whose NAME the compiler
      // derives — must be the same host volume, not a fresh empty one.
      expect(secondState![6]).toBe("assignment");
      expect(secondState![7]).toBe(firstState![7]);

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
    const instancePaths = {
      configPath: "/var/lib/spawnfile/instances/openclaw/agent-reporter/config.json",
      workspacePath
    };
    const meta = {
      configFileName: "config.json",
      instancePaths: { configPathTemplate: "", workspacePathTemplate: "" },
      standaloneBaseImage: "node:24-bookworm-slim",
      startCommand: ["bash", "/opt/spawnfile/durable-probe.sh"],
      systemDeps: ["bash"]
    } as unknown as RuntimeContainerMeta;

    const compile = (): { mounts: WorkspaceResourcePersistentMount[]; plan: RuntimeTargetPlan } => {
      const plan = {
        configEnvBindings: [],
        envFiles: [],
        id: "openclaw-reporter",
        instancePaths,
        meta,
        modelAuthMethods: {},
        modelSecretsRequired: [],
        packages: [],
        recipeEnv: {},
        resources: resolveDurableResources(
          "reporter", "openclaw", "clank-edition-state", instancePaths, meta
        ),
        runtimeName: "openclaw",
        runtimeRoot: "/opt/spawnfile/runtime-installs/openclaw",
        sourceIds: [],
        targetFiles: [{ content: "{}\n", path: "config.json" }]
      } as unknown as RuntimeTargetPlan;
      return { mounts: resolveWorkspaceResourceVolumes([plan]).mounts, plan };
    };

    const previousRunId = process.env.NOOPOLIS_RUN_ID;
    let first: ReturnType<typeof compile>;
    let second: ReturnType<typeof compile>;
    try {
      process.env.NOOPOLIS_RUN_ID = "run-one";
      first = compile();
      process.env.NOOPOLIS_RUN_ID = "run-two";
      second = compile();
    } finally {
      if (previousRunId === undefined) delete process.env.NOOPOLIS_RUN_ID;
      else process.env.NOOPOLIS_RUN_ID = previousRunId;
    }
    expect(second.mounts).toEqual(first.mounts);
    const plan = first.plan;
    const mounts = namespaceMounts(first.mounts, suffix);
    expect(mounts).toHaveLength(1);
    expect(first.mounts[0]?.volume_name).toBe("clank-edition-state");
    const backingPath = first.mounts[0]!.mount_path;
    const statePath = `${backingPath}/edition.txt`;
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

      // Recompile under a THIRD run id and mount whatever that compile says.
      // A run-scoped name lands on a brand-new empty volume here, and the
      // inode assertion below is the only thing that notices.
      const rerunPrevious = process.env.NOOPOLIS_RUN_ID;
      process.env.NOOPOLIS_RUN_ID = "run-three";
      let rerunMountArgs: string[];
      try {
        rerunMountArgs = await resolveRunMountArgs(namespaceMounts(compile().mounts, suffix));
      } finally {
        if (rerunPrevious === undefined) delete process.env.NOOPOLIS_RUN_ID;
        else process.env.NOOPOLIS_RUN_ID = rerunPrevious;
      }

      await execFile("docker", ["create", "--name", containerName, ...rerunMountArgs, tag]);
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
