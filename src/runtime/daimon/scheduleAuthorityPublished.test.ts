import { afterEach, describe, expect, it, vi } from "vitest";

import { DAIMON_CONTRACT_MANIFEST_SHA256 } from "./contractManifest.js";

const digest = (character: string): string => `sha256:${character.repeat(64)}`;
const selection = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));

vi.mock("../install.js", () => ({
  resolveRuntimeInstallSelection: async () => selection.current
}));

const { hasDaimonScheduleAuthority, assertDaimonScheduleAuthority } = await import("./scheduleAuthority.js");
const { assertDaimonAttentionAuthority } = await import("./attention.js");

const published = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  capabilityReceipts: { amd64: digest("b"), arm64: digest("c") },
  contractManifestSha256: DAIMON_CONTRACT_MANIFEST_SHA256,
  digest: digest("a"),
  image: "noopolis/spawnfile-runtime-daimon",
  kind: "container_image",
  runtimeName: "daimon",
  tag: "1.0.0-abcdef0",
  ...overrides
});

describe("published Daimon image authority", () => {
  afterEach(() => {
    selection.current = {};
    delete process.env.SPAWNFILE_DAIMON_LOCAL_RUNTIME_IDENTITY;
  });

  it("grants schedule and attention authority to a pinned image attesting the exact contract manifest", async () => {
    selection.current = published();
    await expect(hasDaimonScheduleAuthority()).resolves.toBe(true);
    selection.current = published({ capabilityReceipts: undefined, capabilityReceipt: digest("d") });
    await expect(hasDaimonScheduleAuthority()).resolves.toBe(true);
  });

  it.each([
    ["a different contract manifest", { contractManifestSha256: digest("e") }],
    ["no contract manifest", { contractManifestSha256: undefined }],
    ["no index digest", { digest: undefined }],
    ["no capability receipt", { capabilityReceipts: undefined }],
    ["a non-image install", { kind: "npm" }]
  ])("fails closed for a pin with %s", async (_label, overrides) => {
    selection.current = published(overrides);
    await expect(hasDaimonScheduleAuthority()).resolves.toBe(false);
    await expect(assertDaimonScheduleAuthority()).rejects.toThrow(/does not attest organization runtime v2/u);
    await expect(assertDaimonAttentionAuthority()).rejects.toThrow(/attention is disabled.*does not attest/u);
  });
});
