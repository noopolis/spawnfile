import { execFile as execFileCallback } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import { DAIMON_CODEX_SUBSCRIPTION_REALM } from "../runtime/daimon/contractManifest.js";
import { DAIMON_GATEWAY_BOOTSTRAP_ROOT, DAIMON_GATEWAY_CONFIG, DAIMON_GATEWAY_KEY_TABLE } from "../runtime/daimon/gateway.js";
import { daimonGatewayedSubscriptionRealms } from "../runtime/daimon/subscriptionRealms.js";
import type { RuntimeTargetPlan } from "./containerArtifactsTypes.js";
import {
  DAIMON_GATEWAY_UID,
  renderDaimonGatewayLaunch,
  renderDaimonGatewayProvisioning,
  renderDaimonGatewayRuntimeEnv,
  renderDaimonGatewaySidecarScript,
  resolveDaimonGatewayRealmPaths
} from "./containerDaimonGatewayRender.js";
import { renderDaimonUidEntrypoint } from "./containerDaimonUidEntrypointRender.js";

const execFile = promisify(execFileCallback);
const realm = DAIMON_CODEX_SUBSCRIPTION_REALM.durableMountPath;
const plan = (engines: Record<string, string>): RuntimeTargetPlan => {
  const portable = daimonGatewayedSubscriptionRealms(Object.values(engines));
  return {
    runtimeName: "daimon", runtimeRoot: "/opt/daimon", id: "gateway",
    engineByNodeId: engines, envFiles: [], modelAuthMethods: {}, modelSecretsRequired: [], targetFiles: [],
    instancePaths: { configPath: "/var/lib/spawnfile/instance/config.json", instanceRoot: "/var/lib/spawnfile/instance", workspacePath: "/var/lib/spawnfile/instance/workspace" },
    meta: { configFileName: "config.json", instancePaths: { configPathTemplate: "", workspacePathTemplate: "" }, standaloneBaseImage: "node:24", startCommand: [], systemDeps: [] },
    opaqueMountTargets: portable.opaqueMountTargets,
    persistentMounts: portable.persistentMounts.map(({ mountPath, ...mount }) => ({ ...mount, mount_path: mountPath, volume_name: "test-realm" }))
  };
};
const codex = plan({ "agent:writer": "codex", "agent:editor": "codex" });

