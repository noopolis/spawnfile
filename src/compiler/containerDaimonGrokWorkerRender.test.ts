import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { DAIMON_GROK_ENGINE_BROKER, DAIMON_GROK_TURN_USAGE_LEDGER } from "../runtime/daimon/contractManifest.js";
import { DAIMON_GROK_WORKER_CONFIG_BYTES } from "../runtime/daimon/grokWorkerConfigBytes.js";
import type { RuntimeTargetPlan } from "./containerArtifactsTypes.js";
import {
  assertCanonicalRegisteredPath,
  daimonGrokAcceptanceStoreDenyPath,
  DAIMON_GROK_OPTIONAL_DENY_PATHS,
  renderDaimonGrokServiceConfig,
  resolveDaimonGrokRegistrations
} from "./containerDaimonGrokWorkerRender.js";

const INSTANCE = "/var/lib/spawnfile/instances/daimon/daimon-organization";
const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

const grokWorkerPlan = (
  engines: Record<string, string>,
  models: Record<string, { model: string; reasoningEffort: string }> = Object.fromEntries(
    Object.entries(engines).filter(([, engine]) => engine === "grok").map(([id]) => [id, { model: "grok-4.6", reasoningEffort: "low" }])
  )
): RuntimeTargetPlan => ({
  engineByNodeId: engines,
  grokModelByNodeId: models,
  instancePaths: { configPath: `${INSTANCE}/daimon/daimon-organization-runtime.json`, instanceRoot: INSTANCE, workspacePath: `${INSTANCE}/workspace` },
  runtimeName: "daimon"
}) as unknown as RuntimeTargetPlan;

/**
 * The broker enforces the registration's limits and refuses a wake that tries to raise them, so an
 * organization that needs a longer turn has to declare it here. Undeclared agents must keep the
 * contract defaults exactly, or every existing organization's budget moves without a declaration.
 */
describe("Daimon Grok registration turn limits", () => {
  const plan = (limits?: Record<string, { maxRequests?: number; maxTokens?: number; timeoutMs?: number }>): RuntimeTargetPlan => ({
    ...grokWorkerPlan({ "agent:a": "grok", "agent:b": "grok" }),
    ...(limits === undefined ? {} : { grokTurnLimitsByNodeId: limits })
  }) as RuntimeTargetPlan;

  it("carries a declared budget into the registration and the service config", () => {
    const declared = { "agent:a": { maxTokens: 1_100_000, timeoutMs: 900_000 } };
    const registrations = resolveDaimonGrokRegistrations([plan(declared)]);
    const a = registrations.find((entry) => entry.agentId === "agent:a");
    const b = registrations.find((entry) => entry.agentId === "agent:b");
    expect(a?.limits).toEqual({ ...DAIMON_GROK_ENGINE_BROKER.turnLimits.v1Defaults, maxTokens: 1_100_000, timeoutMs: 900_000 });
    expect(b?.limits).toEqual(DAIMON_GROK_ENGINE_BROKER.turnLimits.v1Defaults);
    const service = renderDaimonGrokServiceConfig(registrations);
    const rendered = service.registrations.find((entry) => entry.agentId === "agent:a");
    expect(rendered?.limits).toEqual({ ...DAIMON_GROK_ENGINE_BROKER.turnLimits.v1Defaults, maxTokens: 1_100_000, timeoutMs: 900_000 });
  });

  it("keeps the contract defaults when nothing is declared", () => {
    for (const entry of resolveDaimonGrokRegistrations([plan()])) {
      expect(entry.limits).toEqual(DAIMON_GROK_ENGINE_BROKER.turnLimits.v1Defaults);
    }
  });
});

