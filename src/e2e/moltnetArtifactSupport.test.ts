import { describe, expect, it } from "vitest";

import { copyContainerPathToHost, countJsonlLines } from "./moltnetArtifactSupport.js";

describe("countJsonlLines", () => {
  it("counts non-blank lines", () => {
    expect(countJsonlLines('{"a":1}\n{"b":2}\n\n')).toBe(2);
    expect(countJsonlLines("")).toBe(0);
  });
});

describe("copyContainerPathToHost", () => {
  it("returns true when the docker cp command succeeds", async () => {
    const calls: string[][] = [];
    const ok = await copyContainerPathToHost({
      containerName: "container",
      containerPath: "/var/lib/spawnfile/instances/pi/pi-app/runtime/agents",
      dockerCommand: "docker",
      hostPath: "/tmp/out/engine-logs",
      runCommand: async (_command, args) => {
        calls.push(args);
        return "";
      }
    });

    expect(ok).toBe(true);
    expect(calls).toEqual([
      ["cp", "container:/var/lib/spawnfile/instances/pi/pi-app/runtime/agents", "/tmp/out/engine-logs"]
    ]);
  });

  it("returns false instead of throwing when the docker cp command fails", async () => {
    const ok = await copyContainerPathToHost({
      containerName: "container",
      containerPath: "/missing",
      dockerCommand: "docker",
      hostPath: "/tmp/out/engine-logs",
      runCommand: async () => {
        throw new Error("no such path");
      }
    });

    expect(ok).toBe(false);
  });
});