describe("Daimon auth gateway placement", () => {
  it("places nothing for an organization without a gatewayed engine", () => {
    const agy = plan({ "agent:a": "agy" });
    expect(resolveDaimonGatewayRealmPaths([agy])).toEqual([]);
    expect(renderDaimonGatewayProvisioning([agy])).toEqual([]);
    expect(renderDaimonGatewayLaunch([agy], "/opt/daimon")).toEqual([]);
    expect(renderDaimonGatewayRuntimeEnv([agy])).toBe("");
    const entrypoint = renderDaimonUidEntrypoint([agy]);
    expect(entrypoint).not.toContain("gateway");
    expect(entrypoint).not.toContain("DAIMON_GATEWAY");
  });

  it("starts one gateway as its own uid and hands the runtime a URL and this start's key", () => {
    const entrypoint = renderDaimonUidEntrypoint([codex], [realm]);
    expect(entrypoint).toContain(`for fixed_uid in 2000 2100 ${DAIMON_GATEWAY_UID} `);
    expect(entrypoint).toContain(`setpriv --clear-groups --reuid ${DAIMON_GATEWAY_UID} --regid ${DAIMON_GATEWAY_UID} --inh-caps=-all --ambient-caps=-all --bounding-set=-all -- env -i PATH="$PATH" HOME=/nonexistent LANG=C.UTF-8 /opt/daimon/bin/daimon-runtime gateway --config ${DAIMON_GATEWAY_CONFIG} &`);
    expect(entrypoint).toContain(`wait_for_broker_identity "$gateway_pid" ${DAIMON_GATEWAY_UID} 0000000000000000 "auth gateway"`);
    expect(entrypoint).toContain('DAIMON_GATEWAY_URL="$daimon_gateway_url" DAIMON_GATEWAY_KEY="$daimon_gateway_key" setpriv --clear-groups --reuid "$uid"');
    expect(entrypoint).toContain('watch_pids+=("$gateway_pid")');
    expect(entrypoint).toContain(`! test -r ${realm} && ! test -x ${realm}`);
    expect(entrypoint).toContain(`! test -r ${DAIMON_GATEWAY_BOOTSTRAP_ROOT}`);
    // The realm is never handed to the organization uid, and no key is compiled in.
    expect(entrypoint).not.toMatch(/[0-9a-f]{64}/u);
    expect(entrypoint.indexOf("SPAWNFILE_DAIMON_GATEWAY_PROVISION")).toBeLessThan(entrypoint.indexOf("gateway --config"));
    expect(entrypoint.indexOf("gateway --config")).toBeLessThan(entrypoint.indexOf('DAIMON_GATEWAY_URL="$daimon_gateway_url" DAIMON_GATEWAY_KEY="$daimon_gateway_key" setpriv'));
  });

  it("boots against an external gateway supplied at boot: no provisioning, no local gateway, the same agent contract", async () => {
    const script = [...renderDaimonGatewayProvisioning([codex]), ...renderDaimonGatewayLaunch([codex], "/opt/daimon"),
      'printf "external=%s url=%s key=%s\\n" "$daimon_gateway_external" "$daimon_gateway_url" "$daimon_gateway_key"',
      'env | grep "^DAIMON_GATEWAY" || echo unexported'].join("\n");
    const external = await execFile("bash", ["-ceu", script], { env: { PATH: process.env.PATH, DAIMON_GATEWAY_URL: "http://gw:43200", DAIMON_GATEWAY_KEY: "k".repeat(32) } });
    // Neither the key generation, the state provisioning nor the gateway launch ran (each needs root and Linux).
    expect(external.stdout).toBe(`external=1 url=http://gw:43200 key=${"k".repeat(32)}\nunexported\n`);
    await expect(execFile("bash", ["-ceu", script], { env: { PATH: process.env.PATH, DAIMON_GATEWAY_URL: "http://gw:43200" } }))
      .rejects.toThrow("DAIMON_GATEWAY_KEY must accompany DAIMON_GATEWAY_URL");
    const entrypoint = renderDaimonUidEntrypoint([codex], [realm], undefined, codex.persistentMounts);
    expect(entrypoint).toContain('[ -n "${DAIMON_GATEWAY_URL:-}" ] || require_backed_mount \'daimon-codex-subscription-realm\'');
    expect(entrypoint).toContain('[ -z "${gateway_pid:-}" ] || watch_pids+=("$gateway_pid")');
  });

  it("renders the training sidecar: the same state provisioning bound to its network, with the run key supplied and unset", () => {
    const script = renderDaimonGatewaySidecarScript(["codex", "agy"], "/opt/daimon");
    expect(script).toContain('daimon_gateway_key=${SPAWNFILE_DAIMON_GATEWAY_KEY:?the gateway sidecar needs its run key}\nunset SPAWNFILE_DAIMON_GATEWAY_KEY');
    expect(script).toContain('\\"host\\":\\"0.0.0.0\\"');
    // Only the sidecar forwards the test-only forced-refresh hook, and only when the run sets it.
    expect(script).toContain(`exec setpriv --clear-groups --reuid ${DAIMON_GATEWAY_UID} --regid ${DAIMON_GATEWAY_UID} --inh-caps=-all --ambient-caps=-all --bounding-set=-all -- env -i PATH="$PATH" HOME=/nonexistent LANG=C.UTF-8 DAIMON_GATEWAY_TEST_FORCE_REFRESH="\${DAIMON_GATEWAY_TEST_FORCE_REFRESH:-}" /opt/daimon/bin/daimon-runtime gateway --config ${DAIMON_GATEWAY_CONFIG}`);
    expect(script.indexOf("SPAWNFILE_DAIMON_GATEWAY_PROVISION")).toBeLessThan(script.indexOf("unset daimon_gateway_key"));
    expect(script).not.toMatch(/[0-9a-f]{64}/u);
    expect(() => renderDaimonGatewaySidecarScript(["agy"], "/opt/daimon")).toThrow("gatewayed engine");
  });

  it("gateways a brokered realm too: one org key for both engines, the broker launched after the gateway with that key", () => {
    const instance = "/var/lib/spawnfile/instances/daimon/daimon-organization";
    const mixed = { ...plan({ "agent:writer": "codex", "agent:scout": "grok" }), runtimeRoot: "/opt/daimon",
      instancePaths: { configPath: `${instance}/daimon/config.json`, instanceRoot: instance, workspacePath: `${instance}/workspace` },
      grokModelByNodeId: { "agent:scout": { model: "grok-4.6", reasoningEffort: "low" } } } as RuntimeTargetPlan;
    expect(resolveDaimonGatewayRealmPaths([mixed])).toEqual([realm, "/var/lib/spawnfile/daimon/gateway-grok-subscription-realm"]);
    const provisioning = renderDaimonGatewayProvisioning([mixed]).join("\n");
    expect(provisioning).toContain('engines: ["codex","grok"]');
    // Against an external gateway the worker's masked gateway paths still exist, as empty root-only directories.
    const external = provisioning.slice(0, provisioning.indexOf("else"));
    for (const target of ["/etc/daimon-gateway", "/run/daimon-gateway", "/var/lib/spawnfile/daimon/gateway-bootstrap", "/var/lib/spawnfile/daimon/gateway-grok-subscription-realm"]) {
      expect(external).toContain(`if [ ! -e ${target} ]; then install -d -o root -g root -m 0700 ${target}; fi`);
    }
    expect(provisioning).toContain('\\"grok\\":{\\"realm_path\\":\\"/var/lib/spawnfile/daimon/gateway-grok-subscription-realm\\",\\"bootstrap_path\\":\\"/run/daimon-gateway/grok-bootstrap-auth\\",\\"command\\":\\"/usr/local/bin/grok\\",\\"scratch_path\\":\\"/run/daimon-gateway/grok-refresh\\"}');
    const entrypoint = renderDaimonUidEntrypoint([mixed]);
    const gateway = entrypoint.indexOf("gateway --config");
    const broker = entrypoint.indexOf("engine-broker serve &");
    expect(gateway).toBeGreaterThan(0);
    expect(broker).toBeGreaterThan(gateway);
    expect(entrypoint).toContain('DAIMON_GATEWAY_URL="$daimon_gateway_url" DAIMON_GATEWAY_KEY="$daimon_gateway_key" \'/opt/daimon/bin/daimon-runtime\' engine-broker serve &');
    expect(entrypoint).toContain("--reuid 2100 --regid 2100 --inh-caps=-all --ambient-caps=-all --bounding-set=-all -- bash -ceu '! test -r /var/lib/spawnfile/daimon/gateway-grok-subscription-realm");
    expect(entrypoint).not.toContain("readSecure(bootstrap");
  });

  it("provisions realm, key table and bootstrap copy so only the gateway uid can read them", async () => {
    const lines = renderDaimonGatewayProvisioning([codex]);
    const volume = `spawnfile-gateway-realm-${process.pid}-${Date.now().toString(36)}`;
    const mount = `${DAIMON_GATEWAY_BOOTSTRAP_ROOT}/${path.posix.basename(DAIMON_CODEX_SUBSCRIPTION_REALM.bootstrapMountPath)}`;
    // Synthetic, never a real login; staged as the host leaf would arrive (organization-owned, 0600).
    const leaf = JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "synthetic", refresh_token: "synthetic" } });
    const stage = [`mkdir -p ${DAIMON_GATEWAY_BOOTSTRAP_ROOT}`, `printf '%s' '${leaf}' > ${mount}`, `chmod 600 ${mount}`, `chown 2000:2000 ${mount}`];
    const drop = (uid: number) => `setpriv --clear-groups --reuid ${uid} --regid ${uid} --inh-caps=-all --ambient-caps=-all --bounding-set=-all --`;
    const run = (script: string[]) => execFile("docker", [
      "run", "--rm", "--network", "none", "--cap-drop=ALL", "--cap-add=CHOWN", "--cap-add=DAC_READ_SEARCH", "--cap-add=SETUID", "--cap-add=SETGID",
      "--security-opt=no-new-privileges:true", "--mount", `type=volume,source=${volume},target=${realm}`,
      "node:24-bookworm-slim", "bash", "-ceu", script.join("\n")
    ], { timeout: 60_000 });
    try {
      await execFile("docker", ["volume", "create", volume]);
      const report = [
        `printf 'realm=%s table=%s copy=%s\\n' "$(stat -c '%u:%g:%a' ${realm})" "$(stat -c '%u:%g:%a' ${DAIMON_GATEWAY_KEY_TABLE})" "$(stat -c '%u:%g:%a' /run/daimon-gateway/codex-bootstrap-auth)"`,
        `${drop(2000)} bash -ceu '! test -r ${realm} && ! test -r ${mount} && ! test -r ${DAIMON_GATEWAY_KEY_TABLE} && ! test -r /run/daimon-gateway/codex-bootstrap-auth' && echo agent-blocked`,
        `${drop(DAIMON_GATEWAY_UID)} bash -ceu 'test -r ${DAIMON_GATEWAY_KEY_TABLE} && test -r /run/daimon-gateway/codex-bootstrap-auth && test -w ${realm}' && echo gateway-reads`,
        `node -e 'const t = JSON.parse(require("fs").readFileSync("${DAIMON_GATEWAY_KEY_TABLE}", "utf8")); console.log("digest=" + Object.keys(t.keys)[0])'`
      ];
      const first = await run([...stage, `printf preserved > ${realm}/auth.json`, `chmod 600 ${realm}/auth.json`, `chown 2000:2000 ${realm}/auth.json ${realm}`, ...lines, ...report, `cat ${realm}/auth.json; echo`]);
      expect(first.stdout).toContain(`realm=${DAIMON_GATEWAY_UID}:${DAIMON_GATEWAY_UID}:700 table=0:${DAIMON_GATEWAY_UID}:440 copy=${DAIMON_GATEWAY_UID}:${DAIMON_GATEWAY_UID}:600`);
      expect(first.stdout).toContain("agent-blocked");
      expect(first.stdout).toContain("gateway-reads");
      expect(first.stdout).toContain("preserved");
      const restart = await run([...stage, ...lines, ...report]);
      expect(restart.stdout).toContain(`realm=${DAIMON_GATEWAY_UID}:${DAIMON_GATEWAY_UID}:700`);
      const digest = (stdout: string) => /digest=([0-9a-f]{64})/u.exec(stdout)?.[1];
      expect(digest(first.stdout)).toBeDefined();
      expect(digest(restart.stdout)).not.toBe(digest(first.stdout));
    } finally {
      await execFile("docker", ["volume", "rm", "--force", volume]).catch(() => undefined);
    }
  }, 120_000);
});
