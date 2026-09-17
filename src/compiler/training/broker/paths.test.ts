import { describe, expect, it } from "vitest";

import { trainingBrokerMounts, trainingBrokerTmpfsTargets } from "../container/security.js";
import {
  TRAINING_BROKER_TMPDIR,
  TRAINING_CLEAR_TARGETS,
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
