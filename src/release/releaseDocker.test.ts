import { describe, expect, it } from "vitest";

import type { DockerCommandRunner } from "../distribution/dockerRunner.js";

import { inspectUnit, pruneReleaseImages, releaseImageTag, settleUnit } from "./releaseDocker.js";

const runner = (handler: (args: string[]) => string | Error): DockerCommandRunner & { calls: string[][] } => {
  const calls: string[][] = [];
  const run = (async (args: string[]) => {
    calls.push(args);
    const result = handler(args);
    if (result instanceof Error) throw result;
    return Buffer.from(result);
  }) as DockerCommandRunner & { calls: string[][] };
  run.calls = calls;
  return run;
};

const inspection = (running: boolean, health: string, restarts = 0): string =>
  [JSON.stringify("c1"), JSON.stringify("sha256:img"), JSON.stringify({ Running: running, ...(health === "none" ? {} : { Health: { Status: health } }) }), JSON.stringify(restarts)].join("\t");

describe("releaseImageTag", () => {
  it("is the repository plus the first twelve hex of the identity", () => {
    expect(releaseImageTag("spawnfile-org", `sha256:${"ab".repeat(32)}`)).toBe("spawnfile-org:r-abababababab");
  });
});

describe("inspectUnit", () => {
  it("parses a running container and returns null for a missing one", async () => {
    await expect(inspectUnit(runner(() => inspection(true, "healthy")), "x")).resolves.toEqual({ health: "healthy", id: "c1", imageId: "sha256:img", restartCount: 0, running: true });
    await expect(inspectUnit(runner(() => new Error("Error: No such container: x")), "x")).resolves.toBeNull();
  });

  it("fails closed on a container it cannot read", async () => {
    await expect(inspectUnit(runner(() => new Error("permission denied")), "x")).rejects.toThrow("cannot inspect");
    await expect(inspectUnit(runner(() => "garbage"), "x")).rejects.toThrow("unreadable inspection");
  });
});

describe("settleUnit", () => {
  it("waits until the same healthy observation holds for consecutive polls", async () => {
    const sequence = [inspection(true, "starting"), inspection(true, "healthy"), inspection(true, "healthy"), inspection(true, "healthy")];
    let index = 0;
    const unit = await settleUnit(runner(() => sequence[index++]!), "x", { pollMs: 1, polls: 10, sleep: async () => undefined, stablePolls: 3 });
    expect(unit.health).toBe("healthy");
    expect(index).toBe(4);
  });

  it("does not call a crash-looping container settled", async () => {
    let restarts = 0;
    await expect(settleUnit(runner(() => inspection(true, "none", restarts++)), "x", { pollMs: 1, polls: 6, sleep: async () => undefined, stablePolls: 2 }))
      .rejects.toThrow("never settled");
  });
});

describe("pruneReleaseImages", () => {
  const listing = ["r-current\tsha256:1", "r-rollback\tsha256:2", "r-old\tsha256:3", "r-inuse\tsha256:4", "latest\tsha256:5"].join("\n");

  it("keeps the running image and one rollback, removes older release tags, never touches other tags or used images", async () => {
    const docker = runner((args) => {
      if (args[0] === "image" && args[1] === "ls") return listing;
      if (args[0] === "ps") return "cont1\n";
      if (args[0] === "container") return "sha256:4\n";
      return "";
    });
    const result = await pruneReleaseImages(docker, "spawnfile-org", ["spawnfile-org:r-current", "spawnfile-org:r-rollback"]);
    expect(result.removed).toEqual(["spawnfile-org:r-old"]);
    expect(result.kept).toEqual(["spawnfile-org:r-current", "spawnfile-org:r-rollback"]);
    expect(result.skipped).toEqual(["spawnfile-org:r-inuse"]);
    const removals = docker.calls.filter((args) => args[1] === "rm");
    expect(removals).toEqual([["image", "rm", "spawnfile-org:r-old"]]);
    expect(docker.calls.flat()).not.toContain("-f");
    expect(docker.calls.flat()).not.toContain("prune");
  });

  it("skips an image Docker refuses to remove", async () => {
    const docker = runner((args) => {
      if (args[1] === "ls") return "r-old\tsha256:3";
      if (args[0] === "ps") return "";
      if (args[1] === "rm") return new Error("conflict");
      return "";
    });
    expect(await pruneReleaseImages(docker, "spawnfile-org", [null])).toEqual({ kept: [], removed: [], skipped: ["spawnfile-org:r-old"] });
  });
});
