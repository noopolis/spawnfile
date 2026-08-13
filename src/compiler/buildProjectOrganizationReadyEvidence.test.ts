import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { removeDirectory, writeUtf8File } from "../filesystem/index.js";

vi.mock("./compileProject.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./compileProject.js")>();
  return { ...actual, compileProject: vi.fn() };
});

import { buildProject } from "./buildProject.js";
import { compileProject, type CompileProjectResult } from "./compileProject.js";
import type { OrganizationReadinessEvidence } from "./organizationReadyEvidence.js";

const evidence: OrganizationReadinessEvidence = Object.freeze({
  compileFingerprint: "sf1:000000000000", compileVersion: "0.1", hasExternalMoltnet: false,
  networks: Object.freeze([]), organizationMembers: Object.freeze([]), projectLabel: "generic",
  version: "spawnfile.organization-ready-evidence.v1", worldBindings: null
});

describe("buildProject organization readiness evidence", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("preserves the exact compiler-owned nested evidence identity through its spread", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-build-evidence-"));
    const homeDirectory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-build-home-"));
    vi.stubEnv("SPAWNFILE_HOME", homeDirectory);
    try {
      await writeUtf8File(path.join(directory, "Dockerfile"), "FROM scratch\n");
      vi.mocked(compileProject).mockResolvedValue({
        organizationReadinessEvidence: evidence,
        outputDirectory: directory,
        report: {
          compile_fingerprint: "sf1:000000000000",
          root: "/tmp/project/Spawnfile"
        } as CompileProjectResult["report"],
        reportPath: path.join(directory, "spawnfile-report.json")
      });
      const result = await buildProject("/tmp/project", { buildRunner: async () => undefined });
      expect(result.organizationReadinessEvidence).toBe(evidence);
      expect(Object.isFrozen(result.organizationReadinessEvidence)).toBe(true);
      expect(result.imageBuild).toBeDefined();
    } finally {
      await Promise.all([removeDirectory(directory), removeDirectory(homeDirectory)]);
    }
  });
});
