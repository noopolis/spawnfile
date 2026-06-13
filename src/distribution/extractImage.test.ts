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
});
