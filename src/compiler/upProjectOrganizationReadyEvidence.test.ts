import { describe, expect, it, vi } from "vitest";

vi.mock("./buildProject.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./buildProject.js")>();
  return { ...actual, buildProject: vi.fn() };
});

import { buildProject, type BuildProjectResult } from "./buildProject.js";
import { upProject } from "./upProject.js";
import type { OrganizationReadinessEvidence } from "./organizationReadyEvidence.js";

const evidence: OrganizationReadinessEvidence = Object.freeze({
  compileFingerprint: "sf1:000000000000", compileVersion: "0.1", hasExternalMoltnet: false,
  networks: Object.freeze([]), organizationMembers: Object.freeze([]), projectLabel: "generic",
  version: "spawnfile.organization-ready-evidence.v1", worldBindings: null
});

describe("upProject organization readiness evidence", () => {
  it("preserves the exact build evidence identity through its existing spread", async () => {
    vi.mocked(buildProject).mockResolvedValue({
      imageTag: "spawnfile-evidence",
      organizationReadinessEvidence: evidence,
      outputDirectory: "/tmp/spawnfile-up-evidence",
      report: {
        container: {
          dockerfile: "Dockerfile", entrypoint: "entrypoint.sh", env_example: ".env.example",
          model_secrets_required: [], ports: [], runtime_homes: [], runtime_instances: [],
          runtime_secrets_required: [], runtimes_installed: [], secrets_required: []
        }, diagnostics: [], nodes: [], root: "/tmp/project", spawnfile_version: "0.1"
      } as BuildProjectResult["report"],
      reportPath: "/tmp/spawnfile-up-evidence/spawnfile-report.json"
    });
    const result = await upProject("/tmp/project", {
      buildRunner: async () => undefined,
      runRunner: async () => undefined
    });
    expect(result.organizationReadinessEvidence).toBe(evidence);
    expect(Object.isFrozen(result.organizationReadinessEvidence)).toBe(true);
  });
});
