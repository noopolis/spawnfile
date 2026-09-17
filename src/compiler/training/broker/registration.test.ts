import { describe, expect, it } from "vitest";

import { renderDaimonGrokServiceConfig } from "../../containerDaimonGrokWorkerRender.js";
import { renderTrainingBrokerProvisioning, trainingSlotDirectories } from "./provisioning.js";
import { resolveTrainingGrokDenyPaths, resolveTrainingGrokRegistration } from "./registration.js";
import {
  TRAINING_ADDED_DENY_PATHS,
  TRAINING_CALLER_PROTECTED_PATHS,
  TRAINING_EVALUATOR_ROOTS,
  TRAINING_GRANT_HOME_ROOT,
  TRAINING_INFERENCE_DIRECTORY,
  TRAINING_INFERENCE_LEDGER,
  TRAINING_REALM_MOUNT,
  TRAINING_SLOT_ACCEPTANCE_STORE,
  TRAINING_SLOT_STATE_ROOT,
  TRAINING_SLOT_TURN_STORE,
  TRAINING_SLOT_USAGE_DIRECTORY,
  TRAINING_SLOT_USAGE_LEDGER
} from "./paths.js";

const slot = () => resolveTrainingGrokRegistration({ agentId: "agent:author", model: "grok-4.6", reasoningEffort: "low" });

describe("training Grok slot registration", () => {
  it("denies every evaluator root, the caller's whole /run/paideia, the control root and the judge grant home", () => {
    const denied = slot().denyPaths;
    // Every caller-protected path is covered by the single `/run/paideia` mask rather than listed itself:
    // Grok materializes each deny target inside bubblewrap and cannot create one there as the worker uid.
    for (const covered of TRAINING_CALLER_PROTECTED_PATHS) {
      expect(denied.some((entry) => covered === entry || covered.startsWith(`${entry}/`)), covered).toBe(true);
    }
    for (const entry of [...TRAINING_EVALUATOR_ROOTS.map((role) => role.path),
      "/run/daimon-engine-broker", "/etc/daimon-engine-broker", TRAINING_GRANT_HOME_ROOT, TRAINING_INFERENCE_DIRECTORY,
      TRAINING_SLOT_STATE_ROOT, TRAINING_SLOT_TURN_STORE, TRAINING_REALM_MOUNT]) {
      expect(denied, entry).toContain(entry);
    }
    expect(denied).toEqual([...denied].sort());
    expect(new Set(denied).size).toBe(denied.length);
  });

  it("masks the wake-acceptance store through the slot state root, never the store itself", () => {
    // The store's parent is `2000:2000 0700`, and Grok 1.0.34 materializes every deny target inside
    // bubblewrap as the worker uid, so the store itself is unplaceable and would make Grok refuse the
    // whole profile — the defect P5 hit live (`.runtime/grok-deny-placement/EVIDENCE.md`).
    const denied = slot().denyPaths;
    expect(denied).toContain(TRAINING_SLOT_STATE_ROOT);
    expect(denied).not.toContain(TRAINING_SLOT_ACCEPTANCE_STORE);
    expect(TRAINING_SLOT_ACCEPTANCE_STORE.startsWith(`${TRAINING_SLOT_STATE_ROOT}/`)).toBe(true);
    // And the store can never come back as an added entry: the state root already covers it.
    expect(() => resolveTrainingGrokDenyPaths([...TRAINING_ADDED_DENY_PATHS, TRAINING_SLOT_ACCEPTANCE_STORE])).toThrow(/masks cannot nest/u);
  });

  it("keeps the subject's own workspace, worker home and runtime home reachable", () => {
    const registration = slot();
    for (const own of [registration.workspace, registration.home, registration.grokHome, registration.runtimeHome, registration.privateTmp, registration.spillDirectory]) {
      expect(registration.denyPaths.some((entry) => own === entry || own.startsWith(`${entry}/`))).toBe(false);
    }
  });

  it("refuses a deny entry that equals or contains a Grok base-profile grant", () => {
    expect(() => resolveTrainingGrokDenyPaths([...TRAINING_ADDED_DENY_PATHS, "/run"])).toThrow(/base profile grant/u);
    expect(() => resolveTrainingGrokDenyPaths([...TRAINING_ADDED_DENY_PATHS, "/var/tmp"])).toThrow(/base profile grant/u);
  });

  it("refuses nested masks and a mask over the subject's own workspace", () => {
    expect(() => resolveTrainingGrokDenyPaths([...TRAINING_ADDED_DENY_PATHS, "/run/training/output/runs"])).toThrow(/masks cannot nest/u);
    expect(() => resolveTrainingGrokDenyPaths([...TRAINING_ADDED_DENY_PATHS, "/run/training/slot/runtime-home"])).toThrow(/own workspace, home, or runtime home/u);
  });

  it("points the registration at the per-slot ledger, never the container ledger", () => {
    expect(slot().usageLedgerPath).toBe(TRAINING_SLOT_USAGE_LEDGER);
    expect(slot().usageLedgerPath.startsWith("/var/lib/spawnfile/daimon/usage")).toBe(false);
  });

  it("refuses an undeclared model or reasoning effort", () => {
    expect(() => resolveTrainingGrokRegistration({ agentId: "agent:author", model: "grok-9" as never, reasoningEffort: "low" })).toThrow(/declared broker model/u);
  });
});

