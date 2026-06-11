import { describe, expect, it } from "vitest";

import type { LoadedCompileReport } from "./compileReport.js";
import { createCompiledContainerObservations } from "./compiledContainerObservations.js";

const loadedReport = (
  overrides: Partial<Extract<LoadedCompileReport, { kind: "loaded" }>["report"]> = {}
): Extract<LoadedCompileReport, { kind: "loaded" }> => ({
  kind: "loaded",
  report: {
    compileFingerprint: "sf1:abc",
    generatedAt: "2026-06-11T00:00:00.000Z",
    nodes: [],
    outputDirectory: "/project/.spawn",
    reportPath: "/project/.spawn/spawnfile-report.json",
    root: "/project/Spawnfile",
    runtimeInstances: [],
    ...overrides
  },
  reportPath: "/project/.spawn/spawnfile-report.json"
});

describe("compiled container observations", () => {
  it("returns no observations for a loaded report without container details", () => {
    expect(createCompiledContainerObservations(loadedReport())).toEqual([]);
  });

  it("reports unknown runtime workspace and one-sided port lists", () => {
    const observations = createCompiledContainerObservations(loadedReport({
      internalPorts: [8787],
      runtimeInstances: [
        {
          configPath: null,
          homePath: null,
          id: "agent-runtime",
          internalPort: null,
          nodeIds: [],
          publishedPort: null,
          runtime: "openclaw",
          workspacePath: null
        }
      ]
    }));

    expect(observations).toContainEqual(expect.objectContaining({
      key: "runtime.instance",
      message: "agent-runtime emits openclaw workspace unknown"
    }));
    expect(observations).toContainEqual(expect.objectContaining({
      key: "container.ports",
      message: "internal ports: 8787; published ports: none"
    }));
  });

  it("reports published-only ports", () => {
    expect(createCompiledContainerObservations(loadedReport({
      publishedPorts: [18787]
    }))).toContainEqual(expect.objectContaining({
      key: "container.ports",
      message: "internal ports: none; published ports: 18787"
    }));
  });
});
