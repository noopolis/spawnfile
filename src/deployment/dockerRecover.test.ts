import { describe, expect, it, vi } from "vitest";

import { dockerDeploymentLabelKeys } from "./dockerLabels.js";
import { recoverDockerDeploymentRecords } from "./dockerRecover.js";
import { createEndpointFingerprint } from "./target.js";

const labelsFor = (deployment: string, unit = `${deployment}-container`): Record<string, string> => ({
  [dockerDeploymentLabelKeys.compileFingerprint]: "sf1:abc123",
  [dockerDeploymentLabelKeys.deployment]: deployment,
  [dockerDeploymentLabelKeys.project]: "pi-harness-org",
  [dockerDeploymentLabelKeys.unit]: unit,
  [dockerDeploymentLabelKeys.version]: "0.1"
});

describe("recoverDockerDeploymentRecords", () => {
  it("recovers deployment records from Docker context labels", async () => {
    const execFile = vi.fn(async (_file: string, args: string[]) => {
      if (args.includes("context") && args.includes("inspect")) {
        return { stderr: "", stdout: '"ssh://deploy@example.com"\n' };
      }
      if (args.includes("ps")) {
        return { stderr: "", stdout: "abc123\n" };
      }
      if (args.includes("inspect") && args.includes("abc123")) {
        return {
          stderr: "",
          stdout: JSON.stringify([
            {
              Config: {
                Image: "spawnfile-pi-hotadd-dev:local",
                Labels: labelsFor("hotadd")
              },
              Created: "2026-06-21T16:00:00.000Z",
              Id: "abc123",
              Image: "sha256:image123",
              Name: "/spawnfile-pi-hotadd-dev"
            }
          ])
        };
      }
      throw new Error(`unexpected docker args: ${args.join(" ")}`);
    });

    const records = await recoverDockerDeploymentRecords({
      contains: [{ id: "agent:mapper", kind: "agent" }],
      context: "gpu-4090",
      execFile,
      outputDirectory: "/project/.spawn-dev",
      projectLabel: "pi-harness-org",
      runtimeInstanceIds: ["pi-app"],
      sourceRoot: "/project/Spawnfile"
    });

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      path: "docker-context://gpu-4090/hotadd",
      record: {
        compile_fingerprint: "sf1:abc123",
        created_at: "2026-06-21T16:00:00.000Z",
        name: "hotadd",
        source: { kind: "project", root: "/project/Spawnfile" },
        target: {
          endpoint_fingerprint: createEndpointFingerprint("ssh://deploy@example.com"),
          kind: "context",
          name: "gpu-4090"
        },
        units: [
          expect.objectContaining({
            container_id: "abc123",
            container_name: "spawnfile-pi-hotadd-dev",
            contains: [{ id: "agent:mapper", kind: "agent" }],
            id: "hotadd-container",
            image_id: "sha256:image123",
            image_tag: "spawnfile-pi-hotadd-dev:local",
            runtime_instances: ["pi-app"]
          })
        ]
      }
    });
    expect(execFile.mock.calls.map(([, args]) => args)).toEqual([
      [
        "context",
        "inspect",
        "gpu-4090",
        "--format",
        "{{json .Endpoints.docker.Host}}"
      ],
      [
        "--context",
        "gpu-4090",
        "ps",
        "-a",
        "--filter",
        `label=${dockerDeploymentLabelKeys.version}`,
        "--format",
        "{{.ID}}"
      ],
      ["--context", "gpu-4090", "inspect", "abc123"]
    ]);
  });

  it("filters containers to the requested project label", async () => {
    const execFile = vi.fn(async (_file: string, args: string[]) => {
      if (args.includes("context") && args.includes("inspect")) {
        return { stderr: "", stdout: '"ssh://deploy@example.com"\n' };
      }
      if (args.includes("ps")) {
        return { stderr: "", stdout: "abc123\nother123\n" };
      }
      return {
        stderr: "",
        stdout: JSON.stringify([
          {
            Config: { Image: "one:local", Labels: labelsFor("dev") },
            Id: "abc123",
            Image: "sha256:one",
            Name: "/one"
          },
          {
            Config: {
              Image: "other:local",
              Labels: {
                ...labelsFor("dev", "dev-other"),
                [dockerDeploymentLabelKeys.project]: "other-org"
              }
            },
            Id: "other123",
            Image: "sha256:other",
            Name: "/other"
          }
        ])
      };
    });

    const records = await recoverDockerDeploymentRecords({
      context: "gpu-4090",
      execFile,
      outputDirectory: "/project/.spawn",
      projectLabel: "pi-harness-org",
      sourceRoot: "/project/Spawnfile"
    });

    expect(records.map((entry) => entry.record.name)).toEqual(["dev"]);
    expect(records[0]?.record.units).toHaveLength(1);
  });

  it("returns no records when the context has no Spawnfile containers", async () => {
    const execFile = vi.fn(async (_file: string, args: string[]) => {
      if (args.includes("context") && args.includes("inspect")) {
        return { stderr: "", stdout: '"ssh://deploy@example.com"\n' };
      }
      if (args.includes("ps")) {
        return { stderr: "", stdout: "\n" };
      }
      throw new Error(`unexpected docker args: ${args.join(" ")}`);
    });

    await expect(recoverDockerDeploymentRecords({
      context: "gpu-4090",
      execFile,
      outputDirectory: "/project/.spawn",
      projectLabel: "pi-harness-org",
      sourceRoot: "/project/Spawnfile"
    })).resolves.toEqual([]);

    expect(execFile).toHaveBeenCalledTimes(2);
  });

  it("rejects duplicate recovered containers for the same deployment unit", async () => {
    const execFile = vi.fn(async (_file: string, args: string[]) => {
      if (args.includes("context") && args.includes("inspect")) {
        return { stderr: "", stdout: '"ssh://deploy@example.com"\n' };
      }
      if (args.includes("ps")) {
        return { stderr: "", stdout: "abc123\ndef456\n" };
      }
      return {
        stderr: "",
        stdout: JSON.stringify([
          {
            Config: { Image: "one:local", Labels: labelsFor("dev", "dev-container") },
            Id: "abc123",
            Image: "sha256:one",
            Name: "/one"
          },
          {
            Config: { Image: "two:local", Labels: labelsFor("dev", "dev-container") },
            Id: "def456",
            Image: "sha256:two",
            Name: "/two"
          }
        ])
      };
    });

    await expect(recoverDockerDeploymentRecords({
      context: "gpu-4090",
      execFile,
      outputDirectory: "/project/.spawn",
      projectLabel: "pi-harness-org",
      sourceRoot: "/project/Spawnfile"
    })).rejects.toThrow("multiple containers for unit");
  });
});
