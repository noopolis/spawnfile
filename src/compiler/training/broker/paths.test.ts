import { describe, expect, it } from "vitest";

import { DAIMON_GROK_ENGINE_BROKER } from "../../../runtime/daimon/contractManifest.js";
import { trainingBrokerMounts, trainingBrokerTmpfsTargets } from "../container/security.js";
import { renderTrainingBrokerProvisioning, trainingSlotDirectories } from "./provisioning.js";
import { resolveTrainingGrokRegistration } from "./registration.js";
import {
  TRAINING_BROKER_TMPDIR,
  TRAINING_CLEAR_TARGETS,
  TRAINING_SLOT_RUNTIME_HOME,
  TRAINING_WIPE_TARGETS
} from "./paths.js";

/** Every path the v3 launch mounts: its tmpfs set plus the realm volume and the two read-only binds. */
const launchMounts = (): string[] => [
  ...trainingBrokerTmpfsTargets().map((entry) => entry.path),
  ...trainingBrokerMounts({ realmVolume: "realm", bootstrap: "/host/auth.json", declaration: "/host/declaration.json" })
    .map((mount) => /dst=([^,]+)/u.exec(mount)![1]!)
];

const at_or_below = (candidate: string, root: string): boolean => candidate === root || candidate.startsWith(`${root}/`);

describe("training wipe targets versus the launch's own mounts", () => {
  /**
   * The P8 regression, as an invariant rather than an incident. A mount point
   * cannot be unlinked while it is mounted, so a recycle that must remove or
   * empty a directory holding one aborts. `/run/daimon-engine-broker/tmp` was
   * both the broker's `TMPDIR` and a declared tmpfs inside a cleared root, and
   * a live launch died on `find: cannot delete …: Device or resource busy`.
   */
  it("never mounts anything at or below a directory a recycle removes", () => {
    for (const mount of launchMounts()) {
      for (const target of TRAINING_WIPE_TARGETS) {
        expect(at_or_below(mount, target), `${mount} is inside the wipe target ${target}`).toBe(false);
      }
    }
  });

  it("never mounts anything strictly below a directory a recycle empties", () => {
    for (const mount of launchMounts()) {
      for (const target of TRAINING_CLEAR_TARGETS) {
        // The target may itself be a mount — its contents go and the directory stays — but nothing below it may be.
        expect(mount !== target && at_or_below(mount, target), `${mount} is inside the cleared target ${target}`).toBe(false);
      }
    }
  });

  it("keeps the broker temp a mount of its own, outside every wipe and clear target", () => {
    expect(launchMounts()).toContain(TRAINING_BROKER_TMPDIR);
    for (const target of [...TRAINING_WIPE_TARGETS, ...TRAINING_CLEAR_TARGETS]) {
      expect(at_or_below(TRAINING_BROKER_TMPDIR, target), target).toBe(false);
    }
  });
});

describe("the traversable slot runtime home", () => {
  const registration = () => resolveTrainingGrokRegistration({ agentId: "agent:author", model: "grok-4.6", reasoningEffort: "low" });

  /**
   * Daimon's contract makes a brokered Grok agent's organization runtime home
   * `2000:<worker> 0710` — traverse-only, so the worker can reach the setgid
   * `tool-output/` spill directory and nothing else. Every other entry inside
   * it must therefore be private on its own. Daimon creates its own
   * subdirectories `0700`; this asserts the *training container* adds nothing
   * there that is wider.
   */
  it("has the training container create nothing of its own inside it", () => {
    for (const entry of trainingSlotDirectories()) {
      expect(entry.path.startsWith(`${TRAINING_SLOT_RUNTIME_HOME}/`), `${entry.path} is inside the slot runtime home`).toBe(false);
    }
    expect(trainingSlotDirectories().some((entry) => entry.path === TRAINING_SLOT_RUNTIME_HOME)).toBe(false);
  });

  it("declares no persistent mount inside it, so nothing needs re-privatising", () => {
    expect(registration().runtimeHomeMounts).toEqual([]);
    for (const mount of launchMounts()) {
      expect(at_or_below(mount, TRAINING_SLOT_RUNTIME_HOME), mount).toBe(false);
    }
  });

  it("lets the shared renderer own its mode: 0710 2000:<worker>, narrowed only after the spill directory exists", () => {
    const script = renderTrainingBrokerProvisioning(registration()).join("\n");
    expect(script).toContain("withMode(entry.runtimeHome, 0o710, 2000, entry.uid)");
    expect(script).not.toContain("withMode(entry.runtimeHome, 0o700");
    const spill = script.indexOf("withMode(entry.spillDirectory, 0o2750, 2000, entry.uid)");
    expect(spill).toBeGreaterThan(-1);
    expect(script.indexOf("withMode(entry.runtimeHome, 0o710, 2000, entry.uid)")).toBeGreaterThan(spill);
    // The only thing provisioning puts inside it, and it is group-readable on purpose.
    expect(registration().spillDirectory).toBe(`${TRAINING_SLOT_RUNTIME_HOME}/tool-output`);
  });

  it("keeps the contract's own rule as the source of that mode", () => {
    expect(DAIMON_GROK_ENGINE_BROKER.worker.home.organizationRuntimeHome)
      .toEqual({ owner: "organization", group: "worker", mode: 0o710 });
  });
});
