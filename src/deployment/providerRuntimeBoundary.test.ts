import { describe, expect, it } from "vitest";

import {
  scanSimfileFixtureSource,
  scanSimfileFixtureTree
} from "./simfileFixtureBoundary.test-helper.js";
import {
  scanProviderRuntimeSource,
  scanProviderRuntimeTree
} from "./providerRuntimeBoundaryScanner.test-helper.js";

describe("provider runtime ownership boundary", () => {
  it("keeps forbidden provider traffic out of production modules", async () => {
    expect(await scanProviderRuntimeTree(process.cwd())).toEqual([]);
  });

  it.each(["/v1/network", "/v1/rooms", "/v1/agents", "/v1/messages"])(
    "rejects %s", (endpoint) => {
      expect(scanProviderRuntimeSource(`fetch(\"${endpoint}\")`)[0]).toMatchObject({ classification: "moltnet-live-endpoint" });
    }
  );

  it.each([
    {
      matched: "Bearer template",
      source: "fetch('/healthz', { headers: { scheme: `Bearer ${token}` } })"
    },
    {
      matched: "Bearer literal",
      source: "fetch('/healthz', { headers: { scheme: 'Bearer fixed-token' } })"
    },
    {
      matched: "Bearer concatenation",
      source: "fetch('/healthz', { headers: { scheme: 'Bearer ' + token } })"
    },
    {
      matched: "Authorization property",
      source: "fetch('/healthz', { headers: { Authorization: token } })"
    },
    {
      matched: "Authorization string key",
      source: "fetch('/healthz', { headers: { 'Authorization': token } })"
    },
    {
      matched: "Authorization element assignment",
      source: "const headers = {}; headers['Authorization'] = token; fetch('/healthz', { headers })"
    }
  ])("rejects authenticated health HTTP via $matched", ({ matched, source }) => {
    expect(scanProviderRuntimeSource(source)).toContainEqual({
      classification: "provider-authenticated-http",
      file: "synthetic.ts",
      matched
    });
  });

  it.each([
    "exec([\"curl\", \"-fsS\", \"http://127.0.0.1:8787/healthz\"])",
    "docker(['exec', ref, 'curl', 'http://127.0.0.1:8787/healthz'])"
  ])("rejects exec-based HTTP transport", (source) => {
    expect(scanProviderRuntimeSource(source)).toContainEqual(expect.objectContaining({ classification: "docker-exec-http-transport" }));
  });

  it("accepts anonymous health and artifact transport", () => {
    expect(scanProviderRuntimeSource("gateway.httpGet(port, '/healthz')")).toEqual([]);
    expect(scanProviderRuntimeSource("docker(['run', '--network', 'container:ref', '--entrypoint', 'curl', image, '/healthz'])")).toEqual([]);
    expect(scanProviderRuntimeSource("gateway.exec(['cat', path])")).toEqual([]);
  });

  it("keeps Simfile fixture references detectable", () => {
    expect(scanSimfileFixtureSource('path.join("ecosystem", "simfile", "fixtures", "sims")')[0]?.classification)
      .toBeUndefined();
    expect(scanSimfileFixtureSource('import path from "node:path"; path.join("ecosystem", "simfile", "fixtures", "sims", "tiny-football")')[0])
      .toMatchObject({ classification: "simfile-scenario-path-join" });
  });

  it("rejects executable Simfile fixture references across root src, including tests", async () => {
    expect(await scanSimfileFixtureTree(process.cwd())).toEqual([]);
  });
});