describe("Daimon Grok worker registrations", () => {
  it("uses Daimon's pinned worker config bytes for each agent's declared model and reasoning effort", () => {
    const registrations = resolveDaimonGrokRegistrations([grokWorkerPlan({ "agent:a": "grok", "agent:b": "grok" }, {
      "agent:a": { model: "grok-4.6", reasoningEffort: "low" },
      "agent:b": { model: "grok-build", reasoningEffort: "high" }
    })]);
    expect(registrations.map((entry) => [entry.agentId, entry.uid, entry.home, entry.grokHome])).toEqual([
      ["agent:a", 2200, "/var/lib/daimon-workers/2200", "/var/lib/daimon-workers/2200/.grok"],
      ["agent:b", 2201, "/var/lib/daimon-workers/2201", "/var/lib/daimon-workers/2201/.grok"]
    ]);
    const [a, b] = registrations;
    expect(a!.config).toBe(DAIMON_GROK_WORKER_CONFIG_BYTES["grok-4.6"].low);
    expect(sha256(a!.config)).toBe(DAIMON_GROK_ENGINE_BROKER.worker.configSha256["grok-4.6"].low);
    expect(b!.config).toBe(DAIMON_GROK_WORKER_CONFIG_BYTES["grok-build"].high);
    expect(sha256(b!.config)).toBe(DAIMON_GROK_ENGINE_BROKER.worker.configSha256["grok-build"].high);
    expect(a!.config).not.toContain("auth_provider");
    expect(a!.profilePath).toBe("/var/lib/daimon-workers/2200/.grok/sandbox.toml");
    expect(a!.eventsPath).toBe("/var/lib/daimon-workers/2200/.grok/sessions/sandbox-events.jsonl");
  });

  it("refuses a Grok registration without a declared closed-list model and effort", () => {
    expect(() => resolveDaimonGrokRegistrations([grokWorkerPlan({ "agent:a": "grok" }, {})])).toThrow(/no declared broker model/u);
    const rootless = { ...grokWorkerPlan({ "agent:a": "grok" }), instancePaths: { configPath: "/c.json", workspacePath: "/w" } } as RuntimeTargetPlan;
    expect(() => resolveDaimonGrokRegistrations([rootless])).toThrow(/require an instance root/u);
    expect(() => resolveDaimonGrokRegistrations([grokWorkerPlan({ "agent:a": "grok" }, { "agent:a": { model: "grok-4", reasoningEffort: "low" } })])).toThrow(/no declared broker model/u);
    expect(() => resolveDaimonGrokRegistrations([grokWorkerPlan({ "agent:a": "grok" }, { "agent:a": { model: "grok-4.6", reasoningEffort: "xhigh" } })])).toThrow(/no declared broker model/u);
  });

  it("denies every realm, broker, ledger, secret, peer, and other-worker path, and never the worker's own", () => {
    const [a, b] = resolveDaimonGrokRegistrations([grokWorkerPlan({ "agent:a": "grok", "agent:b": "grok", "agent:c": "codex", "agent:d": "agy" })]);
    const denied = a!.denyPaths;
    expect(denied.length).toBeGreaterThan(0);
    expect(denied).toEqual(expect.arrayContaining([
      "/var/lib/spawnfile/daimon/grok-bootstrap-auth",
      "/var/lib/spawnfile/daimon/grok-subscription-realm",
      "/var/lib/spawnfile/daimon/agy-unlock-secret",
      "/var/lib/spawnfile/daimon/agy-subscription-realm",
      "/etc/daimon-engine-broker",
      "/run/daimon-engine-broker",
      DAIMON_GROK_TURN_USAGE_LEDGER.directoryPath,
      "/var/lib/spawnfile/daimon/wake-fuse",
      // The wake-acceptance store is masked through its private `state` parent: bubblewrap cannot
      // materialize a deny target under a directory the worker uid cannot search.
      `${INSTANCE}/state`,
      `${INSTANCE}/runtime-homes/b`, `${INSTANCE}/workspace/agents/b`,
      `${INSTANCE}/runtime-homes/c`, `${INSTANCE}/workspace/agents/c`,
      `${INSTANCE}/runtime-homes/d`, `${INSTANCE}/workspace/agents/d`,
      "/var/lib/daimon-workers/2201",
      ...DAIMON_GROK_OPTIONAL_DENY_PATHS
    ]));
    for (const own of [`${INSTANCE}/workspace/agents/a`, `${INSTANCE}/runtime-homes/a`, "/var/lib/daimon-workers/2200"]) expect(denied).not.toContain(own);
    expect(b!.denyPaths).toContain("/var/lib/daimon-workers/2200");
    expect(denied).toEqual([...denied].sort());
    for (const entry of denied) expect(denied.some((other) => entry.startsWith(`${other}/`))).toBe(false);
    expect(a!.profile).toBe(`[profiles.daimon-strict]\nextends = "strict"\nrestrict_network = true\ndeny = [${denied.map((entry) => JSON.stringify(entry)).join(", ")}]\n`);
    const soloDenied = resolveDaimonGrokRegistrations([grokWorkerPlan({ "agent:a": "grok" })])[0]!.denyPaths;
    expect(soloDenied).not.toContain("/var/lib/spawnfile/daimon/agy-subscription-realm");
    expect(soloDenied.length).toBeGreaterThan(8);
  });

  it("renders service.json v2 with per-slot ledger, limits, model, and the profile digest", () => {
    const registrations = resolveDaimonGrokRegistrations([grokWorkerPlan({ "agent:a": "grok" }, { "agent:a": { model: "grok-4.5", reasoningEffort: "medium" } })]);
    const service = renderDaimonGrokServiceConfig(registrations);
    expect(Object.keys(service)).toEqual(["version", "credentialHome", "turnStore", "registrations"]);
    expect(service.version).toBe("noopolis.daimon.engine-broker-service.v2");
    expect(service.registrations).toEqual([{
      agentId: "agent:a",
      slot: 0,
      workerUid: 2200,
      workspace: `${INSTANCE}/workspace/agents/a`,
      profilePath: "/var/lib/daimon-workers/2200/.grok/sandbox.toml",
      eventsPath: "/var/lib/daimon-workers/2200/.grok/sessions/sandbox-events.jsonl",
      profileSha256: sha256(registrations[0]!.profile),
      usageLedgerPath: DAIMON_GROK_TURN_USAGE_LEDGER.filePath,
      limits: { maxRequests: 32, maxTokens: 300_000, timeoutMs: 240_000 },
      model: { id: "grok-4.5", reasoningEffort: "medium" }
    }]);
  });
});

