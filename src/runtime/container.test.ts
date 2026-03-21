import { describe, expect, it } from "vitest";

import { createRuntimeInstallRecipe, RUNTIME_SOURCE_ROOT } from "./container.js";

describe("runtime container install recipes", () => {
  it("creates an OpenClaw source-build recipe from the pinned runtime ref", async () => {
    const recipe = await createRuntimeInstallRecipe("openclaw");

    expect(recipe.runtimeName).toBe("openclaw");
    expect(recipe.runtimeRoot).toBe(`${RUNTIME_SOURCE_ROOT}/openclaw`);
    expect(recipe.commands).toContain(
      `cd ${RUNTIME_SOURCE_ROOT}/openclaw && pnpm canvas:a2ui:bundle`
    );
    expect(recipe.commands).toContain(
      `cd ${RUNTIME_SOURCE_ROOT}/openclaw && pnpm build:docker`
    );
  });

  it("creates a PicoClaw source-build recipe from the pinned runtime ref", async () => {
    const recipe = await createRuntimeInstallRecipe("picoclaw");

    expect(recipe.commands).toContain(
      `cd ${RUNTIME_SOURCE_ROOT}/picoclaw && go build -o /usr/local/bin/picoclaw ./cmd/picoclaw`
    );
  });

  it("creates a TinyClaw source-build recipe from the pinned runtime ref", async () => {
    const recipe = await createRuntimeInstallRecipe("tinyclaw");

    expect(recipe.commands).toContain(
      `cd ${RUNTIME_SOURCE_ROOT}/tinyclaw && npm run build`
    );
  });
});
