import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { expect, it } from "vitest";

import { executeDockerCommandCore, type DockerCommandSpawn } from "./dockerCommandExecutorCore.js";

class Child extends EventEmitter {
  public readonly stdin = new PassThrough();
  public readonly stdout = new PassThrough();
  public readonly stderr = new PassThrough();
  public kill(): boolean { return true; }
}

it("executes configured paths up to 1024 UTF-8 bytes without a shell and rejects longer paths before spawn", async () => {
  const calls: unknown[] = [];
  const spawn: DockerCommandSpawn = (file, args, options) => {
    calls.push([file, args, options]);
    const child = new Child();
    queueMicrotask(() => {
      child.stdout.end("receipt\n");
      child.stderr.end();
      child.emit("close", 0);
    });
    return child as unknown as ReturnType<DockerCommandSpawn>;
  };
  const file = `/${"é".repeat(511)}x`;
  expect(Buffer.byteLength(file, "utf8")).toBe(1_024);
  await expect(executeDockerCommandCore(spawn, file, ["version"], { binary: false, timeout: 100 }))
    .resolves.toEqual({ stderr: "", stdout: "receipt\n" });
  expect(calls).toEqual([[file, ["version"], { shell: false, stdio: ["pipe", "pipe", "pipe"] }]]);
  for (const invalid of [`${file}x`, `/${"é".repeat(512)}`, "docker\0private"]) {
    expect(() => executeDockerCommandCore(spawn, invalid, ["version"], { binary: false, timeout: 100 }))
      .toThrow("Docker command failed");
  }
  expect(calls).toHaveLength(1);
});
