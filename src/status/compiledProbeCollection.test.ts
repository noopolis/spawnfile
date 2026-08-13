import { describe, expect, it, vi } from "vitest";

import type { LoadedCompileReport } from "./compileReport.js";
import {
  collectCompiledProbeObservations,
  readCompiledProbeFile,
  unavailableCompiledProbeFile
} from "./compiledProbeCollection.js";
import type { StatusObservation } from "./types.js";

const missingReport: LoadedCompileReport = { kind: "missing", reportPath: "/out/spawnfile-report.json" };

describe("unavailableCompiledProbeFile", () => {
  it("always resolves null", async () => {
    await expect(unavailableCompiledProbeFile("/anything")).resolves.toBeNull();
  });
});

describe("readCompiledProbeFile", () => {
  it("resolves null instead of throwing for a missing file", async () => {
    await expect(readCompiledProbeFile("/definitely/not/a/real/path.txt")).resolves.toBeNull();
  });
});

describe("collectCompiledProbeObservations", () => {
  it("concatenates lifecycle and moltnet-wiring probe observations", async () => {
    const observations = await collectCompiledProbeObservations(
      missingReport,
      "/out",
      vi.fn(async () => null)
    );

    const keys = new Set(observations.map((entry) => entry.key));
    expect(keys.has("lifecycle.instance.coverage")).toBe(true);
    expect(keys.has("network.wiring.node_config")).toBe(true);
    expect(observations.every((entry) => entry.severity === "unknown")).toBe(true);
  });

  it("uses injected collectors when provided, instead of the real probe modules", async () => {
    const lifecycleObservation: StatusObservation = {
      key: "lifecycle.instance.coverage",
      label: "OK lifecycle.instance.coverage",
      message: "stubbed",
      severity: "ok",
      source: "compile_report",
      subject: "compile"
    };
    const wiringObservation: StatusObservation = {
      key: "network.wiring.node_config",
      label: "OK network.wiring.node_config",
      message: "stubbed",
      severity: "ok",
      source: "compile_report",
      subject: "compile"
    };
    const collectLifecycleProbeObservations = vi.fn(async () => [lifecycleObservation]);
    const collectMoltnetWiringProbeObservations = vi.fn(async () => [wiringObservation]);

    const observations = await collectCompiledProbeObservations(
      missingReport,
      "/out",
      vi.fn(async () => null),
      { collectLifecycleProbeObservations, collectMoltnetWiringProbeObservations }
    );

    expect(observations).toEqual([lifecycleObservation, wiringObservation]);
    expect(collectLifecycleProbeObservations).toHaveBeenCalledWith({
      loadedReport: missingReport,
      outputDirectory: "/out",
      readFile: expect.any(Function)
    });
    expect(collectMoltnetWiringProbeObservations).toHaveBeenCalledWith({
      loadedReport: missingReport,
      outputDirectory: "/out",
      readFile: expect.any(Function)
    });
  });
});
