import { afterEach, describe, expect, it } from "vitest";

import {
  createDockerDeploymentTarget,
  createEndpointFingerprint,
  dockerContextNameForTarget,
  dockerHostValueForTarget,
  resolveDockerDeploymentTarget,
  verifyDockerDeploymentTarget
} from "./target.js";

const originalDockerHost = process.env.DOCKER_HOST;

afterEach(() => {
  if (originalDockerHost === undefined) {
    delete process.env.DOCKER_HOST;
  } else {
    process.env.DOCKER_HOST = originalDockerHost;
  }
});

describe("deployment targets", () => {
  it("creates stable redacted endpoint fingerprints", () => {
    const first = createEndpointFingerprint("unix:///var/run/docker.sock");
    const second = createEndpointFingerprint("unix:///var/run/docker.sock");

    expect(first).toBe(second);
    expect(first).toMatch(/^sha256:[a-f0-9]{32}$/);
    expect(first).not.toContain("docker.sock");
  });

  it("creates docker context targets without storing raw endpoints", () => {
    expect(createDockerDeploymentTarget({
      context: "hetzner",
      endpoint: "ssh://deploy@example.com"
    })).toEqual({
      endpoint_fingerprint: expect.stringMatching(/^sha256:[a-f0-9]{32}$/),
      kind: "context",
      name: "hetzner"
    });
  });

  it("resolves docker context endpoints through docker inspect", async () => {
    const execFile = async () => ({
      stderr: "",
      stdout: "\"ssh://deploy@example.com\"\n"
    });

    const target = await resolveDockerDeploymentTarget({
      context: "hetzner",
      execFile
    });

    expect(target).toEqual({
      endpoint_fingerprint: createEndpointFingerprint("ssh://deploy@example.com"),
      kind: "context",
      name: "hetzner"
    });
  });

  it("supports host targets without storing fingerprints", async () => {
    const target = await resolveDockerDeploymentTarget({
      dockerHost: "ssh://ops@example.com"
    });

    expect(target).toEqual({
      kind: "host",
      value: "ssh://ops@example.com"
    });
    expect(dockerHostValueForTarget(target)).toBe("ssh://ops@example.com");
    await expect(verifyDockerDeploymentTarget(target)).resolves.toBeNull();
  });

  it("uses DOCKER_HOST when no context is selected", async () => {
    process.env.DOCKER_HOST = "ssh://env@example.com";
    const target = await resolveDockerDeploymentTarget({
      execFile: async () => {
        throw new Error("docker context should not be inspected");
      }
    });

    expect(target).toEqual({
      kind: "host",
      value: "ssh://env@example.com"
    });
  });

  it("detects context endpoint drift", async () => {
    await expect(verifyDockerDeploymentTarget(
      createDockerDeploymentTarget({
        context: "hetzner",
        endpoint: "ssh://old@example.com"
      }),
      {
        execFile: async () => ({ stderr: "", stdout: "\"ssh://new@example.com\"\n" })
      }
    )).rejects.toMatchObject({
      code: "runtime_error",
      message: expect.stringContaining("endpoint changed")
    });
  });

  it("covers invalid endpoints, plain endpoint output, legacy contexts, and resolver failures", async () => {
    expect(() => createEndpointFingerprint("  ")).toThrow(/must not be empty/);
    expect(() => createDockerDeploymentTarget({ context: "default" })).toThrow(/require both/);

    await expect(resolveDockerDeploymentTarget({
      context: "default",
      execFile: async () => ({ stderr: "", stdout: "" })
    })).rejects.toMatchObject({
      code: "runtime_error",
      message: expect.stringContaining("endpoint was empty")
    });
    await expect(resolveDockerDeploymentTarget({
      context: "default",
      execFile: async () => {
        throw new Error("boom");
      }
    })).rejects.toMatchObject({
      code: "runtime_error",
      message: expect.stringContaining("Unable to resolve Docker context")
    });
    await expect(resolveDockerDeploymentTarget({
      context: "default",
      execFile: async () => {
        throw "plain failure";
      }
    })).rejects.toMatchObject({
      code: "runtime_error",
      message: expect.stringContaining("plain failure")
    });

    await expect(resolveDockerDeploymentTarget({
      context: "default",
      execFile: async () => ({ stderr: "", stdout: "ssh://plain-endpoint\n" })
    })).resolves.toEqual({
      endpoint_fingerprint: createEndpointFingerprint("ssh://plain-endpoint"),
      kind: "context",
      name: "default"
    });

    expect(dockerContextNameForTarget({
      context: "legacy",
      endpoint_fingerprint: createEndpointFingerprint("ssh://legacy"),
      kind: "docker-context"
    })).toBe("legacy");
    expect(dockerHostValueForTarget({
      endpoint_fingerprint: createEndpointFingerprint("ssh://legacy"),
      kind: "context",
      name: "legacy"
    })).toBeNull();
    await expect(verifyDockerDeploymentTarget({
      endpoint_fingerprint: createEndpointFingerprint("ssh://legacy"),
      kind: "unknown"
    } as never)).resolves.toBeNull();
  });
});
