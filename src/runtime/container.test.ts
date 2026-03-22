import { describe, expect, it } from "vitest";

import { createRuntimeInstallRecipe, RUNTIME_INSTALL_ROOT } from "./container.js";

describe("runtime container install recipes", () => {
  it("creates an OpenClaw npm recipe from the pinned runtime version", async () => {
    const recipe = await createRuntimeInstallRecipe("openclaw");

    expect(recipe.runtimeName).toBe("openclaw");
    expect(recipe.runtimeRoot).toBe("/usr/local/lib/node_modules/openclaw");
    expect(recipe.copyCommands).toEqual([]);
    expect(recipe.commands).toEqual([
      "npm install -g --omit=dev --no-fund --no-audit openclaw@2026.3.13"
    ]);
  });

  it("creates a PicoClaw archive-install recipe from the pinned runtime version", async () => {
    const recipe = await createRuntimeInstallRecipe("picoclaw");

    expect(recipe.runtimeRoot).toBe(`${RUNTIME_INSTALL_ROOT}/picoclaw`);
    expect(recipe.copyCommands).toEqual([]);
    expect(recipe.commands).toContain(`mkdir -p ${RUNTIME_INSTALL_ROOT}/picoclaw/bin`);
    expect(recipe.commands[1]).toContain(
      "https://github.com/sipeed/picoclaw/releases/download/v0.2.3/$asset"
    );
    expect(recipe.commands[1]).toContain(
      `install -m 0755 "$binary_path" ${RUNTIME_INSTALL_ROOT}/picoclaw/bin/picoclaw`
    );
    expect(recipe.commands[1]).toContain(
      `ln -sf ${RUNTIME_INSTALL_ROOT}/picoclaw/bin/picoclaw /usr/local/bin/picoclaw`
    );
  });

  it("creates a TinyClaw bundle-install recipe from the pinned runtime version", async () => {
    const recipe = await createRuntimeInstallRecipe("tinyclaw");

    expect(recipe.runtimeRoot).toBe(`${RUNTIME_INSTALL_ROOT}/tinyclaw`);
    expect(recipe.copyCommands).toEqual([]);
    expect(recipe.commands).toEqual([
      `mkdir -p ${RUNTIME_INSTALL_ROOT}/tinyclaw`,
      `curl -fsSL "https://github.com/TinyAGI/tinyagi/releases/download/v0.0.15/tinyagi-bundle.tar.gz" | tar -xz --strip-components=1 -C ${RUNTIME_INSTALL_ROOT}/tinyclaw`,
      `cd ${RUNTIME_INSTALL_ROOT}/tinyclaw && npm rebuild better-sqlite3 --silent`
    ]);
  });
});
