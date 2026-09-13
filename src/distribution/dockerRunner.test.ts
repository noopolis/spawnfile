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

  it("includes application stderr only when diagnostic capture requests it", async () => {
    const run = createConsumerDockerRunner(process.execPath, ["-e"]);
    const command = ["process.stdout.write('out'); process.stderr.write('err')"];
    expect((await run(command)).toString()).toBe("out");
    const captured = (await run(command, { captureStderr: true, maxOutputBytes: 100, timeoutMs: 1_000 })).toString();
    expect(captured).toContain("out");
    expect(captured).toContain("err");
  });

  it.each(["stdout", "stderr"])("bounds diagnostic %s before buffering unbounded output", async (stream) => {
    const run = createConsumerDockerRunner(process.execPath, ["-e"]);
    await expect(run([`process.${stream}.write('x'.repeat(100_000))`], {
      captureStderr: true, maxOutputBytes: 100, timeoutMs: 1_000
    })).rejects.toThrow("byte limit");
  });

  it("kills a hanging diagnostic command within its time budget", async () => {
    const run = createConsumerDockerRunner(process.execPath, ["-e"]);
    await expect(run(["setInterval(() => {}, 1000)"], { timeoutMs: 50 })).rejects.toThrow("timed out");
  });
});