describe("Grok base-profile grant guard and nested-mask refusal", () => {
  const plan = (extra: Partial<RuntimeTargetPlan>): RuntimeTargetPlan => ({ ...grokWorkerPlan({ "agent:a": "grok", "agent:b": "grok" }), ...extra }) as RuntimeTargetPlan;
  const mount = (mount_path: string) => ({ id: mount_path, mount_path, reason: "test", volume_name: "v" });

  it("refuses a deny entry equal to or above a base-profile grant, and keeps entries below grants", () => {
    for (const grant of ["/run", "/var", "/tmp", "/var/tmp", "/etc"]) {
      expect(() => resolveDaimonGrokRegistrations([plan({ persistentMounts: [mount(grant)] })]), grant).toThrow(/base profile grant/u);
    }
    expect(() => resolveDaimonGrokRegistrations([plan({ persistentMounts: [mount("/var/lib/daimon-workers/2200/.grok/sessions")] })])).toThrow(/own workspace, home|base profile grant/u);
    const [a] = resolveDaimonGrokRegistrations([plan({})]);
    const grants = ["/bin", "/dev", "/etc", "/lib", "/proc", "/run", "/sbin", "/sys", "/tmp", "/usr", "/var", "/var/tmp", a!.workspace, a!.grokHome, `${a!.grokHome}/sessions`, `${a!.home}/tmp`];
    for (const entry of a!.denyPaths) {
      for (const grant of grants) expect(grant === entry || grant.startsWith(`${entry}/`), `${entry} vs ${grant}`).toBe(false);
    }
    expect(a!.denyPaths).toEqual(expect.arrayContaining(["/run/secrets", "/run/daimon-engine-broker"]));
  });

  it("refuses an added ancestor that would cover a Daimon deny entry, since masks cannot nest", () => {
    expect(() => resolveDaimonGrokRegistrations([plan({ persistentMounts: [mount("/var/lib/spawnfile/daimon")] })]))
      .toThrow(/would cover .*grok-bootstrap-auth; masks cannot nest/u);
  });

  it("masks the wake-acceptance store through its private parent, never the store itself", () => {
    // The `0700 2000:2000` state directory is unplaceable as an ancestor of a deny entry, so the mask
    // moves onto it. Declaring it again as a mount is the same path, not a nested one.
    const [a] = resolveDaimonGrokRegistrations([plan({})]);
    expect(a!.denyPaths).toContain(`${INSTANCE}/state`);
    expect(a!.denyPaths).not.toContain(`${INSTANCE}/state/wake-acceptance`);
    expect(daimonGrokAcceptanceStoreDenyPath(INSTANCE)).toBe(`${INSTANCE}/state`);
    const again = resolveDaimonGrokRegistrations([plan({ persistentMounts: [mount(`${INSTANCE}/state`)] })]);
    expect(again[0]!.denyPaths.filter((entry) => entry === `${INSTANCE}/state`)).toHaveLength(1);
  });
});

describe("canonical registered paths", () => {
  it("accepts only absolute canonical paths of at most 255 bytes", () => {
    expect(assertCanonicalRegisteredPath("home", "/var/lib/daimon-workers/2200")).toBe("/var/lib/daimon-workers/2200");
    for (const bad of ["relative/home", "/", "/var/lib/", "/var//lib", "/var/./lib", "/var/../lib", "/var/lib/.", `/${"a".repeat(255)}`]) {
      expect(() => assertCanonicalRegisteredPath("home", bad), bad).toThrow(/canonical registered path/u);
    }
    expect(assertCanonicalRegisteredPath("home", `/${"a".repeat(254)}`)).toHaveLength(255);
  });

  it("writes only canonical workspace, home, and runtime paths, and refuses one that cannot fit the registration record", () => {
    const messy = { ...grokWorkerPlan({ "agent:a": "grok" }), instancePaths: { configPath: `${INSTANCE}/daimon/config.json`, instanceRoot: `${INSTANCE}/`, workspacePath: `${INSTANCE}//workspace/` } } as RuntimeTargetPlan;
    const [entry] = resolveDaimonGrokRegistrations([messy]);
    for (const value of [entry!.workspace, entry!.home, entry!.grokHome, entry!.profilePath, entry!.eventsPath, entry!.privateTmp, entry!.runtimeHome, entry!.spillDirectory]) {
      expect(() => assertCanonicalRegisteredPath("path", value), value).not.toThrow();
    }
    const longId = `agent:${"x".repeat(240)}`;
    expect(() => resolveDaimonGrokRegistrations([grokWorkerPlan({ [longId]: "grok" })])).toThrow(/canonical registered path/u);
    expect(() => resolveDaimonGrokRegistrations([grokWorkerPlan({ "agent:!!!": "grok" })])).toThrow(/no path-safe slug/u);
  });
});
