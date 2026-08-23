import { mkdir, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { removeDirectory } from "../filesystem/index.js";
import type { ContainerRuntimeInstanceReport } from "../report/index.js";
import { findDaimonRuntimeInstance, resolveDaimonRuntimeRoot } from "./daimonRuntimeInstanceLookup.js";

const cleanupDirs: string[] = [];
afterEach(async () => {
  while (cleanupDirs.length > 0) {
    const directory = cleanupDirs.pop();
    if (directory) {
      await removeDirectory(directory);
    }
  }
});

const buildInstance = (runtime: string): ContainerRuntimeInstanceReport => ({
  config_path: "/var/lib/spawnfile/instances/x/config.json",
  home_path: "/var/lib/spawnfile/instances/x/home",
  id: "x",
  model_auth_methods: {},
  model_secrets_required: [],
  runtime
});

describe("findDaimonRuntimeInstance", () => {
  it("does not accept a public Daimon organization host", () => {
    const instances = [buildInstance("moltnet"), buildInstance("daimon")];
    expect(findDaimonRuntimeInstance(instances)).toBeUndefined();
  });

  it("finds the legacy generated-Pi instance", () => {
    const instances = [buildInstance("moltnet"), buildInstance("pi")];
    expect(findDaimonRuntimeInstance(instances)).toBe(instances[1]);
  });

  it("returns undefined when neither label is present", () => {
    expect(findDaimonRuntimeInstance([buildInstance("moltnet")])).toBeUndefined();
  });

  it("returns undefined for an undefined instance list", () => {
    expect(findDaimonRuntimeInstance(undefined)).toBeUndefined();
  });
});

describe("resolveDaimonRuntimeRoot", () => {
  it("resolves the legacy generated-Pi runtime install directory", async () => {
    const rootfs = await mkdtemp(path.join(os.tmpdir(), "spawnfile-daimon-runtime-root-test-"));
    cleanupDirs.push(rootfs);
    await mkdir(path.join(rootfs, "opt", "spawnfile", "runtime-installs", "pi"), { recursive: true });

    expect(await resolveDaimonRuntimeRoot(rootfs)).toBe(
      path.join(rootfs, "opt", "spawnfile", "runtime-installs", "pi")
    );
  });
});
