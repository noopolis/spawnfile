import path from "node:path";
import os from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import {
  resolveAuthHome,
  resolveImportedAuthDirectory,
  resolveProfileDirectory,
  resolveProfilePath,
  resolveProfilesRoot,
  resolveSpawnfileHome,
  resolveTargetSecretAliasesDirectory,
  resolveTargetSecretGrantsDirectory,
  resolveTargetSecretRedemptionsDirectory,
  resolveTargetSecretRevocationsDirectory,
  resolveTargetSecretAliasPath,
  resolveTargetSecretGrantPath,
  resolveTargetSecretRedemptionPath,
  resolveTargetSecretRevocationPath,
  resolveTargetSecretVersionPath,
  resolveTargetSecretVersionsDirectory
} from "./paths.js";

const previousSpawnfileHome = process.env.SPAWNFILE_HOME;

afterEach(() => {
  if (previousSpawnfileHome === undefined) {
    delete process.env.SPAWNFILE_HOME;
  } else {
    process.env.SPAWNFILE_HOME = previousSpawnfileHome;
  }
});

describe("auth paths", () => {
  it("uses the default Spawnfile home when SPAWNFILE_HOME is unset", () => {
    delete process.env.SPAWNFILE_HOME;

    expect(resolveSpawnfileHome()).toBe(path.resolve(os.homedir(), ".spawnfile"));
  });

  it("expands ~ and ~/ prefixes in SPAWNFILE_HOME", () => {
    process.env.SPAWNFILE_HOME = "~";
    expect(resolveSpawnfileHome()).toBe(os.homedir());

    process.env.SPAWNFILE_HOME = "~/custom-spawnfile";
    expect(resolveSpawnfileHome()).toBe(path.join(os.homedir(), "custom-spawnfile"));
  });

  it("derives auth profile directories from the Spawnfile home", () => {
    process.env.SPAWNFILE_HOME = "/tmp/spawnfile-home";

    expect(resolveAuthHome()).toBe("/tmp/spawnfile-home/auth");
    expect(resolveProfilesRoot()).toBe("/tmp/spawnfile-home/auth/profiles");
    expect(resolveProfileDirectory("dev")).toBe("/tmp/spawnfile-home/auth/profiles/dev");
    expect(resolveProfilePath("dev")).toBe("/tmp/spawnfile-home/auth/profiles/dev/profile.json");
    expect(resolveImportedAuthDirectory("dev", "codex")).toBe(
      "/tmp/spawnfile-home/auth/profiles/dev/imports/codex"
    );
  });

  it("derives target-secret layout roots from the auth home", () => {
    process.env.SPAWNFILE_HOME = "/tmp/spawnfile-home";

    const expectedRoot = "/tmp/spawnfile-home/auth/target-secrets";

    expect(resolveTargetSecretVersionsDirectory()).toBe(path.join(expectedRoot, "versions"));
    expect(resolveTargetSecretGrantsDirectory()).toBe(path.join(expectedRoot, "grants"));
    expect(resolveTargetSecretRedemptionsDirectory()).toBe(
      path.join(expectedRoot, "redemptions")
    );
    expect(resolveTargetSecretRevocationsDirectory()).toBe(path.join(expectedRoot, "revocations"));
    expect(resolveTargetSecretAliasesDirectory()).toBe(path.join(expectedRoot, "aliases"));
  });

  it("returns direct-keyed target-secret paths for canonical handles", () => {
    process.env.SPAWNFILE_HOME = "/tmp/spawnfile-home";

    expect(resolveTargetSecretVersionPath("opaque_" + "a".repeat(16))).toBe(
      "/tmp/spawnfile-home/auth/target-secrets/versions/opaque_" + "a".repeat(16)
    );
    expect(resolveTargetSecretGrantPath("opaque_" + "b".repeat(64))).toBe(
      "/tmp/spawnfile-home/auth/target-secrets/grants/opaque_" + "b".repeat(64)
    );
    expect(resolveTargetSecretRedemptionPath("opaque_" + "c".repeat(16))).toBe(
      "/tmp/spawnfile-home/auth/target-secrets/redemptions/opaque_" + "c".repeat(16)
    );
    expect(resolveTargetSecretRevocationPath("opaque_" + "d".repeat(64))).toBe(
      "/tmp/spawnfile-home/auth/target-secrets/revocations/opaque_" + "d".repeat(64)
    );
    expect(resolveTargetSecretAliasPath("opaque_" + "e".repeat(16))).toBe(
      "/tmp/spawnfile-home/auth/target-secrets/aliases/opaque_" + "e".repeat(16)
    );
  });

  it("rejects hostile target-secret keys for all leaf path helpers", () => {
    process.env.SPAWNFILE_HOME = "/tmp/spawnfile-home";

    const hostileKeys = [
      "v1",
      "opaque_short",
      "opaque_ABCDEFGHIJKLMNOP",
      `../${"f".repeat(16)}`,
      `/${"g".repeat(16)}`,
      `aliases/${"h".repeat(16)}`,
      `opaque_${"i".repeat(65)}`,
      `opaque_${"j".repeat(15)}`,
      `opaque_${"k".repeat(16)}\u0000`
    ];

    const resolveLeafPath: Array<(key: string) => string> = [
      resolveTargetSecretVersionPath,
      resolveTargetSecretGrantPath,
      resolveTargetSecretRedemptionPath,
      resolveTargetSecretRevocationPath,
      resolveTargetSecretAliasPath
    ];

    for (const key of hostileKeys) {
      for (const resolvePath of resolveLeafPath) {
        expect(() => resolvePath(key)).toThrow("Invalid target-secret path key");
      }
    }
  });
});
