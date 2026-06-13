import { describe, expect, it } from "vitest";

import type {
  DeploymentRecord,
  DockerInspectionResult,
  DockerUnitInspection
} from "../deployment/index.js";
import {
  createDeploymentObservations,
  createDeploymentSummaries
} from "./deployments.js";

const createRecord = (): DeploymentRecord => ({
  auth_profile: "prod",
  compile_fingerprint: "sf1:old",
  created_at: "2026-06-11T00:00:00.000Z",
  manager: "docker",
  name: "prod",
  output_directory: "/project/.spawn",
  source: { kind: "project", root: "/project" },
  target: {
    endpoint_fingerprint: "sha256:0123456789abcdef0123456789abcdef",
    kind: "context",
    name: "hetzner"
  },
  units: [
    {
      container_id: "abc123",
      container_name: "project-prod",
      contains: [{ id: "agent:analyst", kind: "agent" }],
      id: "prod-container",
      image_id: "image-123",
      image_tag: "project:latest",
      kind: "container",
      runtime_instances: ["agent-analyst"]
    }
  ],
  version: "spawnfile.deployment.v2"
});

const inspectionResult = (inspection: DockerUnitInspection): DockerInspectionResult =>
  new Map([["prod-container", inspection]]);

describe("status deployment summaries", () => {
  it("summarizes records without secret values and reports compile drift", () => {
    const summaries = createDeploymentSummaries([
      { path: "/project/.spawn/deployments/prod.json", record: createRecord() }
    ]);
    const observations = createDeploymentObservations(summaries, {
      compileFingerprint: "sf1:new",
      liveRequested: false,
      outputDirectory: "/project/.spawn",
      recover: false
    });

    expect(summaries[0]).toMatchObject({
      authProfile: "prod",
      name: "prod",
      target: "docker context hetzner",
      units: [expect.objectContaining({
        containerId: "abc123",
        contains: [{ id: "agent:analyst", kind: "agent" }],
        live: null
      })]
    });
    expect(JSON.stringify(summaries)).not.toContain("endpoint_fingerprint");
    expect(observations).toContainEqual(expect.objectContaining({
      key: "deployment.compile_fingerprint",
      severity: "warn",
      subject: "deployment:prod"
    }));
  });

  it("maps live container state into deployment observations", () => {
    const inspections: DockerInspectionResult = new Map([
      ["prod-container", {
        containerId: "abc123",
        drift: [],
        exists: true,
        exitCode: 1,
        finishedAt: "2026-06-11T01:00:00.000Z",
        imageId: "image-123",
        message: "container is not running (exited)",
        restartCount: 0,
        running: false,
        severity: "error",
        startedAt: "2026-06-11T00:00:00.000Z",
        status: "exited",
        unitId: "prod-container"
      }]
    ]);
    const summaries = createDeploymentSummaries([
      { path: "/project/.spawn/deployments/prod.json", record: createRecord() }
    ], new Map([["prod", inspections]]));
    const observations = createDeploymentObservations(summaries, {
      compileFingerprint: "sf1:old",
      liveRequested: true,
      outputDirectory: "/project/.spawn",
      recover: false
    });

    expect(summaries[0]?.units[0]?.live).toMatchObject({
      checked: true,
      running: false,
      status: "exited"
    });
    expect(observations).toContainEqual(expect.objectContaining({
      key: "deployment.unit",
      severity: "error",
      subject: "deployment-unit:prod:prod-container"
    }));
    expect(observations).toContainEqual(expect.objectContaining({
      key: "deployment.hosting",
      severity: "error",
      subject: "agent:analyst"
    }));
  });

  it("reports missing live records, recovery mode, and non-error unit states", () => {
    expect(createDeploymentObservations([], {
      compileFingerprint: null,
      liveRequested: true,
      outputDirectory: "/project/.spawn",
      recover: false
    })).toContainEqual(expect.objectContaining({
      key: "deployment.record",
      severity: "warn",
      subject: "deployment"
    }));

    expect(createDeploymentObservations([], {
      compileFingerprint: null,
      liveRequested: true,
      outputDirectory: "/project/.spawn",
      recover: true
    })).toContainEqual(expect.objectContaining({
      key: "deployment.recover",
      severity: "unknown",
      subject: "deployment"
    }));

    const missingInspection: DockerInspectionResult = new Map([
      ["prod-container", {
        containerId: null,
        drift: [],
        exists: false,
        exitCode: null,
        finishedAt: null,
        imageId: null,
        message: "recorded container abc123 is missing",
        restartCount: null,
        running: false,
        severity: "warn",
        startedAt: null,
        status: null,
        unitId: "prod-container"
      }]
    ]);
    const unknownInspection: DockerInspectionResult = new Map([
      ["prod-container", {
        containerId: null,
        drift: [],
        exists: null,
        exitCode: null,
        finishedAt: null,
        imageId: null,
        message: "unable to inspect container abc123",
        restartCount: null,
        running: null,
        severity: "unknown",
        startedAt: null,
        status: null,
        unitId: "prod-container"
      }]
    ]);

    const missingObservations = createDeploymentObservations(
      createDeploymentSummaries([
        { path: "/project/.spawn/deployments/prod.json", record: createRecord() }
      ], new Map([["prod", missingInspection]])),
      {
        compileFingerprint: "sf1:old",
        liveRequested: true,
        outputDirectory: "/project/.spawn",
        recover: false
      }
    );
    const unknownObservations = createDeploymentObservations(
      createDeploymentSummaries([
        { path: "/project/.spawn/deployments/prod.json", record: createRecord() }
      ], new Map([["prod", unknownInspection]])),
      {
        compileFingerprint: "sf1:old",
        liveRequested: true,
        outputDirectory: "/project/.spawn",
        recover: false
      }
    );

    expect(missingObservations).toContainEqual(expect.objectContaining({
      key: "deployment.unit",
      severity: "warn"
    }));
    expect(unknownObservations).toContainEqual(expect.objectContaining({
      key: "deployment.unit",
      severity: "unknown"
    }));
  });

  it("summarizes host and legacy targets and fallback live severities", () => {
    const hostRecord = createRecord();
    hostRecord.target = { kind: "host", value: "ssh://ops@example" };
    const legacyRecord = createRecord();
    legacyRecord.name = "legacy";
    legacyRecord.target = {
      context: "old-context",
      endpoint_fingerprint: "sha256:0123456789abcdef0123456789abcdef",
      kind: "docker-context"
    };
    const runningUnknownInspection: DockerInspectionResult = new Map([
      ["prod-container", {
        containerId: "abc123",
        drift: [],
        exists: true,
        exitCode: null,
        finishedAt: null,
        imageId: "image-123",
        message: "container state incomplete",
        restartCount: null,
        running: null,
        severity: "ok",
        startedAt: null,
        status: null,
        unitId: "prod-container"
      }]
    ]);

    const summaries = createDeploymentSummaries([
      { path: "/project/.spawn/deployments/prod.json", record: hostRecord },
      { path: "/project/.spawn/deployments/legacy.json", record: legacyRecord }
    ], new Map([["prod", runningUnknownInspection]]));
    const observations = createDeploymentObservations(summaries, {
      compileFingerprint: "sf1:old",
      liveRequested: true,
      outputDirectory: "/project/.spawn",
      recover: false
    });

    expect(summaries.map((summary) => summary.target)).toEqual([
      "docker host",
      "docker context old-context"
    ]);
    expect(observations).toContainEqual(expect.objectContaining({
      key: "deployment.unit",
      severity: "unknown",
      subject: "deployment-unit:prod:prod-container"
    }));
  });

  it("covers fallback unit severity branches for unusual inspection summaries", () => {
    const runningRecord = createRecord();
    const missingRecord = createRecord();
    missingRecord.name = "missing";
    const stoppedRecord = createRecord();
    stoppedRecord.name = "stopped";
    const inspections: Map<string, DockerInspectionResult> = new Map([
      ["prod", inspectionResult({
        containerId: "abc123",
        drift: [],
        exists: true,
        exitCode: 0,
        finishedAt: null,
        imageId: "image-123",
        message: "running",
        restartCount: null,
        running: true,
        severity: "ok" as const,
        startedAt: null,
        status: "running",
        unitId: "prod-container"
      })],
      ["missing", inspectionResult({
        containerId: null,
        drift: [],
        exists: false,
        exitCode: null,
        finishedAt: null,
        imageId: null,
        message: "missing",
        restartCount: null,
        running: null,
        severity: "ok" as const,
        startedAt: null,
        status: null,
        unitId: "prod-container"
      })],
      ["stopped", inspectionResult({
        containerId: "abc123",
        drift: [],
        exists: true,
        exitCode: 1,
        finishedAt: null,
        imageId: "image-123",
        message: "stopped",
        restartCount: null,
        running: false,
        severity: "ok" as const,
        startedAt: null,
        status: "exited",
        unitId: "prod-container"
      })]
    ]);

    const observations = createDeploymentObservations(
      createDeploymentSummaries([
        { path: "/project/.spawn/deployments/prod.json", record: runningRecord },
        { path: "/project/.spawn/deployments/missing.json", record: missingRecord },
        { path: "/project/.spawn/deployments/stopped.json", record: stoppedRecord }
      ], inspections),
      {
        compileFingerprint: "sf1:old",
        liveRequested: true,
        outputDirectory: "/project/.spawn",
        recover: false
      }
    );

    expect(observations).toContainEqual(expect.objectContaining({
      severity: "ok",
      subject: "deployment-unit:prod:prod-container"
    }));
    expect(observations).toContainEqual(expect.objectContaining({
      severity: "warn",
      subject: "deployment-unit:missing:prod-container"
    }));
    expect(observations).toContainEqual(expect.objectContaining({
      severity: "error",
      subject: "deployment-unit:stopped:prod-container"
    }));
  });
});
