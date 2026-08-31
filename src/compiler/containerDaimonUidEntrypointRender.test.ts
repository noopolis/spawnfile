import { describe, expect, it, vi } from "vitest";
import { execFile as execFileCallback, spawnSync } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import type { RuntimeTargetPlan } from "./containerArtifactsTypes.js";
import type { EntrypointOptions } from "./containerEntrypointRender.js";
import { renderEntrypoint } from "./containerEntrypointRender.js";
import { DAIMON_GROK_TURN_USAGE_LEDGER } from "../runtime/daimon/contractManifest.js";
import { DAIMON_WAKE_FUSE_DIRECTORY } from "../runtime/daimon/config.js";
import {
  DAIMON_AUTHORIZED_UID_ENV,
  DAIMON_BROKER_STARTUP_TIMEOUT_SECONDS,
  renderDaimonBrokerSocketWait,
  renderDaimonUidEntrypoint,
  resolveDaimonVolumeIdentityFiles,
  resolveDaimonUidEntrypointOwnershipPlan,
  resolveDaimonUidEntrypointStateRoots
} from "./containerDaimonUidEntrypointRender.js";

const execFile = promisify(execFileCallback);
const authorizedUid = 2000;

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
const codexEngineHome = "/var/lib/spawnfile/instances/daimon/daimon-organization/runtime-homes/codex-one/.codex";
const grokEngineHome = "/var/lib/spawnfile/instances/daimon/daimon-organization/runtime-homes/grok-two/.grok";

describe("Daimon broker socket startup wait", () => {
  const nodeSocketServer = `const net=require("node:net");const socket=process.argv[1];const delay=Number(process.argv[2]);setTimeout(()=>{const server=net.createServer();server.listen(socket,()=>setTimeout(()=>server.close(),500));},delay);`;

  it("uses the production cold-start budget and remains fail-fast and bounded", async () => {
    expect(DAIMON_BROKER_STARTUP_TIMEOUT_SECONDS).toBe(60);
    const root = await mkdtemp(path.join(os.tmpdir(), "spawnfile-broker-wait-"));
    const waitProgram = renderDaimonBrokerSocketWait(2, 0.02).join("\n");
    const delayedSocket = path.join(root, "delayed.sock");
    await expect(execFile("bash", ["-ceu", `${waitProgram}\nnode -e "$0" "$1" 120 & child=$!\nwait_for_broker_socket "$1" "$child" delayed\nkill "$child" 2>/dev/null || true\nwait "$child" 2>/dev/null || true`, nodeSocketServer, delayedSocket])).resolves.toBeDefined();

    const earlyStarted = Date.now();
    await expect(execFile("bash", ["-ceu", `${waitProgram}\nnode -e 'process.exit(7)' & child=$!\nwait_for_broker_socket "$1" "$child" early`, "", path.join(root, "early.sock")])).rejects.toThrow(/early exited before readiness \(status 7\)/u);
    expect(Date.now() - earlyStarted).toBeLessThan(1_000);

    const timeoutStarted = Date.now();
    await expect(execFile("bash", ["-ceu", `${renderDaimonBrokerSocketWait(1, 0.02).join("\n")}\nsleep 5 & child=$!\ntrap 'kill "$child" 2>/dev/null || true' EXIT\nwait_for_broker_socket "$1" "$child" never`, "", path.join(root, "never.sock")])).rejects.toThrow(/never readiness timed out after 1s/u);
    expect(Date.now() - timeoutStarted).toBeLessThan(2_500);
    await rm(root, { recursive: true, force: true });
  });

  it("waits for the exact post-drop process identity within the shared budget", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "spawnfile-broker-identity-"));
    const waitProgram = renderDaimonBrokerSocketWait(2, 0.02).join("\n");
    const delayed = `${waitProgram}\nbroker_process_status_root="$1"\nsleep 5 & child=$!\ntrap 'kill "$child" 2>/dev/null || true' EXIT\nmkdir -p "$1/$child"\nprintf 'Uid:\\t0\\nCapBnd:\\t00000000000000c1\\n' > "$1/$child/status"\n(sleep 0.12; printf 'Uid:\\t2100\\nCapBnd:\\t0000000000000000\\n' > "$1/$child/status") &\nwait_for_broker_identity "$child" 2100 0000000000000000 relay`;
    await expect(execFile("bash", ["-ceu", delayed, "", root])).resolves.toBeDefined();

    const never = `${renderDaimonBrokerSocketWait(1, 0.02).join("\n")}\nbroker_process_status_root="$1"\nsleep 5 & child=$!\ntrap 'kill "$child" 2>/dev/null || true' EXIT\nmkdir -p "$1/$child"\nprintf 'Uid:\\t0\\nCapBnd:\\t00000000000000c1\\n' > "$1/$child/status"\nwait_for_broker_identity "$child" 2100 0000000000000000 relay`;
    await expect(execFile("bash", ["-ceu", never, "", root])).rejects.toThrow(/relay identity readiness timed out after 1s/u);

    const exited = `${waitProgram}\nbroker_process_status_root="$1"\nnode -e 'process.exit(9)' & child=$!\nwait_for_broker_identity "$child" 2100 0000000000000000 relay`;
    await expect(execFile("bash", ["-ceu", exited, "", root])).rejects.toThrow(/relay exited before identity readiness \(status 9\)/u);
    await rm(root, { recursive: true, force: true });
  });
});
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

