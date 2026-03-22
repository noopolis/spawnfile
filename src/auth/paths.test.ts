import path from "node:path";
import os from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import {
  resolveAuthHome,
  resolveImportedAuthDirectory,
  resolveProfileDirectory,
  resolveProfilePath,
  resolveProfilesRoot,
  resolveSpawnfileHome
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
});
