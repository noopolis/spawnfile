import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import { DockerResourceProviderError } from "./dockerResourcesProvider.js";
import { DockerArtifactProviderError } from "./dockerArtifactsProvider.js";
import { DockerSecretProviderError } from "./dockerSecretsProvider.js";
import { DockerOrganizationAttachmentProviderError } from "./organizationAttachmentProvider.js";
import { DockerWorldServiceProviderError } from "./dockerWorldServiceProvider.js";
import { createDockerTargetExecutors, type DockerCommandSpawn } from "./dockerCommandExecutor.js";
import { MAX_TARGET_PUBLIC_ARTIFACT_BYTES } from "./publicArtifactSnapshot.js";
import {
  DOCKER_BINARY_CAP,
  DOCKER_TEXT_CAP,
  executeDockerCommandCore
} from "./dockerCommandExecutorCore.js";

class Child extends EventEmitter {
  public readonly stdin = new PassThrough();
  public readonly stdout = new PassThrough();
  public readonly stderr = new PassThrough();
  public kills = 0;
  public kill(): boolean { this.kills += 1; return true; }
}

const fixture = (run: (child: Child) => void) => {
  const children: Child[] = [];
  const calls: unknown[][] = [];
  const spawn = ((file: string, args: readonly string[], options: unknown) => {
    const child = new Child();
    children.push(child);
    calls.push([file, args, options]);
    queueMicrotask(() => run(child));
    return child;
  }) as unknown as DockerCommandSpawn;
  return { calls, children, executors: createDockerTargetExecutors({ dockerCommand: "docker-safe", spawn }) };
};