describe("renderDaimonUidEntrypoint", () => {
  it("deduplicates shared declared volume anchors and rejects conflicting or escaping identity metadata",()=>{const path="/var/lib/spawnfile/resources/teams/example/shared/.spawnfile-resource-identity",base={...daimonPlan,resources:[{id:"shared",kind:"volume",linkPath:"/workspace/shared",backingPath:"/var/lib/spawnfile/resources/teams/example/shared",mount:"./shared",mode:"mutable",sharing:"team",replacementSentinel:path,resolvedIdentity:`sha256:${"a".repeat(64)}`} as NonNullable<RuntimeTargetPlan["resources"]>[number]&{replacementSentinel:string;resolvedIdentity:string}]};expect(resolveDaimonVolumeIdentityFiles([base,base])).toEqual([{path,identity:`sha256:${"a".repeat(64)}`}]);const conflict={...base,resources:[{...base.resources[0]!,resolvedIdentity:`sha256:${"b".repeat(64)}`} ]};expect(()=>resolveDaimonVolumeIdentityFiles([base,conflict])).toThrow(/conflicting compiler-authored volume identity anchor/u);const invalidRoots=["/var/lib/spawnfile/resources/../../etc","/var/lib/spawnfile/resources","/var/lib/spawnfile/resources/"];for(const backingPath of invalidRoots){const invalid={...base,resources:[{...base.resources[0]!,backingPath,replacementSentinel:`${backingPath}/.spawnfile-resource-identity`} ]};expect(()=>resolveDaimonVolumeIdentityFiles([invalid])).toThrow(/invalid compiler-authored volume identity anchor/u);}});
  it("secures the durable organization acceptance store for the authorized runtime UID", () => {
    const ownership = resolveDaimonUidEntrypointOwnershipPlan(
      [{ ...daimonPlan, persistentMounts: [acceptanceStoreMount] }],
      [acceptanceStore]
    );

    expect(ownership.privateModeDirectories).toContain(acceptanceStore);
    expect(ownership.stateRoots).toContain(acceptanceStore);
  });

  it("secures compiler-authored Daimon receipt follower directories", () => {
    const receiptPath = "/var/lib/spawnfile/moltnet/networks/local/daimon-receipts/relay-agent.json";
    const ownership = resolveDaimonUidEntrypointOwnershipPlan(
      [daimonPlan],
      ["/var/lib/spawnfile/moltnet/networks/local"],
      { ...moltnetPlans, nodePlans: [{ ...moltnetPlans.nodePlans[0]!, receiptStorePath: receiptPath }] }
    );

    expect(ownership.privateModeDirectories).toContain(path.posix.dirname(receiptPath));
    expect(ownership.privateDirectories).toContain(path.posix.dirname(receiptPath));
    expect(ownership.creatablePrivateDirectories).toEqual([
      { anchor: "/var/lib/spawnfile/moltnet/networks/local", target: path.posix.dirname(receiptPath) },
      { anchor: "/run", target: "/run/spawnfile/moltnet-readiness" }
    ]);
    expect(ownership.stateRoots).toContain("/var/lib/spawnfile/moltnet/networks/local");
  });

  it("reowns only compiler-authored state, skips opaque mounts, and drops every capability before the existing entrypoint", () => {
    const volumeRoot="/var/lib/spawnfile/resources/teams/example/shared",volumeSentinel=`${volumeRoot}/.spawnfile-resource-identity`,volumeIdentity="sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const rendered = renderDaimonUidEntrypoint(
      [{ ...daimonPlan, persistentMounts: [
        agyRealmMount, agyRuntimeHomeMount, codexEngineHomeMount, grokEngineHomeMount
      ],resources:[{id:"shared",kind:"volume",linkPath:"/var/lib/spawnfile/instances/daimon/daimon-organization/workspace/shared",backingPath:volumeRoot,mount:"./shared",mode:"mutable",sharing:"team",replacementSentinel:volumeSentinel,resolvedIdentity:volumeIdentity} as NonNullable<RuntimeTargetPlan["resources"]>[number]&{replacementSentinel:string;resolvedIdentity:string}] }],
      [agyRealm, agyRuntimeHome, codexEngineHome, grokEngineHome, volumeRoot,"/var/lib/spawnfile/daimon-state"],
      moltnetPlans
    );

    expect(rendered).toContain("uid=2000");
    expect(rendered).toContain("for fixed_uid in 2000 2100 2200");
    expect(rendered).toContain("Buffer.alloc(692)");
    expect(rendered).toContain("/etc/daimon-engine-broker/registrations.bin");
    expect(rendered).toContain("http://127.0.0.1:43123/v1");
    expect(rendered).toContain("http://127.0.0.1:43124/mcp");
    expect(rendered).toContain("DAIMON_MCP_CAPABILITY");
    expect(rendered).toContain("/var/lib/daimon-workers/2200");
    expect(rendered).toContain("/var/lib/daimon-workers/");
    // Grok refuses a profile that is a symlink or carries a hard-link alias, so it is an
    // unaliased file in the worker's own read-only .grok directory.
    expect(rendered).toContain("ensureExactFile(profilePath, profileFor(entry), 0, 0, 0o444)");
    expect(rendered).not.toContain("ensureExactLink");
    expect(rendered).toContain("sandbox-events.jsonl");
    expect(rendered).toContain("restrict_network = true");
    expect(rendered).toContain("fs.chmodSync(target, 0o750)");
    expect(rendered).toContain("fs.chmodSync(target, 0o640)");
    expect(rendered).toContain("unsafe worker workspace link");
    expect(rendered).toContain("resourceByLink.get(target)");
    expect(rendered).toContain("raw !== resource.backingPath");
    expect(rendered).toContain('!raw.startsWith("/var/lib/spawnfile/resources/")');
    expect(rendered).toContain("volumeIdentityPaths.has(childPath)");
    expect(rendered).toContain(JSON.stringify({path:volumeSentinel,identity:volumeIdentity}));
    expect(rendered).toContain("before.nlink !== 1");
    expect(rendered).toContain("constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK");
    const recovery=rendered.indexOf("if (hasMarker)");const durableSentinel=rendered.indexOf("fs.fsyncSync(sentinel)",recovery),durableParent=rendered.indexOf("fs.fsyncSync(parent)",durableSentinel),removeMarker=rendered.indexOf("fs.unlinkSync",durableParent),durableRemoval=rendered.indexOf("fs.fsyncSync(parent)",removeMarker);expect(recovery).toBeGreaterThan(-1);expect(durableSentinel).toBeGreaterThan(recovery);expect(durableParent).toBeGreaterThan(durableSentinel);expect(removeMarker).toBeGreaterThan(durableParent);expect(durableRemoval).toBeGreaterThan(removeMarker);
    expect(rendered).toContain("validateResourceLink(target, info); return;");
    expect(rendered).toContain("worker runtime file identity mismatch");
    expect(rendered).toContain("worker runtime file identity mismatch");
    expect(rendered).toContain("ensureEventsFile(eventsPath, entry.uid)");
    expect(rendered).toContain("noopolis.daimon.engine-broker-service.v1");
    expect(rendered).toContain("/etc/daimon-engine-broker/service.json");
    expect(rendered).toContain("readSecure(bootstrap, undefined, 'bootstrap')");
    expect(rendered).toContain("noopolis.daimon.broker-credential-journal.v1");
    expect(rendered).toContain("journal.state === 'stale'");
    expect(rendered).toContain("bootstrapDigest === journal.sourceDigest");
    expect(rendered).toContain("generation: journal.generation + 1");
    expect(rendered).toContain("state: 'promoted'");
    expect(rendered).toContain("bootstrapBytes.fill(0)");
    expect(rendered).toContain("ensureExactFile(profilePath, profileFor(entry), 0, 0, 0o444)");
    expect(rendered).toContain("--bounding-set=-all,+chown,+setuid,+setgid -- '/opt/daimon/bin/daimon-engine-broker' &");
    expect(rendered).toContain("--bounding-set=-all,+chown,+setuid,+setgid,+setpcap -- '/opt/daimon/bin/daimon-engine-broker' --relay &");
    expect(rendered).toContain('"$relay_pid:2100:0000000000000000"');
    expect(rendered).toContain('expected_caps=${rest##*:}');
    expect(rendered).toContain("--reuid 2100 --regid 2100");
    expect(rendered).toContain("engine-broker serve &");
    expect(rendered).toContain("broker_startup_timeout_seconds=60");
    expect(rendered).toContain("wait_for_broker_socket '/run/daimon-engine-broker/backend.sock'");
    expect(rendered).toContain('wait_for_broker_identity "$relay_pid" 2100 0000000000000000');
    expect(rendered).toContain("broker_startup_started=$SECONDS");
    expect(rendered).toContain("startup_children+=(\"$broker_pid\")");
    expect(rendered).toContain("trap cleanup_broker_startup EXIT");
    expect(rendered).not.toContain("seq 1 100");
    expect(rendered).toContain("/run/daimon-engine-broker/backend.sock");
    expect(rendered).toContain("/run/daimon-engine-broker/launcher.sock");
    expect(rendered).toContain('wait -n -p finished_pid "${watch_pids[@]}"');
    expect(rendered).toContain("finished_pid=");
    expect(rendered).toContain('${finished_pid:-}');
    expect(rendered).toContain("[ -S '/run/daimon-engine-broker/control.sock' ]");
    expect(rendered).not.toMatch(/0\.0\.0\.0:4312[34]/u);
    expect(rendered).toContain("runtime-homes/codex-one/.daimon-inbound/codex-auth");
    expect(rendered).not.toContain("runtime-homes/grok-two/.daimon-inbound/grok-auth");
    expect(rendered).toContain("/var/lib/spawnfile/daimon/agy-unlock-secret");
    expect(rendered).not.toContain("runtime-homes/agy/.daimon-inbound/agy-auth");
    expect(rendered).toContain("const opaquePaths = new Set(");
    expect(rendered).toContain(
      `const opaqueDescendantRoots = new Set(["${codexEngineHome}","${grokEngineHome}"]);`
    );
    expect(rendered).toContain(
      "opaquePaths.has(childPath) || opaqueDescendantRoots.has(childPath)"
    );
    expect(rendered).toContain("constants.O_NOFOLLOW");
    expect(rendered).toContain("fs.fchownSync");
    expect(rendered).toContain(`const privateFiles = ["${daimonPlan.instancePaths.configPath}","${nodeConfig}","${serverConfig}"];`);
    expect(rendered).toContain(
      `const privateModeDirectories = ["${agyRealm}","${daimonPlan.instancePaths.instanceRoot}/daimon","${agyRuntimeHome}","${codexEngineHome}","${grokEngineHome}"];`
    );
    expect(rendered).toContain("for (const target of privateDirectories)");
    expect(rendered).toContain("for (const target of privateModeDirectories)");
    expect(rendered).toContain("for (const target of privateFiles)");
    expect(rendered).toContain("const securePrivateDirectory = (fd) => {");
    expect(rendered).toContain("for (const target of ['/var', '/var/lib']) secureFixedTraversalAncestor(target)");
    expect(rendered).toContain("secureSharedStateAncestor('/var/lib/spawnfile')");
    expect(rendered).toContain("info.uid === 0 && info.gid === 0 && mode === 0o711");
    expect(rendered).toContain("info.uid === uid && info.gid === uid && mode === 0o700");
    expect(rendered).toContain("mode !== 0o775 && mode !== 0o755 && mode !== 0o711");
    expect(rendered).toContain("shared state ancestor has an unexpected preimage");
    expect(rendered).toContain("probe=/var/lib/spawnfile/daimon/grok-subscription-realm/.daimon-ancestry-probe");
    expect(rendered).toContain("--reuid 2000 --regid 2000");
    expect(rendered).toContain("--reuid 2200 --regid 2200");
    expect(rendered).toContain("info.uid !== 0 || info.gid !== 0");
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
      [{ ...daimonPlan, persistentMounts: [
        agyRealmMount, agyRuntimeHomeMount, codexEngineHomeMount, grokEngineHomeMount
      ] }],
      [agyRealm, agyRuntimeHome, codexEngineHome, grokEngineHome, causalState, "/external-state"],
      moltnetPlans
    )).toEqual({
      creatablePrivateDirectories: [
        { anchor: "/run", target: "/run/spawnfile/moltnet-readiness" }
      ],
      opaqueDescendantRoots: [codexEngineHome, grokEngineHome],
      privateDirectories: [
        "/var/lib/spawnfile/daimon",
        agyRealm,
        "/var/lib/spawnfile/instances",
        "/var/lib/spawnfile/instances/daimon",
        "/var/lib/spawnfile/instances/daimon/daimon-organization",
        "/var/lib/spawnfile/instances/daimon/daimon-organization/daimon",
        "/var/lib/spawnfile/instances/daimon/daimon-organization/runtime-homes",
        agyRuntimeHome,
        "/var/lib/spawnfile/instances/daimon/daimon-organization/workspace",
        "/var/lib/spawnfile/moltnet",
        "/var/lib/spawnfile/moltnet/nodes",
        "/var/lib/spawnfile/moltnet/servers",
        "/var/lib/spawnfile/moltnet/servers/local",
        causalState
      ],
      privateFiles: [daimonPlan.instancePaths.configPath, nodeConfig, serverConfig],
      privateModeDirectories: [
        agyRealm,
        "/var/lib/spawnfile/instances/daimon/daimon-organization/daimon",
        agyRuntimeHome,
        codexEngineHome,
        grokEngineHome
      ],
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
    expect(rendered).toContain("const opaqueDescendantRoots = new Set([]);");
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

  it("excludes the usage ledger directory from state_roots while keeping it a persistent mount", () => {
    const usageDirectory = DAIMON_GROK_TURN_USAGE_LEDGER.directoryPath;
    const usageMount = {
      id: "daimon-grok-usage-ledger",
      mount_path: usageDirectory,
      reason: "Daimon per-turn engine usage ledger",
      volume_name: "spawnfile-test-grok-usage-ledger"
    };
    const ownership = resolveDaimonUidEntrypointOwnershipPlan(
      [{ ...daimonPlan, persistentMounts: [usageMount] }],
      [usageDirectory]
    );

    // Mutation-critical: deleting the state_roots exclusion for the usage
    // ledger directory must turn this assertion red.
    expect(ownership.stateRoots).not.toContain(usageDirectory);

    const rendered = renderDaimonUidEntrypoint(
      [{ ...daimonPlan, persistentMounts: [usageMount] }],
      [usageDirectory]
    );
    expect(rendered).not.toContain(`state_roots=('${usageDirectory}')`);
  });

  it("provisions the usage ledger directory and probes it for write access on every boot", () => {
    const usageDirectory = DAIMON_GROK_TURN_USAGE_LEDGER.directoryPath;
    const rendered = renderDaimonUidEntrypoint([daimonPlan]);

    // The broker (2100) writes turn usage; the daimon host (2000) must group-read it or
    // the wake fuse trips ledger_unavailable and the organization accepts no wake at all.
    expect(rendered).toContain(`install -d -o 2100 -g 2000 -m 0750 '${usageDirectory}'`);
    expect(rendered).toContain(
      `--reuid 2100 --regid 2100 --inh-caps=-all --ambient-caps=-all --bounding-set=-all -- bash -ceu 'probe=${usageDirectory}/.daimon-usage-probe; umask 027; : > "$probe"; rm "$probe"'`
    );
  });

  it("provisions the wake-fuse directory for the organization identity", () => {
    const ownership = resolveDaimonUidEntrypointOwnershipPlan(
      [{ ...daimonPlan, persistentMounts: [{
        id: "daimon-wake-fuse",
        mount_path: DAIMON_WAKE_FUSE_DIRECTORY,
        reason: "Daimon durable wake-fuse admission ledger",
        volume_name: "spawnfile-test-wake-fuse"
      }] }],
      [DAIMON_WAKE_FUSE_DIRECTORY]
    );
    expect(ownership.stateRoots).not.toContain(DAIMON_WAKE_FUSE_DIRECTORY);

    const rendered = renderDaimonUidEntrypoint([daimonPlan]);

    // Mutation-critical: changing either owner identity or the private mode
    // must turn this assertion red.
    expect(rendered).toContain(
      `chown 0:0 '${DAIMON_WAKE_FUSE_DIRECTORY}' && chmod 0700 '${DAIMON_WAKE_FUSE_DIRECTORY}' && chown 2000:2000 '${DAIMON_WAKE_FUSE_DIRECTORY}'`
    );
  });

});