describe("training service.json v2", () => {
  it("keeps the turn store on per-slot tmpfs and declares the inference ledger", () => {
    const service = renderDaimonGrokServiceConfig([slot()], { turnStore: TRAINING_SLOT_TURN_STORE, inferenceLedgerPath: TRAINING_INFERENCE_LEDGER });
    expect(service.turnStore).toBe(TRAINING_SLOT_TURN_STORE);
    expect(service).toHaveProperty("inferenceLedgerPath", TRAINING_INFERENCE_LEDGER);
    expect(service.registrations[0]!.usageLedgerPath).toBe(TRAINING_SLOT_USAGE_LEDGER);
  });

  it("refuses a turn store on the durable credential realm", () => {
    expect(() => renderDaimonGrokServiceConfig([slot()], { turnStore: `${TRAINING_REALM_MOUNT}/turns` }))
      .toThrow(/durable credential realm/u);
  });

  it("refuses an inference ledger that is a subject usage ledger", () => {
    expect(() => renderDaimonGrokServiceConfig([slot()], { turnStore: TRAINING_SLOT_TURN_STORE, inferenceLedgerPath: TRAINING_SLOT_USAGE_LEDGER }))
      .toThrow(/subject usage ledger/u);
  });
});

describe("training slot provisioning", () => {
  it("makes both ledger directories setgid to the organization group and the grant home private", () => {
    const directories = trainingSlotDirectories();
    for (const target of [TRAINING_SLOT_USAGE_DIRECTORY, TRAINING_INFERENCE_DIRECTORY]) {
      expect(directories.find((entry) => entry.path === target)).toMatchObject({ mode: "2750", uid: 2100, gid: 2000 });
    }
    expect(directories.find((entry) => entry.path === TRAINING_GRANT_HOME_ROOT)).toMatchObject({ mode: "0700", uid: 2000, gid: 2000 });
  });

  it("asserts the provisioned ledger and grant modes, and proves both ledgers are readable by uid 2000", () => {
    const script = renderTrainingBrokerProvisioning(slot()).join("\n");
    expect(script).toContain(`test "$(stat -c '%u:%g %a' '${TRAINING_SLOT_USAGE_DIRECTORY}')" = "2100:2000 2750"`);
    expect(script).toContain(`test "$(stat -c '%u:%g %a' '${TRAINING_INFERENCE_DIRECTORY}')" = "2100:2000 2750"`);
    expect(script).toContain(`test "$(stat -c '%u:%g %a' '${TRAINING_GRANT_HOME_ROOT}')" = "2000:2000 700"`);
    expect(script).toContain(`! test -r '${TRAINING_GRANT_HOME_ROOT}'`);
    expect(script).toContain(`test -r '${TRAINING_SLOT_USAGE_LEDGER}' && test -r '${TRAINING_INFERENCE_LEDGER}'`);
  });

  it("reclaims every directory before it chmods it, because root holds no CAP_FOWNER", () => {
    const script = renderTrainingBrokerProvisioning(slot()).join("\n");
    expect(script).toContain('chown 0:0 "$target"; chmod "$mode" "$target"; chown "$owner:$group" "$target"');
  });
});
