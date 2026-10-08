import { afterEach, describe, expect, it, vi } from "vitest";

import { DAIMON_CONTRACT_MANIFEST_SHA256 } from "./daimon/contractManifest.js";

const digest = (character: string): string => `sha256:${character.repeat(64)}`;
const selection = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));

vi.mock("./install.js", () => ({
  resolveRuntimeInstallSelection: async () => selection.current
}));

const { createRuntimeInstallRecipe, RUNTIME_INSTALL_ROOT } = await import("./container.js");

const publishedSelection = (receipts: Record<string, unknown>): Record<string, unknown> => ({
  contractManifestSha256: DAIMON_CONTRACT_MANIFEST_SHA256,
  digest: digest("a"),
  ecosystem: "node",
  image: "noopolis/spawnfile-runtime-daimon",
  installHint: "",
  kind: "container_image",
  runtimeName: "daimon",
  runtimeRef: "v1",
  selectionSource: "runtime_registry_install",
  tag: "1.0.0-abcdef0",
  ...receipts
});

describe("published Daimon runtime receipts", () => {
  afterEach(() => {
    selection.current = {};
  });

  it("copies the pinned index digest and checks the receipt pinned for the build architecture", async () => {
    selection.current = publishedSelection({ capabilityReceipts: { amd64: digest("b"), arm64: digest("c") } });
    const recipe = await createRuntimeInstallRecipe("daimon");

    expect(recipe.copyCommands).toEqual([
      `COPY --from=noopolis/spawnfile-runtime-daimon@${digest("a")} ${RUNTIME_INSTALL_ROOT}/daimon ${RUNTIME_INSTALL_ROOT}/daimon`
    ]);
    const check = recipe.commands[0] ?? "";
    expect(check).toContain(`case "$arch" in amd64) expected="${digest("b")}" ;; arm64) expected="${digest("c")}" ;; *)`);
    expect(check).toContain('test "$actual" = "$expected"');
    expect(check).toContain(`sha256sum ${RUNTIME_INSTALL_ROOT}/daimon/capability-receipt.json`);
  });

  it("keeps the single-receipt check for a single-architecture pin", async () => {
    selection.current = publishedSelection({ capabilityReceipt: digest("b") });
    const recipe = await createRuntimeInstallRecipe("daimon");

    expect(recipe.commands[0]).toMatch(new RegExp(`test "\\$actual" = "${digest("b")}"$`, "u"));
    expect(recipe.commands[0]).not.toContain("dpkg --print-architecture");
  });

  it("refuses a published pin that carries no capability receipt", async () => {
    selection.current = publishedSelection({});
    await expect(createRuntimeInstallRecipe("daimon")).rejects.toThrow(/pinned generic Daimon runtime image/u);
  });
});
