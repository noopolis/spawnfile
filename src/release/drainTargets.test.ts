import { afterEach, expect, it, vi } from "vitest";

import { withSyntheticAdapter } from "../deployment/syntheticRuntimeAdapter.test-helper.js";
import type { RuntimeDrainOperations } from "../runtime/operations.js";
import { createDefaultReleaseDependencies } from "./releaseDefaults.js";
import { drainTargetsFor } from "./drainTargets.js";
import type { RunningUnit } from "./releaseDocker.js";
import type { ReleaseRequest } from "./releaseTypes.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const sampleRequest = (): ReleaseRequest => ({
  bundleIdentity: "release",
  deployment: "sample",
  dockerCommand: "docker",
  dockerContext: "test-context",
  drain: true,
  drainPollMs: 5,
  drainTimeoutMs: 20,
  envFileEnv: { SPAWNFILE_TEST_RELEASE_TOKEN: "file-token" },
  force: false,
  inputPath: "/project",
  log: vi.fn(),
  notifier: { kind: "none" },
  notifyDeferredAfterMs: 20,
  settle: { polls: 1, pollMs: 5, stablePolls: 1 }
});

const unit = { id: "container-1", imageId: "sha256:sample" } as RunningUnit;

it("runs the selected runtime's drain, probe and resume without a built-in name", async () => {
  const runtime = "test-runtime";
  const drain = {
    controlTokenEnv: "SPAWNFILE_TEST_RELEASE_TOKEN",
    drain: vi.fn(async () => ({ drain: "draining", state: "busy" }) as const),
    availability: vi.fn(async () => ({ drain: "drained", state: "paused" }) as const),
    resume: vi.fn(async () => ({ drain: null, state: "open" }) as const)
  } satisfies RuntimeDrainOperations;
  vi.stubEnv("SPAWNFILE_TEST_RELEASE_TOKEN", "process-token");
  const request = sampleRequest();
  const deps = { ...createDefaultReleaseDependencies(), runtimesOf: async () => [runtime, runtime] };

  await withSyntheticAdapter(runtime, async () => {
    const targets = await drainTargetsFor(request, deps, unit);
    expect(targets).toEqual([{
      runtime, containerRef: "container-1", imageRef: "sha256:sample",
      dockerCommand: "docker", dockerArgs: ["--context", "test-context"], token: "process-token"
    }]);
    const [target] = targets;
    await deps.requestDrain(target!);
    await expect(deps.waitForDrained(target!, { timeoutMs: 20, pollMs: 5 })).resolves.toMatchObject({ drained: true });
    await deps.requestResume(target!);
    expect(drain.drain).toHaveBeenCalledWith(target);
    expect(drain.availability).toHaveBeenCalledWith(target);
    expect(drain.resume).toHaveBeenCalledWith(target);
  }, { operations: { drain } });
});

it("refuses an absent adapter with an actionable --adapter error, even when not every runtime must drain", async () => {
  const deps = { ...createDefaultReleaseDependencies(), runtimesOf: async () => ["absent-runtime"] };
  for (const requireAll of [true, false]) {
    await expect(drainTargetsFor(sampleRequest(), deps, unit, { requireAll })).rejects.toMatchObject({
      message: expect.stringMatching(/"absent-runtime".*--adapter <module>/u),
      reason: "blocked"
    });
  }
});

it("keeps skipping a loaded adapter that legitimately declares no drain contract", async () => {
  const deps = { ...createDefaultReleaseDependencies(), runtimesOf: async () => ["quiet-runtime"] };
  await withSyntheticAdapter("quiet-runtime", async () => {
    await expect(drainTargetsFor(sampleRequest(), deps, unit, { requireAll: false })).resolves.toEqual([]);
    await expect(drainTargetsFor(sampleRequest(), deps, unit)).rejects.toThrow(/without a drain contract/u);
  });
});
