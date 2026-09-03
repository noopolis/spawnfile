import { describe, expect, it } from "vitest";

import { createPersistentVolumeName } from "./moltnetArtifactPaths.js";

// These tests pin createPersistentVolumeName's output to concrete literal
// strings (rather than recomputing the expected value by calling the same
// helper, as most call-site tests do) so a regression in the formula itself
// — project/id slugging, the run-id segment, or the hash inputs — is caught
// here even if every other test happens to agree with the (broken) helper.

const PLAN_ROOT = "/tmp/team/Spawnfile";
const MOUNT_ID = "moltnet-local_lab-causal";

describe("createPersistentVolumeName literal formula", () => {
  it("(a) bare compile with no runId reproduces the pre-run-scoping name shape", () => {
    const name = createPersistentVolumeName(PLAN_ROOT, MOUNT_ID);

    expect(name).toBe("spawnfile-team-moltnet-local-lab-causal-bff6db9a");
  });

  it("(b) with a runId appends the runId slug and changes the hash vs. the no-runId case", () => {
    const name = createPersistentVolumeName(PLAN_ROOT, MOUNT_ID, "run-alpha");

    expect(name).toBe("spawnfile-team-moltnet-local-lab-causal-run-alpha-9bf7813e");
    expect(name).not.toBe(createPersistentVolumeName(PLAN_ROOT, MOUNT_ID));
    expect(name).toContain("-run-alpha-");
  });

  it("(c) takes no author-declared name: run-scoped mounts are never author-named", () => {
    // Regression lock for the silent-discard defect this signature removed.
    // The old third parameter accepted an author's explicit `name` and then
    // DROPPED it whenever a run id was present, so a declared volume name
    // silently became a fresh run-scoped one on every `spawnfile run`.
    // Author-named durable state is now `exclusive-reattach` and never
    // reaches this helper; the helper cannot take a name at all.
    expect(createPersistentVolumeName.length).toBe(3);
    expect(createPersistentVolumeName(PLAN_ROOT, MOUNT_ID, "run-alpha"))
      .toBe("spawnfile-team-moltnet-local-lab-causal-run-alpha-9bf7813e");
  });

  it("(d) two different runIds produce two different volume names (run isolation)", () => {
    const nameAlpha = createPersistentVolumeName(PLAN_ROOT, MOUNT_ID, "run-alpha");
    const nameBeta = createPersistentVolumeName(PLAN_ROOT, MOUNT_ID, "run-beta");

    expect(nameAlpha).toBe("spawnfile-team-moltnet-local-lab-causal-run-alpha-9bf7813e");
    expect(nameBeta).toBe("spawnfile-team-moltnet-local-lab-causal-run-beta-2a060813");
    expect(nameAlpha).not.toBe(nameBeta);
  });
});
