import { describe, expect, it } from "vitest";

import { createConsumerDockerRunner } from "./dockerRunner.js";

describe("createConsumerDockerRunner", () => {
  it("resolves stdout for a successful command", async () => {
    const run = createConsumerDockerRunner(process.execPath, ["-e"]);
    const output = await run(["process.stdout.write('hello')"]);
    expect(output.toString("utf8")).toBe("hello");
  });

  it("rejects with a SpawnfileError on a non-zero exit", async () => {
    const run = createConsumerDockerRunner(process.execPath, ["-e"]);
    await expect(
      run(["process.stderr.write('boom'); process.exit(3)"])
    ).rejects.toThrow(/failed \(3\): boom/);
  });

  it("rejects when the command cannot be spawned", async () => {
    const run = createConsumerDockerRunner(
      "spawnfile-nonexistent-binary-xyz",
      []
    );
    await expect(run(["anything"])).rejects.toThrow();
  });
});
