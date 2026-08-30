import { describe, expect, it } from "vitest";

import {
  MAX_TARGET_PUBLIC_ARTIFACT_BYTES,
  createCanonicalTargetPublicArtifactSnapshotBytes,
  createCanonicalTargetPublicArtifactSnapshotResultBytes,
  createTargetPublicArtifactSnapshot,
  createTargetPublicArtifactSnapshotNotPresent,
  createTargetPublicArtifactSnapshotRequestDigest,
  parseTargetPublicArtifactSnapshot,
  parseTargetPublicArtifactSnapshotNotPresent,
  parseTargetPublicArtifactSnapshotResult,
  parseTargetPublicArtifactSnapshotRequest
} from "./publicArtifactSnapshot.js";

const request = {
  artifact: {
    id: "viewer_trace",
    max_bytes: 4_096,
    media_type: "application/json",
    path: "/tmp/spawnfile-public/viewer-trace.json"
  },
  descriptor_digest: `sha256:${"a".repeat(64)}`,
  run_id: "run-public-view",
  selected_target: {
    fingerprint: `sha256:${"b".repeat(32)}`,
    handle: "opaque_cccccccccccccccc"
  },
  version: "spawnfile.target-public-artifact-snapshot.request.v1",
  world_service_handle: "opaque_dddddddddddddddd"
} as const;

describe("target public artifact snapshot contract", () => {
  it("binds one generic declaration to canonical, bounded content", () => {
    const parsed = parseTargetPublicArtifactSnapshotRequest(request);
    const snapshot = createTargetPublicArtifactSnapshot({
      content: Buffer.from("{\"tick\":7}", "utf8"),
      request: parsed
    });
    expect(snapshot).toMatchObject({
      artifact_id: "viewer_trace",
      media_type: "application/json",
      request_digest: createTargetPublicArtifactSnapshotRequestDigest(parsed),
      run_id: "run-public-view",
      size_bytes: 10
    });
    expect(JSON.parse(createCanonicalTargetPublicArtifactSnapshotBytes(snapshot)))
      .toEqual(snapshot);
    expect(parseTargetPublicArtifactSnapshot(snapshot)).toEqual(snapshot);
    expect(parseTargetPublicArtifactSnapshotResult(snapshot)).toEqual(snapshot);
  });

  it("admits and canonically transports a retained trace beyond the generic graph string bound", () => {
    const largeRequest = parseTargetPublicArtifactSnapshotRequest({
      ...request,
      artifact: {
        ...request.artifact,
        max_bytes: MAX_TARGET_PUBLIC_ARTIFACT_BYTES
      }
    });
    const content = Buffer.alloc(100 * 1_024, 0x61);
    const snapshot = createTargetPublicArtifactSnapshot({
      content,
      request: largeRequest
    });
    const canonical = createCanonicalTargetPublicArtifactSnapshotBytes(snapshot);
    const reparsed = parseTargetPublicArtifactSnapshot(JSON.parse(canonical));
    expect(reparsed.size_bytes).toBe(content.byteLength);
    expect(Buffer.from(reparsed.content_base64, "base64")).toEqual(content);
  });

  it("classifies only this correlated artifact request as not present", () => {
    const parsed = parseTargetPublicArtifactSnapshotRequest(request);
    const outcome = createTargetPublicArtifactSnapshotNotPresent(parsed);
    expect(outcome).toEqual({
      artifact_id: "viewer_trace",
      request_digest: createTargetPublicArtifactSnapshotRequestDigest(parsed),
      run_id: "run-public-view",
      status: "not_present",
      version: "spawnfile.target-public-artifact-snapshot.not-present.v1"
    });
    expect(parseTargetPublicArtifactSnapshotNotPresent(outcome)).toEqual(outcome);
    expect(parseTargetPublicArtifactSnapshotResult(outcome)).toEqual(outcome);
    expect(JSON.parse(createCanonicalTargetPublicArtifactSnapshotResultBytes(outcome)))
      .toEqual(outcome);
    expect(() => parseTargetPublicArtifactSnapshotNotPresent({
      ...outcome,
      retry_after_ms: 1_000
    })).toThrow();
    expect(() => parseTargetPublicArtifactSnapshotNotPresent({
      ...outcome,
      status: "not_present_yet"
    })).toThrow();
  });

  it("rejects private paths, traversal, hostile shapes, oversize, and corrupt bytes", () => {
    for (const path of [
      "/run/world/evidence/viewer.json",
      "/run/spawnfile-secrets/token",
      "/tmp/spawnfile-public/../secret",
      "/tmp/spawnfile-public/nested/secret",
      "/tmp/spawnfile-public/"
    ]) {
      expect(() => parseTargetPublicArtifactSnapshotRequest({
        ...request,
        artifact: { ...request.artifact, path }
      })).toThrow();
    }
    expect(() => parseTargetPublicArtifactSnapshotRequest({
      ...request,
      artifact: { ...request.artifact, max_bytes: MAX_TARGET_PUBLIC_ARTIFACT_BYTES + 1 }
    })).toThrow();
    expect(() => parseTargetPublicArtifactSnapshotRequest({
      ...request,
      credential: "secret"
    })).toThrow();
    const snapshot = createTargetPublicArtifactSnapshot({
      content: Buffer.from("safe"),
      request: parseTargetPublicArtifactSnapshotRequest(request)
    });
    expect(() => parseTargetPublicArtifactSnapshot({
      ...snapshot,
      content_base64: Buffer.from("unsafe").toString("base64")
    })).toThrow();
    expect(() => parseTargetPublicArtifactSnapshot(Object.defineProperty(
      { ...snapshot },
      "content_base64",
      { enumerable: true, get: () => snapshot.content_base64 }
    ))).toThrow(new TypeError("invalid JSON-like graph"));
    expect(() => parseTargetPublicArtifactSnapshot(new Proxy(snapshot, {})))
      .toThrow(new TypeError("invalid JSON-like graph"));
  });
});
