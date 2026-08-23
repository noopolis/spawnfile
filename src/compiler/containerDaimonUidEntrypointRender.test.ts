import { describe, expect, it, vi } from "vitest";
import { execFile as execFileCallback, spawnSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import type { RuntimeTargetPlan } from "./containerArtifactsTypes.js";
import type { EntrypointOptions } from "./containerEntrypointRender.js";
import {
  DAIMON_AUTHORIZED_UID_ENV,
  renderDaimonUidEntrypoint,
  resolveDaimonUidEntrypointOwnershipPlan,
  resolveDaimonUidEntrypointStateRoots
} from "./containerDaimonUidEntrypointRender.js";

const execFile = promisify(execFileCallback);
const authorizedUid = 501;

const daimonPlan: RuntimeTargetPlan = {
  engineByNodeId: { "agent:AGY": "agy", "agent:Codex One": "codex", "agent:Grok Two": "grok" },
  envFiles: [], id: "daimon-organization",
  instancePaths: {
    configPath: "/var/lib/spawnfile/instances/daimon/daimon-organization/daimon/config.json",
    instanceRoot: "/var/lib/spawnfile/instances/daimon/daimon-organization",
    workspacePath: "/var/lib/spawnfile/instances/daimon/daimon-organization/workspace"
  },
  meta: { configFileName: "config.json", instancePaths: { configPathTemplate: "", workspacePathTemplate: "" }, standaloneBaseImage: "node:24", startCommand: [], systemDeps: [] },
  modelAuthMethods: {}, modelSecretsRequired: [], opaqueMountTargets: ["/var/lib/spawnfile/daimon/agy-unlock-secret"],
  runtimeName: "daimon", runtimeRoot: "/opt/daimon", targetFiles: []
};

const serverConfig = "/var/lib/spawnfile/moltnet/servers/local/Moltnet.json";
const nodeConfig = "/var/lib/spawnfile/moltnet/nodes/agent.json";
const causalState = "/var/lib/spawnfile/moltnet/servers/local/causal";
const agyRealm = "/var/lib/spawnfile/daimon/agy-subscription-realm";
const agyRuntimeHome = "/var/lib/spawnfile/instances/daimon/daimon-organization/runtime-homes/agy";
const agyRealmMount = {
  id: "daimon-agy-subscription-realm",
  mount_path: agyRealm,
  reason: "Daimon host AGY subscription realm",
  volume_name: "spawnfile-test-agy-realm"
};
const agyRuntimeHomeMount = {
  id: "daimon-agy-runtime-home-agy",
  mount_path: agyRuntimeHome,
  reason: "Daimon AGY subscription runtime home for agent:agy",
  volume_name: "spawnfile-test-agy-runtime-home"
};
const moltnetPlans = {
  nodePlans: [{ configPath: nodeConfig, networkId: "local" }],
  serverPlans: [{
    baseUrl: "http://127.0.0.1:8787",
    configPath: serverConfig,
    id: "local",
    mode: "managed" as const,
    name: "Local",
    networkId: "local",
    port: 8787,
    rooms: [],
    secretPatches: [],
    server: {
      auth: { mode: "none" as const },
      listen: { bind: "127.0.0.1", port: 8787 },
      mode: "managed" as const,
      store: { kind: "memory" as const }
    },
    teamSource: "/fixture/Spawnfile"
  }]
} satisfies NonNullable<EntrypointOptions["moltnet"]>;

describe("renderDaimonUidEntrypoint", () => {
  it("reowns only compiler-authored state, skips opaque mounts, and drops every capability before the existing entrypoint", () => {
    const rendered = renderDaimonUidEntrypoint(
      [{ ...daimonPlan, persistentMounts: [agyRealmMount, agyRuntimeHomeMount] }],
      [agyRealm, agyRuntimeHome, "/var/lib/spawnfile/daimon-state"],
      moltnetPlans
    );

    expect(rendered).toContain(`uid="\${${DAIMON_AUTHORIZED_UID_ENV}:-1001}"`);
    expect(rendered).toContain("runtime-homes/codex-one/.daimon-inbound/codex-auth");
    expect(rendered).toContain("runtime-homes/grok-two/.daimon-inbound/grok-auth");
    expect(rendered).toContain("/var/lib/spawnfile/daimon/agy-unlock-secret");
    expect(rendered).not.toContain("runtime-homes/agy/.daimon-inbound/agy-auth");
    expect(rendered).toContain("const opaquePaths = new Set(");
    expect(rendered).toContain("constants.O_NOFOLLOW");
    expect(rendered).toContain("fs.fchownSync");
    expect(rendered).toContain(`const privateFiles = ["${nodeConfig}","${serverConfig}"];`);
    expect(rendered).toContain(`const privateModeDirectories = ["${agyRealm}","${agyRuntimeHome}"];`);
    expect(rendered).toContain("for (const target of privateDirectories)");
    expect(rendered).toContain("for (const target of privateModeDirectories)");
    expect(rendered).toContain("for (const target of privateFiles)");
    expect(rendered).toContain("const securePrivateDirectory = (fd) => {");
    expect(rendered).toContain("fs.fchownSync(fd, 0, 0);");
    expect(rendered).toContain("fs.fchmodSync(fd, 0o700)");
    expect(rendered).toContain("fs.fchownSync(fd, uid, uid);");
    expect(rendered).toContain("fail('unable to secure private directory')");
    expect(rendered).toContain("info.uid !== uid || info.gid !== uid || (info.mode & 0o777) !== 0o700");
    const temporaryRootOwnership = rendered.indexOf("fs.fchownSync(fd, 0, 0);");
    const privateModeRepair = rendered.indexOf("fs.fchmodSync(fd, 0o700);", temporaryRootOwnership);
    const authorizedOwnership = rendered.indexOf("fs.fchownSync(fd, uid, uid);", privateModeRepair);
    expect(temporaryRootOwnership).toBeGreaterThan(-1);
    expect(privateModeRepair).toBeGreaterThan(temporaryRootOwnership);
    expect(authorizedOwnership).toBeGreaterThan(privateModeRepair);
    expect(rendered).toContain("mountOptionsFor(target).includes('ro')");
    expect(rendered).toContain('node - "$uid" "${state_roots[@]}"');
    expect(rendered).not.toContain("SPAWNFILE_DAIMON_WRITABLE_ROOTS");
    expect(rendered).toContain('if ! getent passwd "$uid"');
    expect(rendered).toContain('useradd -K UID_MIN=1 --no-create-home --no-log-init --uid "$uid"');
    expect(rendered).toContain("--clear-groups --reuid \"$uid\" --regid \"$gid\"");
    expect(rendered).toContain("--inh-caps=-all --ambient-caps=-all --bounding-set=-all");
    expect(rendered).toContain('if [ "$EUID" -eq 0 ]');
    expect(rendered).toContain('CapEff:[[:space:]]*');
    expect(rendered).toContain('exec "$@"');
    expect(rendered).toContain(
      'runtime_command=(bash \'/opt/daimon/daimon-start.sh\' "$@")'
    );
    expect(rendered).not.toContain('runtime_command=(daimon-runtime "$@")');
    expect(rendered).toContain('[ "$1" != auth ]');
    expect(rendered).toContain("/var/lib/spawnfile/instances/daimon/daimon-organization/daimon/config.json");
    expect(rendered).not.toMatch(/find -P|chown -R| cp /);
    expect(rendered).not.toMatch(/chmod -R/);
  });

  it("repairs only exact private traversal ancestors, Moltnet configs, and writable leaves", () => {
    expect(resolveDaimonUidEntrypointOwnershipPlan(
      [{ ...daimonPlan, persistentMounts: [agyRealmMount, agyRuntimeHomeMount] }],
      [agyRealm, agyRuntimeHome, causalState, "/external-state"],
      moltnetPlans
    )).toEqual({
      privateDirectories: [
        "/var/lib/spawnfile",
        "/var/lib/spawnfile/daimon",
        agyRealm,
        "/var/lib/spawnfile/instances",
        "/var/lib/spawnfile/instances/daimon",
        "/var/lib/spawnfile/instances/daimon/daimon-organization",
        "/var/lib/spawnfile/instances/daimon/daimon-organization/runtime-homes",
        agyRuntimeHome,
        "/var/lib/spawnfile/instances/daimon/daimon-organization/workspace",
        "/var/lib/spawnfile/moltnet",
        "/var/lib/spawnfile/moltnet/nodes",
        "/var/lib/spawnfile/moltnet/servers",
        "/var/lib/spawnfile/moltnet/servers/local",
        causalState
      ],
      privateFiles: [nodeConfig, serverConfig],
      privateModeDirectories: [agyRealm, agyRuntimeHome],
      stateRoots: [
        "/external-state",
        agyRealm,
        "/var/lib/spawnfile/instances/daimon/daimon-organization/runtime-homes",
        agyRuntimeHome,
        "/var/lib/spawnfile/instances/daimon/daimon-organization/workspace",
        causalState
      ]
    });
  });

  it("omits pruning when no Daimon opaque mount was declared", () => {
    const rendered = renderDaimonUidEntrypoint([{
      ...daimonPlan,
      engineByNodeId: undefined,
      opaqueMountTargets: undefined,
      instancePaths: {
        ...daimonPlan.instancePaths,
        homePath: "/var/lib/spawnfile/instances/daimon/daimon-organization/home"
      }
    }]);

    expect(rendered).toContain("const opaquePaths = new Set([]);");
  });

  it("uses only absolute roots when plan metadata or persistent input is incomplete", () => {
    const rendered = renderDaimonUidEntrypoint([{
      ...daimonPlan,
      instancePaths: {
        ...daimonPlan.instancePaths,
        instanceRoot: undefined,
        workspacePath: "relative-workspace"
      }
    }], ["relative-state", "/persisted-state", "/persisted-state"]);

    expect(rendered).toContain("state_roots=('/persisted-state')");
    expect(rendered).not.toContain("runtime-homes/codex-one/.daimon-inbound/codex-auth");
  });

  it("repairs a fresh volume and private Moltnet ancestors for authorized UID 501 across restart", async () => {
    const instanceRoot = "/var/lib/spawnfile/instances/daimon/daimon-organization";
    const workspacePath = `${instanceRoot}/workspace`;
    const runtimeHomesPath = `${instanceRoot}/runtime-homes`;
    const dockerDirectory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-daimon-uid-image-"));
    const tag = `spawnfile-daimon-uid-${Date.now().toString(36)}`;
    const containerName = `${tag}-container`;
    const volumeName = `${tag}-realm-volume`;
    const runtimeHomeVolumeName = `${tag}-agy-runtime-home-volume`;
    const plan: RuntimeTargetPlan = {
      ...daimonPlan,
      engineByNodeId: undefined,
      instancePaths: {
        configPath: `${instanceRoot}/daimon/config.json`,
        instanceRoot,
        workspacePath
      },
      meta: {
        ...daimonPlan.meta,
        configFileName: "daimon/config.json",
        startCommand: ["true"],
        systemDeps: ["bash", "dbus-daemon", "util-linux"]
      },
      persistentMounts: [
        { ...agyRealmMount, volume_name: volumeName },
        { ...agyRuntimeHomeMount, volume_name: runtimeHomeVolumeName }
      ],
      targetFiles: [{ content: "{}\n", path: "daimon/config.json" }]
    };
    try {
      vi.resetModules();
      vi.doMock("../runtime/index.js", () => ({
        createRuntimeInstallRecipe: vi.fn(async () => ({
          baseImage: "node:24-bookworm-slim",
          commands: [],
          copyCommands: [],
          runtimeName: "daimon",
          runtimeRoot: "/opt/daimon"
        }))
      }));
      const { createRootfsFiles, renderDockerfile } = await import("./containerArtifactsRender.js");
      const dockerfile = await renderDockerfile([plan], {
        moltnet: moltnetPlans,
        persistentMountPaths: [agyRealm, agyRuntimeHome, causalState]
      });
      const stateRoots = resolveDaimonUidEntrypointStateRoots([plan]);
      expect(stateRoots).toEqual([runtimeHomesPath, workspacePath]);
      for (const stateRoot of stateRoots) {
        expect(dockerfile).toContain(`install -d -o root -g root -m 700 '${stateRoot}'`);
      }
      expect(dockerfile).not.toContain("SPAWNFILE_DAIMON_WRITABLE_ROOTS");
      expect(dockerfile).not.toContain("/untrusted");

      for (const file of createRootfsFiles([plan], [agyRealm, agyRuntimeHome, causalState], moltnetPlans)) {
        const outputPath = path.join(dockerDirectory, file.path);
        await mkdir(path.dirname(outputPath), { recursive: true });
        await writeFile(outputPath, file.content, "utf8");
      }
      for (const configPath of [nodeConfig, serverConfig]) {
        const outputPath = path.join(dockerDirectory, "container/rootfs", configPath);
        await mkdir(path.dirname(outputPath), { recursive: true });
        await writeFile(outputPath, "{}\n", { encoding: "utf8", mode: 0o600 });
      }
      await writeFile(path.join(dockerDirectory, ".env.example"), "", "utf8");
      await writeFile(
        path.join(dockerDirectory, "entrypoint.sh"),
        [
          "#!/usr/bin/env bash",
          "set -euo pipefail",
          `test \"$(id -u)\" = \"\${${DAIMON_AUTHORIZED_UID_ENV}}\"`,
          "getent passwd \"$(id -u)\" >/dev/null",
          "test \"$(sed -n 's/^CapEff:[[:space:]]*//p' /proc/self/status)\" = 0000000000000000",
          `test \"$(stat -c '%u:%a' '/var/lib/spawnfile')\" = \"\${${DAIMON_AUTHORIZED_UID_ENV}}:700\"`,
          `test \"$(stat -c '%u:%a' '/var/lib/spawnfile/moltnet')\" = \"\${${DAIMON_AUTHORIZED_UID_ENV}}:700\"`,
          `test \"$(stat -c '%u:%a' '/var/lib/spawnfile/moltnet/servers/local')\" = \"\${${DAIMON_AUTHORIZED_UID_ENV}}:700\"`,
          `test \"$(stat -c '%u:%a' '${serverConfig}')\" = \"\${${DAIMON_AUTHORIZED_UID_ENV}}:600\"`,
          `test \"$(stat -c '%u:%a' '${nodeConfig}')\" = \"\${${DAIMON_AUTHORIZED_UID_ENV}}:600\"`,
          `test \"$(stat -c '%u:%a' '${causalState}')\" = \"\${${DAIMON_AUTHORIZED_UID_ENV}}:700\"`,
          `test \"$(stat -c '%u:%a' '${agyRealm}')\" = \"\${${DAIMON_AUTHORIZED_UID_ENV}}:700\"`,
          `test \"$(stat -c '%u:%a' '${runtimeHomesPath}')\" = \"\${${DAIMON_AUTHORIZED_UID_ENV}}:700\"`,
          `test \"$(stat -c '%u:%a' '${workspacePath}')\" = \"\${${DAIMON_AUTHORIZED_UID_ENV}}:700\"`,
          `test "$(stat -c '%u:%a' '${agyRuntimeHome}')" = "\${${DAIMON_AUTHORIZED_UID_ENV}}:700"`,
          "test \"$(stat -c '%u:%a' /untrusted/sentinel)\" = 0:600",
          "dbus_root=$(mktemp -d /tmp/spawnfile-dbus.XXXXXX)",
          "chmod 700 \"$dbus_root\"",
          "dbus_address=unix:path=$dbus_root/bus",
          "dbus-daemon --session --fork --nopidfile --address=\"$dbus_address\"",
          "dbus-send --bus=\"$dbus_address\" --dest=org.freedesktop.DBus --print-reply /org/freedesktop/DBus org.freedesktop.DBus.ListNames >/dev/null",
          `count_file='${agyRealm}/starts'`,
          "count=$(cat \"$count_file\" 2>/dev/null || printf 0)",
          "printf %s $((count + 1)) > \"$count_file\"",
          `token_marker='${agyRuntimeHome}/subscription-state'`,
          "if [ \"$count\" = 0 ]; then printf enrolled > \"$token_marker\"; else test \"$(cat \"$token_marker\")\" = enrolled; fi",
          `printf 'entrypoint uid=%s caps=%s realm=%s start=%s\\n' \"$(id -u)\" \"$(sed -n 's/^CapEff:[[:space:]]*//p' /proc/self/status)\" \"$(stat -c '%u:%a' '${agyRealm}')\" \"$count\"`
        ].join("\n") + "\n",
        "utf8"
      );
      await writeFile(
        path.join(dockerDirectory, "Dockerfile"),
        `${dockerfile}\nRUN install -d -o root -g root -m 755 /untrusted && install -o root -g root -m 600 /dev/null /untrusted/sentinel\n`,
        "utf8"
      );
      await execFile("docker", ["build", "--pull=false", "--tag", tag, "."], {
        cwd: dockerDirectory,
        timeout: 30_000
      });
      await execFile("docker", [
        "create", "--name", containerName,
        "--cap-drop=ALL", "--cap-add=CHOWN", "--cap-add=SETUID", "--cap-add=SETGID", "--cap-add=DAC_READ_SEARCH",
        "--security-opt=no-new-privileges:true",
        "--env", `${DAIMON_AUTHORIZED_UID_ENV}=${authorizedUid}`,
        "--env", "SPAWNFILE_DAIMON_WRITABLE_ROOTS=/untrusted",
        "--mount", `type=volume,source=${volumeName},target=${agyRealm}`,
        "--mount", `type=volume,source=${runtimeHomeVolumeName},target=${agyRuntimeHome}`,
        tag
      ]);
      const initial = await execFile("docker", ["start", "-a", containerName]);
      const restarted = await execFile("docker", ["start", "-a", containerName]);
      expect(initial.stdout).toContain(`entrypoint uid=${authorizedUid} caps=0000000000000000 realm=${authorizedUid}:700 start=0`);
      expect(restarted.stdout).toContain(`entrypoint uid=${authorizedUid} caps=0000000000000000 realm=${authorizedUid}:700 start=1`);
    } finally {
      vi.doUnmock("../runtime/index.js");
      vi.resetModules();
      await execFile("docker", ["rm", "--force", containerName]).catch(() => undefined);
      await execFile("docker", ["volume", "rm", "--force", volumeName]).catch(() => undefined);
      await execFile("docker", ["volume", "rm", "--force", runtimeHomeVolumeName]).catch(() => undefined);
      await execFile("docker", ["image", "rm", "--force", tag]).catch(() => undefined);
      await rm(dockerDirectory, { force: true, recursive: true });
    }
  }, 60_000);

  it("rejects an ancestor symlink and ignores run-env roots before a restart can reach an external entrypoint", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-daimon-root-link-"));
    const externalRoot = path.join(directory, "opt", "spawnfile", "root");
    const protectedEntrypoint = path.join(externalRoot, "entrypoint.sh");
    const hostileParent = path.join(directory, "compiled");
    const instanceRoot = path.join(hostileParent, "instance");
    const runEnvironment = path.join(directory, "run.env");
    const wrapper = path.join(directory, "daimon-uid-entrypoint.sh");
    try {
      await mkdir(externalRoot, { recursive: true });
      await writeFile(protectedEntrypoint, "trusted root entrypoint\n", "utf8");
      await symlink(path.join(directory, "opt", "spawnfile", "root"), hostileParent);
      await writeFile(runEnvironment, "SPAWNFILE_DAIMON_WRITABLE_ROOTS=/opt/spawnfile/root\n", "utf8");
      const rendered = renderDaimonUidEntrypoint([{
        ...daimonPlan,
        instancePaths: {
          ...daimonPlan.instancePaths,
          instanceRoot,
          workspacePath: path.join(instanceRoot, "workspace")
        }
      }]);
      await writeFile(wrapper, rendered, "utf8");
      for (const _restart of [0, 1]) {
        const result = spawnSync("bash", ["-c", 'set -a; . "$1"; set +a; exec bash "$2"', "bash", runEnvironment, wrapper], {
          env: process.env
        });
        expect(result.status).not.toBe(0);
        expect(Buffer.from(result.stderr).toString("utf8")).toContain("symbolic-link");
      }
      expect(await readFile(protectedEntrypoint, "utf8")).toBe("trusted root entrypoint\n");
      expect((await lstat(externalRoot)).isDirectory()).toBe(true);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});
