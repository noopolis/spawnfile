import { describe, expect, it } from "vitest";

import { buildDistributionReport } from "./buildDistributionReport.js";
import { extractImageReport, resolveDockerBaseArgs } from "./extractImage.js";
import { DISTRIBUTION_REPORT_IMAGE_PATH } from "./types.js";

const distributionReport = () =>
  buildDistributionReport({
    envVariables: [],
    generatedAt: "2026-06-13T00:00:00.000Z",
    internalPorts: [],
    modelAuthMethods: {},
    moltnetNetworks: [],
    organization: { agents: [], project: "org", teams: [] },
    persistentMounts: [],
    portMappings: [],
    publishedPorts: [],
    resources: [],
    runtimeInstances: []
  });

const tarOf = (content: Buffer): Buffer => {
  const header = Buffer.alloc(512);
  header.write("spawnfile-report.json", 0, "ascii");
  header.write(content.length.toString(8).padStart(11, "0") + "\0", 124, "ascii");
  header.write("0", 156, "ascii");
  const padded = Buffer.alloc(Math.ceil(content.length / 512) * 512);
  content.copy(padded);
  return Buffer.concat([header, padded, Buffer.alloc(1024)]);
};

const runnerFor = (labels: Record<string, string>, reportJson: string) =>
  async (args: string[]): Promise<Buffer> => {
    if (args[0] === "image" && args[1] === "inspect") {
      return Buffer.from(JSON.stringify(labels));
    }
    if (args[0] === "cp") {
      return tarOf(Buffer.from(reportJson));
    }
    return Buffer.from("");
  };

const recordingRunnerFor = (
  calls: string[][],
  labels: Record<string, string>,
  reportJson: string
) =>
  async (args: string[]): Promise<Buffer> => {
    calls.push(args);
    if (args[0] === "image" && args[1] === "inspect") {
      return Buffer.from(JSON.stringify(labels));
    }
    if (args[0] === "cp") {
      return tarOf(Buffer.from(reportJson));
    }
    return Buffer.from("");
  };

describe("resolveDockerBaseArgs", () => {
  it("prefers context, then host, else none", () => {
    expect(resolveDockerBaseArgs({ dockerContext: "vm1" })).toEqual(["--context", "vm1"]);
    expect(resolveDockerBaseArgs({ dockerHost: "ssh://h" })).toEqual(["--host", "ssh://h"]);
    expect(resolveDockerBaseArgs({})).toEqual([]);
  });
});

