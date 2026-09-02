import { describe, expect, it, vi } from "vitest";
import { execFile as execFileCallback } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import type { RuntimeTargetPlan } from "./containerArtifactsTypes.js";
import type { EntrypointOptions } from "./containerEntrypointRender.js";
import { renderEntrypoint } from "./containerEntrypointRender.js";
import {
  DAIMON_AUTHORIZED_UID_ENV,
  DAIMON_BROKER_STARTUP_TIMEOUT_SECONDS,
  renderDaimonBrokerSocketWait,
  renderDaimonUidEntrypoint,
  resolveDaimonVolumeIdentityFiles,
  resolveDaimonUidEntrypointOwnershipPlan,
  resolveDaimonUidEntrypointStateRoots
} from "./containerDaimonUidEntrypointRender.js";
import { DAIMON_GROK_TURN_USAGE_LEDGER } from "../runtime/daimon/contractManifest.js";

const execFile = promisify(execFileCallback);
const authorizedUid = 2000;

// Every directory from the private state root down to `target`, so a test can create each
// one with the root-owned 0711 preimage the ownership guard demands.
const privateStateAncestors = (target: string): string[] =>
  path.posix.relative("/var/lib", target).split("/")
    .map((_, index, segments) => path.posix.join("/var/lib", ...segments.slice(0, index + 1)));

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
const wakeFuseDirectory = "/var/lib/spawnfile/daimon/wake-fuse";
const usageLedgerDirectory = DAIMON_GROK_TURN_USAGE_LEDGER.directoryPath;
const agyRuntimeHome = "/var/lib/spawnfile/instances/daimon/daimon-organization/runtime-homes/agy";
const codexEngineHome = "/var/lib/spawnfile/instances/daimon/daimon-organization/runtime-homes/codex-one/.codex";
const grokEngineHome = "/var/lib/spawnfile/instances/daimon/daimon-organization/runtime-homes/grok-two/.grok";
const acceptanceStore = "/var/lib/spawnfile/instances/daimon/daimon-organization/state/wake-acceptance";
const acceptanceStoreMount = {
  id: "daimon-organization-acceptance-store",
  mount_path: acceptanceStore,
  reason: "Daimon organization durable wake acceptance store",
  volume_name: "spawnfile-test-daimon-acceptance-store"
};
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
const codexEngineHomeMount = {
  id: "daimon-engine-home-codex-codex-one",
  mount_path: codexEngineHome,
  reason: "Daimon codex subscription credential home for agent:Codex One",
  volume_name: "spawnfile-test-codex-engine-home"
};
const grokEngineHomeMount = {
  id: "daimon-engine-home-grok-grok-two",
  mount_path: grokEngineHome,
  reason: "Daimon grok subscription credential home for agent:Grok Two",
  volume_name: "spawnfile-test-grok-engine-home"
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


describe("renderDaimonUidEntrypoint lifecycle",()=>{
  it("repairs a fresh volume and starts through private executable parents as authorized UID 2000", async () => {
    const instanceRoot = "/var/lib/spawnfile/instances/daimon/daimon-organization";
    const workspacePath = `${instanceRoot}/workspace`;
    const runtimeHomesPath = `${instanceRoot}/runtime-homes`;
    const dockerDirectory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-daimon-uid-image-"));
    const tag = `spawnfile-daimon-uid-${Date.now().toString(36)}`;
    const containerName = `${tag}-container`;
    const supervisorContainerName = `${tag}-supervisor`;
    const volumeName = `${tag}-realm-volume`;
    const runtimeHomeVolumeName = `${tag}-agy-runtime-home-volume`;
    const codexVolumeName = `${tag}-codex-engine-home-volume`;
    const wakeFuseVolumeName = `${tag}-wake-fuse-volume`;
    const usageLedgerVolumeName = `${tag}-usage-ledger-volume`;
    const networkVolumeName = `${tag}-moltnet-network-volume`;
    const resourceVolumeName=`${tag}-workspace-resource-volume`;
    const networkRoot = "/var/lib/spawnfile/moltnet/networks/local";
    const receiptDirectory = `${networkRoot}/daimon-receipts`;
    const resourceLink = `${workspacePath}/agents/writer/repos/public`;
    const volumeResourceRoot="/var/lib/spawnfile/resources/teams/example/shared",volumeResourceSentinel=`${volumeResourceRoot}/.spawnfile-resource-identity`,volumeResourceIdentity="sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const receiptMoltnetPlans = {
      ...moltnetPlans,
      nodePlans: [{ ...moltnetPlans.nodePlans[0]!, receiptStorePath: `${receiptDirectory}/agent.json` }]
    };
    const plan: RuntimeTargetPlan = {
      ...daimonPlan,
      runtimeRoot: "/opt/spawnfile/runtime-installs/daimon",
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
        { ...agyRuntimeHomeMount, volume_name: runtimeHomeVolumeName },
        { ...codexEngineHomeMount, volume_name: codexVolumeName },
        {
          id: "daimon-wake-fuse",
          lifecycle: "exclusive-reattach",
          mount_path: wakeFuseDirectory,
          reason: "Daimon durable wake-fuse admission ledger",
          volume_name: wakeFuseVolumeName
        },
        {
          id: "daimon-grok-usage-ledger",
          lifecycle: "exclusive-reattach",
          mount_path: usageLedgerDirectory,
          reason: "Daimon per-turn engine usage ledger",
          volume_name: usageLedgerVolumeName
        }
      ],
      resources: [{
        backingPath: "/var/lib/spawnfile/resources/instances/writer/public",
        id: "public",
        kind: "git",
        linkPath: resourceLink,
        mode: "mutable",
        mount: "./repos/public",
        sharing: "per_agent",
        url: "https://example.invalid/public.git"
      },{backingPath:volumeResourceRoot,id:"shared",kind:"volume",linkPath:`${workspacePath}/shared`,mode:"mutable",mount:"./shared",sharing:"team",replacementSentinel:volumeResourceSentinel,resolvedIdentity:volumeResourceIdentity} as NonNullable<RuntimeTargetPlan["resources"]>[number]&{replacementSentinel:string;resolvedIdentity:string}],
      targetFiles: [
        { content: "{}\n", path: "daimon/config.json" },
        { content: "#!/usr/bin/env bash\nexit 0\n", mode: 0o755, path: "runtime/daimon-start.sh" }
      ]
    };
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
      const { createRootfsFiles, renderDockerfile } = await import("./containerArtifactsRender.js");
      const dockerfile = await renderDockerfile([plan], {
        moltnet: receiptMoltnetPlans,
        persistentMountPaths: [agyRealm, agyRuntimeHome, codexEngineHome, wakeFuseDirectory, usageLedgerDirectory, causalState, networkRoot,volumeResourceRoot]
      });
      const stateRoots = resolveDaimonUidEntrypointStateRoots([plan]);
      expect(stateRoots).toEqual([runtimeHomesPath, workspacePath]);
      for (const stateRoot of stateRoots) {
        expect(dockerfile).toContain(`install -d -o root -g root -m 700 '${stateRoot}'`);
      }
      expect(dockerfile).not.toContain("SPAWNFILE_DAIMON_WRITABLE_ROOTS");
      expect(dockerfile).not.toContain("/untrusted");

      expect(dockerfile).toContain(`-m 700 '/var/lib/spawnfile/moltnet'`);
      expect(dockerfile).toContain("chown root:root '/var/lib/spawnfile' && chmod 711 '/var/lib/spawnfile'");
      expect(dockerfile).toContain(`'${receiptDirectory}'`);
      const rootfsFiles = createRootfsFiles(
        [plan],
        [agyRealm, agyRuntimeHome, codexEngineHome, wakeFuseDirectory, usageLedgerDirectory, causalState, networkRoot, volumeResourceRoot],
        receiptMoltnetPlans
      );
      expect(rootfsFiles.find((file) => file.path.endsWith("daimon-uid-entrypoint.sh"))?.content)
        .toContain(resourceLink);
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
      for (const configPath of [nodeConfig, serverConfig]) {
        const outputPath = path.join(dockerDirectory, "container/rootfs", configPath);
        await mkdir(path.dirname(outputPath), { recursive: true });
        await writeFile(outputPath, "{}\n", { encoding: "utf8", mode: 0o600 });
      }
      await writeFile(path.join(dockerDirectory, ".env.example"), "", "utf8");
      await writeFile(
        path.join(dockerDirectory, "supervisor-entrypoint.sh"),
        renderEntrypoint([{
          ...plan,
          port: 59999,
          resources: [],
          instancePaths: { configPath: "/tmp/supervisor/config.json", workspacePath: "/tmp/supervisor/workspace" },
          meta: { ...plan.meta, startCommand: ["bash", "-c", "exit 23"] }
        }], [], {
          hasMoltnet: true,
          moltnet: {
            nodePlans: [{ ...receiptMoltnetPlans.nodePlans[0]!, receiptStorePath: undefined }],
            serverPlans: []
          }
        }),
        { encoding: "utf8", mode: 0o755 }
      );
      await writeFile(
        path.join(dockerDirectory, "entrypoint.sh"),
        [
          "#!/usr/bin/env bash",
          "set -euo pipefail",
          `test \"$(id -u)\" = \"\${${DAIMON_AUTHORIZED_UID_ENV}}\"`,
          "getent passwd \"$(id -u)\" >/dev/null",
          "test \"$(sed -n 's/^CapEff:[[:space:]]*//p' /proc/self/status)\" = 0000000000000000",
          "test \"$(stat -c '%u:%a' /opt)\" = 0:711",
          "test \"$(stat -c '%u:%a' /opt/spawnfile)\" = 0:711",
          "! ls /opt/spawnfile >/dev/null 2>&1",
          "test \"$(stat -c '%u:%g:%a' /opt/spawnfile/runtime-installs)\" = 0:0:711",
          "test \"$(stat -c '%u:%g:%a' /opt/spawnfile/runtime-installs/daimon)\" = 0:0:711",
          "test \"$(stat -c '%u:%g:%a' /opt/spawnfile/runtime-installs/daimon/daimon-start.sh)\" = 0:0:555",
          "test ! -L /opt/spawnfile/runtime-installs/daimon/bin/daimon-runtime",
          "test \"$(stat -c '%u:%g:%a' /opt/spawnfile/runtime-installs/daimon/bin/daimon-runtime)\" = 0:0:555",
          "! ls /opt/spawnfile/runtime-installs >/dev/null 2>&1",
          "! ls /opt/spawnfile/runtime-installs/daimon >/dev/null 2>&1",
          "test ! -w /opt/spawnfile/runtime-installs/daimon/daimon-start.sh",
          "bash /opt/spawnfile/runtime-installs/daimon/daimon-start.sh",
          "test \"$(stat -c '%u:%a' /var)\" = 0:711",
          "test \"$(stat -c '%u:%a' /var/lib)\" = 0:711",
          "! ls /var >/dev/null 2>&1",
          "! ls /var/lib >/dev/null 2>&1",
          "test \"$(stat -c '%u:%g:%a' '/var/lib/spawnfile')\" = '0:0:711'",
          "! ls /var/lib/spawnfile >/dev/null 2>&1",
          `test \"$(stat -c '%u:%a' '/var/lib/spawnfile/moltnet')\" = \"\${${DAIMON_AUTHORIZED_UID_ENV}}:700\"`,
          `test \"$(stat -c '%u:%a' '/var/lib/spawnfile/moltnet/servers/local')\" = \"\${${DAIMON_AUTHORIZED_UID_ENV}}:700\"`,
          `test \"$(stat -c '%u:%a' '${serverConfig}')\" = \"\${${DAIMON_AUTHORIZED_UID_ENV}}:600\"`,
          `test \"$(stat -c '%u:%a' '${nodeConfig}')\" = \"\${${DAIMON_AUTHORIZED_UID_ENV}}:600\"`,
          `test \"$(stat -c '%u:%a' '${instanceRoot}/daimon/config.json')\" = \"\${${DAIMON_AUTHORIZED_UID_ENV}}:600\"`,
          `test \"$(stat -c '%u:%a' '${instanceRoot}/daimon')\" = \"\${${DAIMON_AUTHORIZED_UID_ENV}}:700\"`,
          `node -e \"JSON.parse(require('node:fs').readFileSync('${instanceRoot}/daimon/config.json','utf8'))\"`,
          `test \"$(stat -c '%u:%a' '${causalState}')\" = \"\${${DAIMON_AUTHORIZED_UID_ENV}}:700\"`,
          `test \"$(stat -c '%u:%a' '${receiptDirectory}')\" = \"\${${DAIMON_AUTHORIZED_UID_ENV}}:700\"`,
          `test \"$(stat -c '%u:%a' '/run/spawnfile/moltnet-readiness')\" = \"\${${DAIMON_AUTHORIZED_UID_ENV}}:700\"`,
          `test \"$(stat -c '%u:%a' '${agyRealm}')\" = \"\${${DAIMON_AUTHORIZED_UID_ENV}}:700\"`,
          `test \"$(stat -c '%u:%g:%a' '${wakeFuseDirectory}')\" = \"\${${DAIMON_AUTHORIZED_UID_ENV}}:\${${DAIMON_AUTHORIZED_UID_ENV}}:700\"`,
          `test \"$(stat -c '%u:%g:%a' '${usageLedgerDirectory}')\" = \"2100:\${${DAIMON_AUTHORIZED_UID_ENV}}:770\"`,
          `test \"$(stat -c '%u:%a' '${runtimeHomesPath}')\" = \"\${${DAIMON_AUTHORIZED_UID_ENV}}:700\"`,
          `test \"$(stat -c '%u:%a' '${workspacePath}')\" = \"\${${DAIMON_AUTHORIZED_UID_ENV}}:700\"`,
          `if [ ! -e '${volumeResourceRoot}/content' ]; then printf content > '${volumeResourceRoot}/content'; fi`,
          `test \"$(stat -c '%u:%g:%a' '${volumeResourceSentinel}')\" = '0:0:644'`,
          `test \"$(stat -c '%u:%g:%a' '${volumeResourceRoot}/content')\" = \"\${${DAIMON_AUTHORIZED_UID_ENV}}:\${${DAIMON_AUTHORIZED_UID_ENV}}:644\"`,
          `test "$(stat -c '%u:%a' '${agyRuntimeHome}')" = "\${${DAIMON_AUTHORIZED_UID_ENV}}:700"`,
          "test \"$(stat -c '%u:%a' '/var/lib/spawnfile/instances/daimon/daimon-organization/runtime-homes/codex-one/.codex')\" = \"$SPAWNFILE_DAIMON_AUTHORIZED_UID:700\"",
          "test -f '/var/lib/spawnfile/instances/daimon/daimon-organization/runtime-homes/codex-one/.codex/.spawnfile-volume-init'",
          "test \"$(stat -c '%u:%a' /untrusted/sentinel)\" = 0:600",
          "! cat /untrusted/sentinel >/dev/null 2>&1",
          "dbus_root=$(mktemp -d /tmp/spawnfile-dbus.XXXXXX)",
          "chmod 700 \"$dbus_root\"",
          "dbus_address=unix:path=$dbus_root/bus",
          "dbus-daemon --session --fork --nopidfile --address=\"$dbus_address\"",
          "dbus-send --bus=\"$dbus_address\" --dest=org.freedesktop.DBus --print-reply /org/freedesktop/DBus org.freedesktop.DBus.ListNames >/dev/null",
          `count_file='${agyRealm}/starts'`,
          "count=$(cat \"$count_file\" 2>/dev/null || printf 0)",
          "printf %s $((count + 1)) > \"$count_file\"",
          `receipt_file='${receiptDirectory}/agent.json'`,
          "if [ \"$count\" = 0 ]; then printf accepted > \"$receipt_file\"; else test \"$(cat \"$receipt_file\")\" = accepted; fi",
          "readiness_file='/run/spawnfile/moltnet-readiness/local-agent.json'",
          "if [ \"$count\" = 0 ]; then printf ready > \"$readiness_file\"; else test \"$(cat \"$readiness_file\")\" = ready; fi",
          "plugin_link='/var/lib/spawnfile/instances/daimon/daimon-organization/runtime-homes/codex-one/.codex/plugins/cache/example/link'",
          "if [ \"$count\" = 0 ]; then mkdir -p \"$(dirname \"$plugin_link\")\"; ln -s plugin-target \"$plugin_link\"; else test \"$(readlink \"$plugin_link\")\" = plugin-target; fi",
          `resource_link='${resourceLink}'`,
          "if [ \"$count\" = 0 ]; then mkdir -p \"$(dirname \"$resource_link\")\"; ln -s /var/lib/spawnfile/resources/instances/writer/public \"$resource_link\"; else test \"$(readlink \"$resource_link\")\" = /var/lib/spawnfile/resources/instances/writer/public; fi",
          `token_marker='${agyRuntimeHome}/subscription-state'`,
          "if [ \"$count\" = 0 ]; then printf enrolled > \"$token_marker\"; else test \"$(cat \"$token_marker\")\" = enrolled; fi",
          `printf 'entrypoint uid=%s caps=%s realm=%s start=%s\\n' \"$(id -u)\" \"$(sed -n 's/^CapEff:[[:space:]]*//p' /proc/self/status)\" \"$(stat -c '%u:%a' '${agyRealm}')\" \"$count\"`
        ].join("\n") + "\n",
        "utf8"
      );
      await writeFile(
        path.join(dockerDirectory, "Dockerfile"),
        `${dockerfile}\nCOPY --chmod=755 supervisor-entrypoint.sh /supervisor-entrypoint.sh\nRUN install -d -o ${authorizedUid} -g ${authorizedUid} -m 700 /tmp/supervisor/workspace && printf '{}\\n' > /tmp/supervisor/config.json && chown ${authorizedUid}:${authorizedUid} /tmp/supervisor/config.json && chmod 600 /tmp/supervisor/config.json && install -d -o root -g root -m 711 /untrusted && install -o root -g root -m 600 /dev/null /untrusted/sentinel && printf content > '${volumeResourceRoot}/content' && chmod 0644 '${volumeResourceRoot}/content' && chmod 775 /var /var/lib\n`,
        "utf8"
      );
      await execFile("docker", ["build", "--pull=false", "--tag", tag, "."], {
        cwd: dockerDirectory,
        timeout: 30_000
      });
      await execFile("docker", ["volume", "create", networkVolumeName]);
      await execFile("docker",["volume","create",resourceVolumeName]);
      await execFile("docker",["run","--rm","--entrypoint","bash","--mount",`type=volume,source=${resourceVolumeName},target=${volumeResourceRoot},volume-nocopy`,tag,"-ceu",`printf '%s\\n' 'spawnfile.volume-bootstrap.v1' > '${volumeResourceRoot}/.spawnfile-volume-init'; chown 0:0 '${volumeResourceRoot}' '${volumeResourceRoot}/.spawnfile-volume-init'; chmod 0755 '${volumeResourceRoot}'; chmod 0600 '${volumeResourceRoot}/.spawnfile-volume-init'`]);
      await execFile("docker", [
        "run", "--rm", "--entrypoint", "bash",
        "--mount", `type=volume,source=${networkVolumeName},target=${networkRoot}`,
        tag, "-ceu", `touch '${networkRoot}/moltnet.sqlite'; chown ${authorizedUid}:${authorizedUid} '${networkRoot}'; chmod 700 '${networkRoot}'`
      ]);
      await execFile("docker", [
        "create", "--name", containerName,
        "--cap-drop=ALL", "--cap-add=CHOWN", "--cap-add=SETUID", "--cap-add=SETGID", "--cap-add=DAC_READ_SEARCH",
        "--security-opt=no-new-privileges:true",
        "--env", `${DAIMON_AUTHORIZED_UID_ENV}=${authorizedUid}`,
        "--env", "SPAWNFILE_DAIMON_WRITABLE_ROOTS=/untrusted",
        "--mount", `type=volume,source=${volumeName},target=${agyRealm}`,
        "--mount", `type=volume,source=${runtimeHomeVolumeName},target=${agyRuntimeHome}`,
        "--mount", `type=volume,source=${codexVolumeName},target=${codexEngineHome}`,
        "--mount", `type=volume,source=${wakeFuseVolumeName},target=${wakeFuseDirectory}`,
        "--mount", `type=volume,source=${usageLedgerVolumeName},target=${usageLedgerDirectory}`,
        "--mount", `type=volume,source=${networkVolumeName},target=${networkRoot}`,
        "--mount",`type=volume,source=${resourceVolumeName},target=${volumeResourceRoot},volume-nocopy`,
        tag
      ]);
      const initial = await execFile("docker", ["start", "-a", containerName]);
      const restarted = await execFile("docker", ["start", "-a", containerName]);
      expect(initial.stdout).toContain(`entrypoint uid=${authorizedUid} caps=0000000000000000 realm=${authorizedUid}:700 start=0`);
      expect(restarted.stdout).toContain(`entrypoint uid=${authorizedUid} caps=0000000000000000 realm=${authorizedUid}:700 start=1`);
      await execFile("docker",["run","--rm","--entrypoint","bash","--mount",`type=volume,source=${resourceVolumeName},target=${volumeResourceRoot},volume-nocopy`,tag,"-ceu",`chown ${authorizedUid}:${authorizedUid} '${volumeResourceSentinel}'`]);
      await expect(execFile("docker",["start","-a",containerName])).rejects.toThrow(/volume identity anchor is unsafe/u);
      await execFile("docker", [
        "create", "--name", supervisorContainerName, "--user", `${authorizedUid}:${authorizedUid}`,
        "--entrypoint", "/supervisor-entrypoint.sh", tag,
        "--spawnfile-runtime-identity", `${authorizedUid}`, `${authorizedUid}`
      ]);
      const supervisorStarted = Date.now();
      await expect(execFile("docker", ["start", "-a", supervisorContainerName], { timeout: 5_000 }))
        .rejects.toThrow(/Daimon exited before readiness/u);
      expect(Date.now() - supervisorStarted).toBeLessThan(4_000);
      await expect(execFile("docker", ["start", "-a", supervisorContainerName], { timeout: 5_000 }))
        .rejects.toThrow(/Daimon exited before readiness/u);
      await expect(execFile("docker", [
        "run", "--rm", "--user", "2001:2001", "--entrypoint", "bash",
        "--mount", `type=volume,source=${networkVolumeName},target=${networkRoot},readonly`,
        tag, "-ceu",
        `! ls /var/lib/spawnfile >/dev/null 2>&1; ! cat '${instanceRoot}/daimon/config.json' >/dev/null 2>&1; ! cat '${receiptDirectory}/agent.json' >/dev/null 2>&1; ! cat /untrusted/sentinel >/dev/null 2>&1`
      ])).resolves.toBeDefined();
    } finally {
      vi.doUnmock("../runtime/index.js");
      vi.resetModules();
      await execFile("docker", ["rm", "--force", containerName]).catch(() => undefined);
      await execFile("docker", ["rm", "--force", supervisorContainerName]).catch(() => undefined);
      await execFile("docker", ["volume", "rm", "--force", volumeName]).catch(() => undefined);
      await execFile("docker", ["volume", "rm", "--force", runtimeHomeVolumeName]).catch(() => undefined);
      await execFile("docker", ["volume", "rm", "--force", codexVolumeName]).catch(() => undefined);
      await execFile("docker", ["volume", "rm", "--force", wakeFuseVolumeName]).catch(() => undefined);
      await execFile("docker", ["volume", "rm", "--force", usageLedgerVolumeName]).catch(() => undefined);
      await execFile("docker", ["volume", "rm", "--force", networkVolumeName]).catch(() => undefined);
      await execFile("docker",["volume","rm","--force",resourceVolumeName]).catch(()=>undefined);
      await execFile("docker", ["image", "rm", "--force", tag]).catch(() => undefined);
      await rm(dockerDirectory, { force: true, recursive: true });
    }
  }, 60_000);

  // The guard hardens the fixed /var and /var/lib ancestors and the private state root
  // before it ever opens a compiler-authored state root, and it walks every absolute path
  // segment by segment from "/" through /proc/self/fd. Both facts make the host filesystem
  // the wrong place to exercise the hostile-ancestor rejection: on macOS every open fails
  // because /proc does not exist, and on unprivileged Linux the /var fchmod raises EPERM,
  // so the assertion below would pass or explode for reasons unrelated to the symlink.
  // Running inside a throwaway Linux container gives the test a filesystem it owns from /
  // down, so the rejection it asserts is caused by the symlink the test itself planted.
  it("rejects an ancestor symlink and ignores run-env roots before a restart can reach an external entrypoint", async () => {
    const testRoot = "/spawnfile-daimon-root-link";
    const externalRoot = `${testRoot}/opt/spawnfile/root`;
    const protectedEntrypoint = `${externalRoot}/entrypoint.sh`;
    const hostileParent = `${testRoot}/compiled`;
    const instanceRoot = `${hostileParent}/instance`;
    const wrapper = `${testRoot}/daimon-uid-entrypoint.sh`;
    const runEnvironment = `${testRoot}/run.env`;
    const configPath = daimonPlan.instancePaths.configPath;
    const rejection = "Daimon ownership guard: root has a symbolic-link or unavailable path component";
    const plan: RuntimeTargetPlan = {
      ...daimonPlan,
      instancePaths: {
        ...daimonPlan.instancePaths,
        instanceRoot,
        workspacePath: `${instanceRoot}/workspace`
      }
    };
    const stateRoots = resolveDaimonUidEntrypointStateRoots([plan]);
    expect(stateRoots).toEqual([`${instanceRoot}/runtime-homes`, `${instanceRoot}/workspace`]);
    const rendered = renderDaimonUidEntrypoint([plan]);
    expect(rendered).not.toContain("SPAWNFILE_DAIMON_WRITABLE_ROOTS");
    const { stdout } = await execFile("docker", [
      "run", "--rm",
      "--env", `SPAWNFILE_TEST_WRAPPER=${Buffer.from(rendered, "utf8").toString("base64")}`,
      "node:24-bookworm-slim", "bash", "-c",
      [
        "set -eu",
        // Behind the symlink the state roots resolve to real directories, so the guard can
        // only fail for having refused to follow the symlink, never for a missing path.
        `install -d -o root -g root -m 755 '${externalRoot}' ${stateRoots.map((root) => `'${root.replace(hostileParent, externalRoot)}'`).join(" ")}`,
        `printf 'trusted root entrypoint\\n' > '${protectedEntrypoint}'`,
        `ln -s '${externalRoot}' '${hostileParent}'`,
        // Compiler-authored private state the guard secures before any state root.
        ...privateStateAncestors(path.posix.dirname(configPath))
          .map((directory) => `install -d -o root -g root -m 711 '${directory}'`),
        `printf '{}\\n' > '${configPath}'`,
        `printf %s "$SPAWNFILE_TEST_WRAPPER" | base64 -d > '${wrapper}'`,
        `printf 'SPAWNFILE_DAIMON_WRITABLE_ROOTS=/opt/spawnfile/root\\n' > '${runEnvironment}'`,
        "for restart in 1 2; do",
        "  set +e",
        `  guard_stderr=$( ( set -a; . '${runEnvironment}'; set +a; exec bash '${wrapper}' ) 2>&1 >/dev/null )`,
        "  guard_status=$?",
        "  set -e",
        `  printf 'restart=%s status=%s stderr=%s\\n' "$restart" "$guard_status" "$guard_stderr"`,
        "done",
        `printf 'entrypoint=%s\\n' "$(cat '${protectedEntrypoint}')"`,
        `printf 'external-root=%s\\n' "$(stat -c %F '${externalRoot}')"`,
        ...stateRoots.map((root) => {
          const behindLink = root.replace(hostileParent, externalRoot);
          return `printf '%s=%s\\n' '${path.posix.basename(root)}' "$(stat -c '%u:%g:%a' '${behindLink}')"`;
        })
      ].join("\n")
    ], { timeout: 60_000 });
    expect(stdout).toContain(`restart=1 status=1 stderr=${rejection}\n`);
    expect(stdout).toContain(`restart=2 status=1 stderr=${rejection}\n`);
    expect(stdout).toContain("entrypoint=trusted root entrypoint\n");
    expect(stdout).toContain("external-root=directory\n");
    // Following the symlink would have handed the protected tree to the runtime UID.
    expect(stdout).toContain("runtime-homes=0:0:755\n");
    expect(stdout).toContain("workspace=0:0:755\n");
  }, 60_000);
});
