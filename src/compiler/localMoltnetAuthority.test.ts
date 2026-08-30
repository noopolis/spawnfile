import path from "node:path";

import { describe, expect, it } from "vitest";

import { createLocalMoltnetBridgeProbeConfig, moltnetBinaryIsDirectlyExecutable, parseLocalReleaseStamp } from "./localMoltnetAuthority.js";

describe("local Moltnet bridge capability probes", () => {
  it("represents every required Daimon runtime field with private-state-compatible paths", () => {
    const directory = "/tmp/spawnfile-moltnet-probe";
    const config = JSON.parse(createLocalMoltnetBridgeProbeConfig("daimon", directory));

    expect(config.attachments[0].runtime).toEqual({
      control_url: "http://127.0.0.1:9",
      kind: "daimon",
      receipt_store_path: path.join(directory, "daimon-receipts", "daimon-capability-probe.json"),
      token_env: "SPAWNFILE_DAIMON_CONTROL_TOKEN"
    });
    expect(path.isAbsolute(config.attachments[0].runtime.receipt_store_path)).toBe(true);
  });

  it("does not add Daimon-only state to the Pi probe", () => {
    const config = JSON.parse(createLocalMoltnetBridgeProbeConfig("pi", "/tmp/probe"));
    expect(config.attachments[0].runtime).not.toHaveProperty("receipt_store_path");
  });

  it("binds archive-mode source, dependency, and pinned toolchain identities", () => {
    const digest = `sha256:${"a".repeat(64)}`;
    const stamp = { arch: "amd64", asset: "moltnet_linux_amd64.tar.gz", capabilities: ["daimon-bridge", "pi-bridge"], development: { mode: "local-development", non_production: true, unsigned: true, unpublished: true }, sha256: "b".repeat(64), source_inputs: { dependencies_sha256: digest, mode: "source-bundle", source_sha256: digest, toolchain: "golang:1.24-bookworm@sha256:1a6d4452c65dea36aac2e2d606b01b4a029ec90cc1ae53890540ce6173ea77ac" }, source_sha256: digest, stamp_version: "spawnfile.local-moltnet-release-stamp.v1" };
    expect(parseLocalReleaseStamp(JSON.stringify(stamp), "amd64").source_inputs).toEqual(stamp.source_inputs);
    expect(() => parseLocalReleaseStamp(JSON.stringify({ ...stamp, source_inputs: { ...stamp.source_inputs, dependencies_sha256: "sha256:bad" } }), "amd64")).toThrow(/complete development-only/u);
  });

  /**
   * A local Moltnet build is always GOOS=linux. Matching only the CPU
   * architecture calls a darwin/arm64 host "directly executable" for a
   * linux/arm64 ELF, which fails with ENOEXEC and rejects a good build. The
   * host has to match on OS as well, and everything else takes the Docker
   * probe, which can run a linux image anywhere.
   */
  it("runs the built binary directly only when the host OS and architecture both match", () => {
    // The regression: same CPU architecture, different OS. Must NOT exec directly.
    expect(moltnetBinaryIsDirectlyExecutable("arm64", { architecture: "arm64", platform: "darwin" })).toBe(false);
    expect(moltnetBinaryIsDirectlyExecutable("amd64", { architecture: "amd64", platform: "win32" })).toBe(false);

    // The Linux build path must keep exec'ing directly -- Docker is the fallback, not the default.
    expect(moltnetBinaryIsDirectlyExecutable("amd64", { architecture: "amd64", platform: "linux" })).toBe(true);
    expect(moltnetBinaryIsDirectlyExecutable("arm64", { architecture: "arm64", platform: "linux" })).toBe(true);

    // Genuine cross-architecture on Linux still goes through Docker.
    expect(moltnetBinaryIsDirectlyExecutable("arm64", { architecture: "amd64", platform: "linux" })).toBe(false);

    // A host CPU Spawnfile cannot name as a target can never match one.
    expect(moltnetBinaryIsDirectlyExecutable("amd64", { platform: "linux" })).toBe(false);
  });
});