describe("extractImageReport", () => {
  const report = distributionReport();
  const labels = {
    "com.spawnfile.compile_fingerprint": report.compile_fingerprint,
    "com.spawnfile.image_contract": "spawnfile.image.v1",
    "com.spawnfile.project": "org",
    "com.spawnfile.report": DISTRIBUTION_REPORT_IMAGE_PATH
  };

  it("extracts and validates the embedded report", async () => {
    const inspection = await extractImageReport("you/org:1.0.0", {
      runDocker: runnerFor(labels, JSON.stringify(report))
    });
    expect(inspection.compileFingerprint).toBe(report.compile_fingerprint);
    expect(inspection.report.organization.project).toBe("org");
  });

  it("pulls the image when requested", async () => {
    const calls: string[][] = [];
    await extractImageReport("you/org:1.0.0", {
      pull: true,
      runDocker: recordingRunnerFor(calls, labels, JSON.stringify(report))
    });

    expect(calls[0]).toEqual(["pull", "you/org:1.0.0"]);
  });

  it("rejects an image without the contract label", async () => {
    await expect(
      extractImageReport("x:1", { runDocker: runnerFor({}, JSON.stringify(report)) })
    ).rejects.toThrow(/not a Spawnfile image/);
  });

  it("rejects an unsupported contract version", async () => {
    await expect(
      extractImageReport("x:1", {
        runDocker: runnerFor(
          { ...labels, "com.spawnfile.image_contract": "spawnfile.image.v2" },
          JSON.stringify(report)
        )
      })
    ).rejects.toThrow(/Unsupported image contract/);
  });

  it("rejects missing or non-identifier image labels", async () => {
    await expect(
      extractImageReport("x:1", {
        runDocker: runnerFor(
          { ...labels, "com.spawnfile.project": "bad project" },
          JSON.stringify(report)
        )
      })
    ).rejects.toThrow(/com.spawnfile.project/);
  });

  it("rejects unreadable image labels", async () => {
    await expect(
      extractImageReport("x:1", {
        runDocker: async (args) => {
          if (args[0] === "image" && args[1] === "inspect") {
            return Buffer.from("{not-json");
          }
          return Buffer.from("");
        }
      })
    ).rejects.toThrow(/Unable to read labels/);
  });

  it("translates missing local images into validation errors", async () => {
    await expect(
      extractImageReport("missing:1", {
        runDocker: async (args) => {
          if (args[0] === "image" && args[1] === "inspect") {
            throw new Error("No such image: missing:1");
          }
          return Buffer.from("");
        }
      })
    ).rejects.toThrow(/is not available locally/);
  });

  it("preserves unexpected image inspect failures", async () => {
    await expect(
      extractImageReport("broken:1", {
        runDocker: async (args) => {
          if (args[0] === "image" && args[1] === "inspect") {
            throw new Error("docker daemon unavailable");
          }
          return Buffer.from("");
        }
      })
    ).rejects.toThrow(/docker daemon unavailable/);
  });

  it("rejects a fingerprint that disagrees with the label", async () => {
    await expect(
      extractImageReport("x:1", {
        runDocker: runnerFor(
          { ...labels, "com.spawnfile.compile_fingerprint": "sf1:000000000000" },
          JSON.stringify(report)
        )
      })
    ).rejects.toThrow(/fingerprint does not match/);
  });

  it("rejects embedded JSON that is not a valid report", async () => {
    await expect(
      extractImageReport("x:1", { runDocker: runnerFor(labels, "not json") })
    ).rejects.toThrow(/not valid JSON/);
  });

  it("uses the default label path when the report path label is absent", async () => {
    const calls: string[][] = [];
    const inspection = await extractImageReport("you/org:1.0.0", {
      runDocker: async (args) => {
        calls.push(args);
        if (args[0] === "image" && args[1] === "inspect") {
          const defaultLabels = {
            "com.spawnfile.compile_fingerprint": report.compile_fingerprint,
            "com.spawnfile.image_contract": "spawnfile.image.v1",
            "com.spawnfile.project": "org"
          };
          return Buffer.from(JSON.stringify(defaultLabels));
        }
        if (args[0] === "cp") {
          return tarOf(Buffer.from(JSON.stringify(report)));
        }
        return Buffer.from("");
      }
    });

    expect(inspection.compileFingerprint).toBe(report.compile_fingerprint);
    expect(
      calls.some(
        (args) =>
          args[0] === "cp" && args[1].endsWith(`:${DISTRIBUTION_REPORT_IMAGE_PATH}`) && args[2] === "-"
      )
    ).toBe(true);
    expect(calls).toContainEqual(["create", "--name", expect.any(String), "you/org:1.0.0"]);
  });

  it("rethrows unexpected image inspect failures that are not Error objects", async () => {
    await expect(
      extractImageReport("x:1", {
        runDocker: async (args) => {
          if (args[0] === "image" && args[1] === "inspect") {
            throw "image daemon panic";
          }
          return Buffer.from("");
        }
      })
    ).rejects.toThrow(/image daemon panic/);
  });

  it("falls back to empty labels when inspect emits null", async () => {
    await expect(
      extractImageReport("x:1", {
        runDocker: async (args) => {
          if (args[0] === "image" && args[1] === "inspect") {
            return Buffer.from("null");
          }
          return Buffer.from("");
        }
      })
    ).rejects.toThrow(/not a Spawnfile image/);
  });

  it("cleans up the helper container when report copy fails", async () => {
    const calls: string[][] = [];
    await expect(
      extractImageReport("x:1", {
        runDocker: async (args) => {
          calls.push(args);
          if (args[0] === "image" && args[1] === "inspect") {
            return Buffer.from(JSON.stringify(labels));
          }
          if (args[0] === "cp") {
            throw new Error("copy failed");
          }
          return Buffer.from("");
        }
      })
    ).rejects.toThrow(/copy failed/);

    expect(calls.some((args) => args[0] === "rm" && args[1] === "-f")).toBe(true);
  });
});
