import { describe, expect, it } from "vitest";

import { buildDistributionReport } from "./buildDistributionReport.js";
import { parseDistributionReport } from "./distributionReportSchema.js";

const validReport = () =>
  buildDistributionReport({
    envVariables: [
      { categories: ["model"], generated: false, name: "OPENAI_API_KEY", required: true }
    ],
    generatedAt: "2026-06-13T00:00:00.000Z",
    internalPorts: [],
    modelAuthMethods: { openai: "api_key" },
    moltnetNetworks: [],
    organization: { agents: [], project: "research-cell", teams: [] },
    persistentMounts: [],
    portMappings: [],
    publishedPorts: [],
    resources: [],
    runtimeInstances: []
  });

describe("parseDistributionReport", () => {
  it("accepts a freshly built report", () => {
    const report = validReport();
    expect(parseDistributionReport(report)).toEqual(report);
  });

  it("rejects a wrong schema version", () => {
    const report = { ...validReport(), version: "spawnfile.distribution-report.v2" };
    expect(() => parseDistributionReport(report)).toThrow(/Invalid distribution report/);
  });

  it("rejects a report with unexpected extra keys", () => {
    const report = { ...validReport(), surprise: true };
    expect(() => parseDistributionReport(report)).toThrow(/Invalid distribution report/);
  });

  it("rejects a report missing required sections", () => {
    const report = validReport() as unknown as Record<string, unknown>;
    delete report.secrets;
    expect(() => parseDistributionReport(report)).toThrow(/Invalid distribution report/);
  });

  it("rejects malformed secret entries", () => {
    const report = validReport();
    (report.secrets.model as unknown) = [{ name: "X" }];
    expect(() => parseDistributionReport(report)).toThrow(/Invalid distribution report/);
  });
});