describe("private Docker command executor bridge", () => {
  it("spawns the configured command without a shell and decodes split UTF-8", async () => {
    const value = fixture((child) => {
      child.stdout.write(Buffer.from([0xe2, 0x82]));
      child.stdout.write(Buffer.from([0xac]));
      child.stderr.end();
      child.stdout.end();
      child.emit("close", 0);
    });
    await expect(value.executors.resource("docker", ["version"], { timeout: 100 }))
      .resolves.toEqual({ stderr: "", stdout: "€" });
    expect(value.calls).toEqual([[
      "docker-safe", ["version"], { shell: false, stdio: ["pipe", "pipe", "pipe"] }
    ]]);
    await expect(value.executors.resource("podman", [], { timeout: 100 }))
      .rejects.toThrow("Docker command failed");
  });

  it("passes secret stdin byte-exactly without reflecting it", async () => {
    const secret = Uint8Array.from([0, 255, 1, 2]);
    let received = Buffer.alloc(0);
    const value = fixture((child) => {
      child.stdin.on("data", (chunk) => { received = Buffer.concat([received, chunk]); });
      child.stdin.on("end", () => {
        child.stdout.end();
        child.stderr.end();
        child.emit("close", 0);
      });
    });
    await expect(value.executors.secret("docker", ["run"], { stdin: secret, timeout: 100 }))
      .resolves.toEqual({ stderr: "", stdout: "" });
    expect([...received]).toEqual([...secret]);
  });

  it("returns a fresh exact binary array and rejects invalid UTF-8 and caps", async () => {
    const binary = fixture((child) => {
      child.stdout.end(Uint8Array.from([0, 255, 7]));
      child.stderr.end();
      child.emit("close", 0);
    });
    const output = await binary.executors.evidenceExport("docker", ["container", "start"], { timeout: 100 });
    expect([...output.bytes]).toEqual([0, 255, 7]);
    expect(output.bytes.byteOffset).toBe(0);
    expect(output.bytes.buffer.byteLength).toBe(3);

    const invalid = fixture((child) => {
      child.stdout.end(Uint8Array.from([0xff]));
      child.stderr.end();
      child.emit("close", 0);
    });
    await expect(invalid.executors.artifact("docker", [], { timeout: 100 }))
      .rejects.toThrow("Docker command failed");

    const exactPublic = fixture((child) => {
      child.stdout.end(Buffer.alloc(MAX_TARGET_PUBLIC_ARTIFACT_BYTES, 9));
      child.stderr.end();
      child.emit("close", 0);
    });
    await expect(exactPublic.executors.publicArtifact(
      "docker", ["container", "exec"], { timeout: 100 }
    )).resolves.toMatchObject({ bytes: expect.any(Uint8Array) });
    const oversizedPublic = fixture((child) => {
      child.stdout.write(Buffer.alloc(MAX_TARGET_PUBLIC_ARTIFACT_BYTES + 1));
    });
    await expect(oversizedPublic.executors.publicArtifact(
      "docker", ["container", "exec"], { timeout: 100 }
    )).rejects.toThrow("Docker command failed");
  });

  it("kills once for pre/mid abort, timeout, stream error, and output overflow", async () => {
    const pre = createDockerTargetExecutors({ spawn: vi.fn() as never });
    const stopped = new AbortController();
    stopped.abort();
    await expect(pre.resource("docker", [], { signal: stopped.signal, timeout: 100 })).rejects.toThrow();

    for (const mode of ["abort", "timeout", "stream", "overflow"] as const) {
      const controller = new AbortController();
      const value = fixture((child) => {
        if (mode === "abort") controller.abort();
        if (mode === "stream") child.stdout.emit("error", new Error("private"));
        if (mode === "overflow") child.stdout.write(Buffer.alloc(32_769));
      });
      await expect(value.executors.resource("docker", [], {
        signal: controller.signal,
        timeout: mode === "timeout" ? 1 : 100
      })).rejects.toThrow("Docker command failed");
      expect(value.children[0]!.kills).toBe(1);
      if (mode === "abort") {
        value.children[0]!.emit("error", new Error("late child"));
        value.children[0]!.stdout.emit("error", new Error("late stdout"));
        value.children[0]!.stdin.emit("error", new Error("late stdin"));
        value.children[0]!.emit("close", null);
        value.children[0]!.stdout.emit("close");
        value.children[0]!.stdin.emit("close");
        expect(value.children[0]!.listenerCount("error")).toBe(0);
        expect(value.children[0]!.stdout.listenerCount("error")).toBe(0);
        expect(value.children[0]!.stdin.listenerCount("error")).toBe(0);
      }
    }
  });

  it("enforces the binary cap before concatenation", async () => {
    const chunk = Buffer.alloc(1_048_576);
    const value = fixture((child) => {
      for (let index = 0; index < 65; index += 1) child.stdout.emit("data", chunk);
    });
    await expect(value.executors.evidenceExport("docker", [], { timeout: 100 }))
      .rejects.toThrow("Docker command failed");
    expect(value.children[0]!.kills).toBe(1);
  });

  it("accepts exact text and binary caps and rejects one byte beyond them", async () => {
    const exactText = fixture((child) => {
      child.stdout.end(Buffer.alloc(DOCKER_TEXT_CAP, 97));
      child.stderr.end(Buffer.alloc(DOCKER_TEXT_CAP, 98));
      child.emit("close", 0);
    });
    await expect(exactText.executors.resource("docker", [], { timeout: 100 }))
      .resolves.toEqual({
        stderr: "b".repeat(DOCKER_TEXT_CAP),
        stdout: "a".repeat(DOCKER_TEXT_CAP)
      });

    const excessStderr = fixture((child) => {
      child.stderr.write(Buffer.alloc(DOCKER_TEXT_CAP + 1));
    });
    await expect(excessStderr.executors.resource("docker", [], { timeout: 100 }))
      .rejects.toThrow("Docker command failed");

    const chunk = Buffer.alloc(1_048_576, 7);
    const exactBinary = fixture((child) => {
      for (let index = 0; index < DOCKER_BINARY_CAP / chunk.length; index += 1) {
        child.stdout.write(chunk);
      }
      child.stdout.end();
      child.stderr.end();
      child.emit("close", 0);
    });
    const binaryResult = await exactBinary.executors.evidenceExport("docker", [], { timeout: 500 });
    expect(binaryResult.bytes).toHaveLength(DOCKER_BINARY_CAP);
    expect(binaryResult.bytes[0]).toBe(7);
    expect(binaryResult.bytes.at(-1)).toBe(7);
  });

  it("removes capture listeners and safely absorbs errors until late closes", async () => {
    const value = fixture((child) => {
      child.stdout.end("ok");
      child.stderr.end();
      child.emit("close", 0);
    });
    await expect(value.executors.resource("docker", [], { timeout: 100 }))
      .resolves.toEqual({ stderr: "", stdout: "ok" });
    const child = value.children[0]!;
    expect(child.stdout.listenerCount("data")).toBe(0);
    expect(child.stderr.listenerCount("data")).toBe(0);
    child.stdin.emit("error", new Error("late EPIPE"));
    child.stdin.emit("close");
    expect(child.stdin.listenerCount("error")).toBe(0);
  });

  it("handles the spawn-to-abort-listener race and stdin callback errors", async () => {
    const controller = new AbortController();
    const child = new Child();
    const spawn = (() => {
      controller.abort();
      return child;
    }) as unknown as DockerCommandSpawn;
    const executors = createDockerTargetExecutors({ spawn });
    await expect(executors.resource("docker", [], {
      signal: controller.signal, timeout: 100
    })).rejects.toThrow("Docker command failed");
    expect(child.kills).toBe(1);

    const broken = new Child();
    broken.stdin.end = ((_chunk: unknown, callback: (error?: Error) => void) => {
      callback(new Error("private EPIPE"));
      return broken.stdin;
    }) as typeof broken.stdin.end;
    const brokenSpawn = (() => broken) as unknown as DockerCommandSpawn;
    await expect(createDockerTargetExecutors({ spawn: brokenSpawn })
      .secret("docker", ["run"], {
        stdin: Uint8Array.from([115, 101, 99, 114, 101, 116]),
        timeout: 100
      })).rejects.toThrow("Docker command failed");
    expect(broken.kills).toBe(1);

    const synchronous = new Child();
    const end = vi.spyOn(synchronous.stdin, "end");
    synchronous.kill = (() => {
      synchronous.kills += 1;
      synchronous.emit("close", null);
      return true;
    }) as typeof synchronous.kill;
    const synchronousAbort = new AbortController();
    const synchronousSpawn = (() => {
      synchronousAbort.abort();
      return synchronous;
    }) as unknown as DockerCommandSpawn;
    await expect(createDockerTargetExecutors({ spawn: synchronousSpawn })
      .resource("docker", [], {
        signal: synchronousAbort.signal, timeout: 100
      })).rejects.toThrow("Docker command failed");
    expect(end).not.toHaveBeenCalled();
  });

  it("rejects proxy, accessor, sparse, and decorated runtime inputs without invoking getters", async () => {
    expect(() => createDockerTargetExecutors(new Proxy({}, {}))).toThrow("Docker command failed");
    let reads = 0;
    const accessorFactory = Object.defineProperty({}, "spawn", {
      enumerable: true,
      get: () => { reads += 1; return vi.fn(); }
    });
    expect(() => createDockerTargetExecutors(accessorFactory)).toThrow("Docker command failed");
    expect(reads).toBe(0);

    const spawn = vi.fn() as unknown as DockerCommandSpawn;
    const executors = createDockerTargetExecutors({ spawn });
    const accessorOptions = Object.defineProperty({}, "timeout", {
      enumerable: true,
      get: () => { reads += 1; return 100; }
    });
    await expect(executors.resource("docker", [], accessorOptions as never))
      .rejects.toThrow("Docker command failed");
    await expect(executors.resource("docker", [], new Proxy({ timeout: 100 }, {}) as never))
      .rejects.toThrow("Docker command failed");
    expect(reads).toBe(0);
    expect(spawn).not.toHaveBeenCalled();

    const accessorArgs: string[] = [];
    Object.defineProperty(accessorArgs, "0", {
      enumerable: true,
      get: () => { reads += 1; return "version"; }
    });
    accessorArgs.length = 1;
    expect(() => executeDockerCommandCore(spawn, "docker", accessorArgs, {
      binary: false, timeout: 100
    })).toThrow("Docker command failed");
    expect(reads).toBe(0);
    expect(() => executeDockerCommandCore(spawn, "docker", Array(1), {
      binary: false, timeout: 100
    })).toThrow("Docker command failed");
    const decorated = ["version"];
    Object.defineProperty(decorated, "extra", { enumerable: true, value: true });
    expect(() => executeDockerCommandCore(spawn, "docker", decorated, {
      binary: false, timeout: 100
    })).toThrow("Docker command failed");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("does not reflect secret stdin through terminal failures", async () => {
    const marker = "spfs_DO_NOT_REFLECT_7f83";
    const value = fixture((child) => {
      child.stdin.resume();
      child.stderr.end(marker);
      child.stdout.end();
      child.emit("close", 2);
    });
    let thrown: unknown;
    try {
      await value.executors.secret("docker", ["run"], {
        stdin: Buffer.from(marker), timeout: 100
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(String(thrown)).not.toContain(marker);
    expect((thrown as Error).stack).not.toContain(marker);
    expect(Object.values(thrown as object).join(" ")).not.toContain(marker);
  });

  it("classifies only eligible exact resource and secret failures", async () => {
    const failure = (message: string) => fixture((child) => {
      child.stderr.end(message);
      child.stdout.end();
      child.emit("close", 1);
    });
    const missing = failure("Error response from daemon: No such volume: spfv_dead");
    await expect(missing.executors.resource("docker", ["volume", "inspect", "spfv_dead"], { timeout: 100 }))
      .rejects.toMatchObject({ kind: "not_found" } satisfies Partial<DockerResourceProviderError>);
    const docker29MissingNetwork = failure("Error response from daemon: network spfn_dead not found");
    await expect(docker29MissingNetwork.executors.resource("docker", ["network", "inspect", "spfn_dead"], { timeout: 100 }))
      .rejects.toMatchObject({ kind: "not_found" } satisfies Partial<DockerResourceProviderError>);
    const docker29WrongNetwork = failure("Error response from daemon: network spfn_attacker not found");
    await expect(docker29WrongNetwork.executors.resource("docker", ["network", "inspect", "spfn_dead"], { timeout: 100 }))
      .rejects.not.toBeInstanceOf(DockerResourceProviderError);
    const docker29IneligibleNetwork = failure("Error response from daemon: network spfn_dead not found");
    await expect(docker29IneligibleNetwork.executors.resource("docker", ["network", "create", "spfn_dead"], { timeout: 100 }))
      .rejects.not.toBeInstanceOf(DockerResourceProviderError);
    const collision = failure("Error response from daemon: volume spfs_dead already exists");
    await expect(collision.executors.secret("docker", ["volume", "create", "spfs_dead"], { timeout: 100 }))
      .rejects.toMatchObject({ kind: "collision" } satisfies Partial<DockerSecretProviderError>);
    const ineligible = failure("Error response from daemon: No such volume: spfv_dead");
    await expect(ineligible.executors.resource("docker", ["volume", "create", "spfv_dead"], { timeout: 100 }))
      .rejects.not.toBeInstanceOf(DockerResourceProviderError);
    const wrongNoun = failure("Error response from daemon: No such container: spfv_dead");
    await expect(wrongNoun.executors.resource("docker", ["volume", "inspect", "spfv_dead"], { timeout: 100 }))
      .rejects.not.toBeInstanceOf(DockerResourceProviderError);
    const unknown = failure("permission denied");
    await expect(unknown.executors.resource("docker", ["volume", "inspect", "x"], { timeout: 100 }))
      .rejects.not.toBeInstanceOf(DockerResourceProviderError);

    const attachment = failure("Error response from daemon: No such container: dead");
    await expect(attachment.executors.attachment("docker", ["container", "inspect", "dead"], { timeout: 100 }))
      .rejects.toBeInstanceOf(DockerOrganizationAttachmentProviderError);
    const world = failure('Error response from daemon: Conflict. The container name "world" is already in use by container "aaaaaaaaaaaa".');
    await expect(world.executors.world("docker", ["container", "create"], { timeout: 100 }))
      .rejects.toBeInstanceOf(DockerWorldServiceProviderError);
    const stoppedSecret = failure("Error response from daemon: No such container: secret-reader");
    await expect(stoppedSecret.executors.secret("docker", ["container", "stop", "secret-reader"], { timeout: 100 }))
      .rejects.toBeInstanceOf(DockerSecretProviderError);
    const contextual = failure("Error response from daemon: No such volume: spfv_dead");
    await expect(contextual.executors.resource("docker", [
      "--context", "remote_1", "volume", "inspect", "spfv_dead"
    ], { timeout: 100 })).rejects.toBeInstanceOf(DockerResourceProviderError);
    const snapshotted = failure("Error response from daemon: No such volume: spfv_dead");
    await expect(snapshotted.executors.resource("docker", [
      "--config", "/tmp/private-context", "--context", "spfn_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "volume", "inspect", "spfv_dead"
    ], { timeout: 100 })).rejects.toBeInstanceOf(DockerResourceProviderError);
    for (const hostile of [
      ["--host", "ssh://forbidden", "volume", "inspect", "spfv_dead"],
      ["--config", "relative", "--context", "remote_1", "volume", "inspect", "spfv_dead"],
      ["--config", "/tmp/private context", "--context", "remote_1", "volume", "inspect", "spfv_dead"],
      ["--config", "/tmp/private", "--context", "BAD", "volume", "inspect", "spfv_dead"]
    ]) {
      const rejected = failure("Error response from daemon: No such volume: spfv_dead");
      await expect(rejected.executors.resource("docker", hostile, { timeout: 100 }))
        .rejects.not.toBeInstanceOf(DockerResourceProviderError);
    }
    const wrongCollisionNoun = failure("Error response from daemon: network with name world already exists");
    await expect(wrongCollisionNoun.executors.world("docker", ["container", "create", "world"], { timeout: 100 }))
      .rejects.not.toBeInstanceOf(DockerWorldServiceProviderError);
    const nullExit = fixture((child) => {
      child.stderr.end("Error response from daemon: No such volume: spfv_dead");
      child.stdout.end();
      child.emit("close", null);
    });
    await expect(nullExit.executors.resource("docker", ["volume", "inspect", "spfv_dead"], { timeout: 100 }))
      .rejects.not.toBeInstanceOf(DockerResourceProviderError);
    const artifact = failure("Error response from daemon: No such image: private");
    await expect(artifact.executors.artifact("docker", ["image", "inspect", "private"], { timeout: 100 }))
      .rejects.toBeInstanceOf(DockerArtifactProviderError);
    const artifactWrongReference = failure("Error response from daemon: No such image: attacker");
    await expect(artifactWrongReference.executors.artifact("docker", ["image", "inspect", "private"], { timeout: 100 }))
      .rejects.not.toBeInstanceOf(DockerArtifactProviderError);
    const artifactWrongRole = failure("Error response from daemon: No such image: private");
    await expect(artifactWrongRole.executors.artifact("docker", ["image", "rm", "private"], { timeout: 100 }))
      .rejects.not.toBeInstanceOf(DockerArtifactProviderError);
  });

  it.each([
    ["untagged local name", "spfb_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "spfb_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:latest", true],
    ["untagged repository", "owner/image", "owner/image:latest", true],
    ["untagged registry port", "registry.example:5000/owner/image", "registry.example:5000/owner/image:latest", true],
    ["exact explicit tag", "owner/image:stable", "owner/image:stable", true],
    ["explicit tag", "owner/image:stable", "owner/image:stable:latest", false],
    ["registry-port explicit tag", "registry.example:5000/owner/image:stable", "registry.example:5000/owner/image:stable:latest", false],
    ["exact digest", `owner/image@sha256:${"a".repeat(64)}`, `owner/image@sha256:${"a".repeat(64)}`, true],
    ["digest", `owner/image@sha256:${"a".repeat(64)}`, `owner/image@sha256:${"a".repeat(64)}:latest`, false],
    ["different tag", "owner/image", "owner/image:stable", false],
    ["different name", "owner/image", "attacker/image:latest", false],
    ["different case", "owner/image", "Owner/image:latest", false],
    ["name prefix", "owner/image", "xowner/image:latest", false],
    ["name suffix", "owner/image", "owner/imagex:latest", false]
  ])("classifies Docker's missing-image reference for %s without broadening identity", async (
    _name, requested, reported, accepted
  ) => {
    const value = fixture((child) => {
      child.stderr.end(`Error response from daemon: No such image: ${reported}`);
      child.stdout.end();
      child.emit("close", 1);
    });
    const result = expect(value.executors.artifact(
      "docker", ["image", "inspect", requested], { timeout: 100 }
    )).rejects;
    if (accepted) await result.toBeInstanceOf(DockerArtifactProviderError);
    else await result.not.toBeInstanceOf(DockerArtifactProviderError);
  });

  it.each([
    ["resource old inspect", "resource", ["volume", "inspect", "spfv_dead"], "Error response from daemon: No such volume: spfv_dead", true],
    ["resource Docker 29 inspect", "resource", ["volume", "inspect", "spfv_dead"], "Error response from daemon: get spfv_dead: no such volume", true],
    ["secret formatted inspect", "secret", ["volume", "inspect", "--format", "{{.Name}}", "spfs_dead"], "Error response from daemon: get spfs_dead: no such volume", true],
    ["secret remove", "secret", ["volume", "rm", "spfs_dead"], "Error response from daemon: get spfs_dead: no such volume", true],
    ["mismatched name", "resource", ["volume", "inspect", "spfv_dead"], "Error response from daemon: get spfv_other: no such volume", false],
    ["name prefix", "resource", ["volume", "inspect", "spfv_dead"], "Error response from daemon: get xspfv_dead: no such volume", false],
    ["name suffix", "resource", ["volume", "inspect", "spfv_dead"], "Error response from daemon: get spfv_deadx: no such volume", false],
    ["name case", "resource", ["volume", "inspect", "spfv_dead"], "Error response from daemon: get SPFV_dead: no such volume", false],
    ["wrong noun", "resource", ["network", "inspect", "spfv_dead"], "Error response from daemon: get spfv_dead: no such volume", false],
    ["wrong mutation", "resource", ["volume", "ls", "spfv_dead"], "Error response from daemon: get spfv_dead: no such volume", false],
    ["wrong role", "artifact", ["volume", "inspect", "spfv_dead"], "Error response from daemon: get spfv_dead: no such volume", false],
    ["extra text", "resource", ["volume", "inspect", "spfv_dead"], "Error response from daemon: get spfv_dead: no such volume now", false],
    ["extra line", "resource", ["volume", "inspect", "spfv_dead"], "Error response from daemon: get spfv_dead: no such volume\nextra", false],
    ["forged remove flags", "secret", ["volume", "rm", "--force", "spfs_dead"], "Error response from daemon: get spfs_dead: no such volume", false]
  ] as const)("classifies only exact eligible missing-volume failures: %s", async (
    _name, kind, args, message, accepted
  ) => {
    const value = fixture((child) => {
      child.stderr.end(message);
      child.stdout.end();
      child.emit("close", 1);
    });
    const executor = value.executors[kind];
    let classified = false;
    try {
      await executor("docker", [...args], { timeout: 100 });
    } catch (error) {
      classified = error instanceof DockerResourceProviderError
        || error instanceof DockerSecretProviderError;
    }
    expect(classified).toBe(accepted);
    // Only the typed absence permits a caller to continue into create/removal.
    let downstreamEffects = 0;
    if (classified) downstreamEffects += 1;
    expect(downstreamEffects).toBe(accepted ? 1 : 0);
    expect(value.calls).toHaveLength(1);
  });
});
