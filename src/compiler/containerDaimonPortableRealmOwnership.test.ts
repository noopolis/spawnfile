import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DAIMON_CODEX_SUBSCRIPTION_REALM, DAIMON_GROK_SUBSCRIPTION_REALM } from "../runtime/daimon/contractManifest.js";
import { daimonPortableSubscriptionRealms } from "../runtime/daimon/subscriptionRealms.js";
import type { RuntimeTargetPlan } from "./containerArtifactsTypes.js";
import { renderDaimonUidEntrypoint, resolveDaimonUidEntrypointOwnershipPlan } from "./containerDaimonUidEntrypointRender.js";

const execFile = promisify(execFileCallback);
const realm = DAIMON_CODEX_SUBSCRIPTION_REALM.durableMountPath;
const portable = daimonPortableSubscriptionRealms(["codex"]);
const plan: RuntimeTargetPlan = {
  runtimeName: "daimon", runtimeRoot: "/opt/daimon", id: "portable-realm",
  engineByNodeId: { "agent:writer": "codex" }, envFiles: [], modelAuthMethods: {}, modelSecretsRequired: [], targetFiles: [],
  instancePaths: { configPath: "/var/lib/spawnfile/instance/config.json", instanceRoot: "/var/lib/spawnfile/instance", workspacePath: "/var/lib/spawnfile/instance/workspace" },
  meta: { configFileName: "config.json", instancePaths: { configPathTemplate: "", workspacePathTemplate: "" }, standaloneBaseImage: "node:24", startCommand: [], systemDeps: [] },
  opaqueMountTargets: portable.opaqueMountTargets,
  persistentMounts: portable.persistentMounts.map(({ mountPath, ...mount }) => ({ ...mount, mount_path: mountPath, volume_name: "test-portable-realm" }))
};

describe("portable subscription realm ownership", () => {
  it("secures declared portable realms without changing broker ownership or accepting a mismatched mount", () => {
    const broker = DAIMON_GROK_SUBSCRIPTION_REALM.durableMountPath;
    const ownership = resolveDaimonUidEntrypointOwnershipPlan([{
      ...plan, persistentMounts: [...plan.persistentMounts!,
        { id: "daimon-grok-subscription-realm", mount_path: broker, volume_name: "broker", reason: "broker" },
        { ...plan.persistentMounts![0]!, mount_path: "/var/lib/spawnfile/unrelated" }
      ]
    }], [realm, broker]);
    expect(ownership.privateModeDirectories).toContain(realm);
    expect(ownership.privateModeDirectories).not.toContain(broker);
    expect(ownership.privateModeDirectories).not.toContain("/var/lib/spawnfile/unrelated");
    expect(ownership.privateModeDirectories).not.toContain(DAIMON_CODEX_SUBSCRIPTION_REALM.bootstrapMountPath);
  });

  it("repairs an actual fresh Docker volume from 0755 and preserves private authority state on restart", async () => {
    const volume = `spawnfile-portable-realm-mode-${process.pid}-${Date.now().toString(36)}`;
    const ownership = resolveDaimonUidEntrypointOwnershipPlan([plan], [realm]);
    const rendered = renderDaimonUidEntrypoint([plan], [realm]);
    const program = rendered.split("<<'SPAWNFILE_DAIMON_OWNERSHIP'\n")[1]!.split("\nSPAWNFILE_DAIMON_OWNERSHIP")[0]!;
    const directories = [...new Set(["/var/lib/spawnfile", "/var/lib/spawnfile/daimon", ...ownership.privateDirectories, ...ownership.stateRoots])].filter(target => target !== realm);
    try {
      await execFile("docker", ["volume", "create", volume]);
      const { stdout } = await execFile("docker", [
        "run", "--rm", "--network", "none", "--cap-drop=ALL", "--cap-add=CHOWN", "--cap-add=DAC_READ_SEARCH",
        "--security-opt=no-new-privileges:true", "--mount", `type=volume,source=${volume},target=${realm},volume-nocopy`,
        "--env", `SPAWNFILE_TEST_OWNERSHIP=${Buffer.from(program).toString("base64")}`,
        "node:24-bookworm-slim", "bash", "-ceu", [
          `test "$(stat -c '%u:%g:%a' '${realm}')" = 0:0:755`,
          `printf preserved > '${realm}/checkpoint'`,
          `install -d -m 711 ${directories.map(directory => `'${directory}'`).join(" ")}`,
          `printf '{}\\n' > '${plan.instancePaths.configPath}'`,
          'printf %s "$SPAWNFILE_TEST_OWNERSHIP" | base64 -d > /tmp/ownership.cjs',
          ...["first", "restart"].flatMap(label => [
            `node /tmp/ownership.cjs 2000 ${ownership.stateRoots.map(root => `'${root}'`).join(" ")}`,
            `printf '${label}=%s state=%s\\n' "$(stat -c '%u:%g:%a' '${realm}')" "$(cat '${realm}/checkpoint')"`,
            `test "$(stat -c '%u:%g:%a' '${path.posix.dirname(realm)}')" = 0:0:711`
          ])
        ].join("\n")
      ], { timeout: 30_000 });
      expect(stdout).toContain("first=2000:2000:700 state=preserved");
      expect(stdout).toContain("restart=2000:2000:700 state=preserved");
    } finally {
      await execFile("docker", ["volume", "rm", "--force", volume]).catch(() => undefined);
    }
  }, 45_000);
});
