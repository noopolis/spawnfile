import { afterEach, describe, expect, it } from "vitest";

import { createRuntimeInstallRecipe, RUNTIME_INSTALL_ROOT } from "./container.js";

describe("runtime container install recipes", () => {
  afterEach(() => {
    delete process.env.SPAWNFILE_DAIMON_RUNTIME_BASE_IMAGE;
    delete process.env.SPAWNFILE_DAIMON_RUNTIME_IMAGE;
    delete process.env.SPAWNFILE_PI_RUNTIME_BASE_IMAGE;
  });

  it("creates an OpenClaw npm recipe from the pinned runtime version", async () => {
    const recipe = await createRuntimeInstallRecipe("openclaw");

    expect(recipe.runtimeName).toBe("openclaw");
    expect(recipe.runtimeRoot).toBe("/usr/local/lib/node_modules/openclaw");
    expect(recipe.copyCommands).toEqual([]);
    expect(recipe.commands).toEqual([
      "npm install -g --omit=dev --no-fund --no-audit openclaw@2026.6.8"
    ]);
  });

  it("creates a PicoClaw archive-install recipe from the pinned runtime version", async () => {
    const recipe = await createRuntimeInstallRecipe("picoclaw");

    expect(recipe.runtimeRoot).toBe(`${RUNTIME_INSTALL_ROOT}/picoclaw`);
    expect(recipe.copyCommands).toEqual([]);
    expect(recipe.commands).toContain(`mkdir -p ${RUNTIME_INSTALL_ROOT}/picoclaw/bin`);
    expect(recipe.commands[1]).toContain(
      "https://github.com/sipeed/picoclaw/releases/download/v0.2.9/$asset"
    );
    expect(recipe.commands[1]).toContain(
      `install -m 0755 "$binary_path" ${RUNTIME_INSTALL_ROOT}/picoclaw/bin/picoclaw`
    );
    expect(recipe.commands[1]).toContain(
      `ln -sf ${RUNTIME_INSTALL_ROOT}/picoclaw/bin/picoclaw /usr/local/bin/picoclaw`
    );
  });

  it("creates a Pi generated-app install root from the pinned runtime version", async () => {
    const recipe = await createRuntimeInstallRecipe("pi");

    expect(recipe.runtimeName).toBe("pi");
    expect(recipe.runtimeRoot).toBe(`${RUNTIME_INSTALL_ROOT}/pi`);
    expect(recipe.copyCommands).toEqual([]);
    expect(recipe.commands).toEqual([
      `mkdir -p ${RUNTIME_INSTALL_ROOT}/pi`,
      `cd ${RUNTIME_INSTALL_ROOT}/pi && npm install --omit=dev --no-fund --no-audit @earendil-works/pi-coding-agent@0.79.9 @earendil-works/pi-ai@0.79.9`
    ]);
  });

  it("creates a Daimon image-copy recipe from the pinned runtime image", async () => {
    const recipe = await createRuntimeInstallRecipe("daimon");

    expect(recipe.runtimeName).toBe("daimon");
    expect(recipe.runtimeRoot).toBe(`${RUNTIME_INSTALL_ROOT}/daimon`);
    expect(recipe.commands).toEqual([]);
    expect(recipe.copyCommands).toEqual([
      `COPY --from=noopolis/spawnfile-runtime-daimon:0.1.0 ${RUNTIME_INSTALL_ROOT}/daimon ${RUNTIME_INSTALL_ROOT}/daimon`
    ]);
  });

  it("uses a prebuilt Pi runtime base image when configured", async () => {
    process.env.SPAWNFILE_PI_RUNTIME_BASE_IMAGE = "noopolis/spawnfile-pi-runtime:test";

    const recipe = await createRuntimeInstallRecipe("pi");

    expect(recipe.baseImage).toBe("noopolis/spawnfile-pi-runtime:test");
    expect(recipe.commands).toEqual([`mkdir -p ${RUNTIME_INSTALL_ROOT}/pi`]);
  });

  it("uses a prebuilt Daimon runtime artifact image when configured", async () => {
    process.env.SPAWNFILE_DAIMON_RUNTIME_IMAGE = "noopolis/spawnfile-runtime-daimon:test";

    const recipe = await createRuntimeInstallRecipe("daimon");

    expect(recipe.baseImage).toBeUndefined();
    expect(recipe.commands).toEqual([]);
    expect(recipe.copyCommands).toEqual([
      `COPY --from=noopolis/spawnfile-runtime-daimon:test ${RUNTIME_INSTALL_ROOT}/daimon ${RUNTIME_INSTALL_ROOT}/daimon`
    ]);
  });

  it("treats the legacy Daimon base-image env as a copyable artifact", async () => {
    process.env.SPAWNFILE_DAIMON_RUNTIME_BASE_IMAGE = "noopolis/spawnfile-runtime-daimon:legacy";

    const recipe = await createRuntimeInstallRecipe("daimon");

    expect(recipe.baseImage).toBeUndefined();
    expect(recipe.commands).toEqual([]);
    expect(recipe.copyCommands).toEqual([
      `COPY --from=noopolis/spawnfile-runtime-daimon:legacy ${RUNTIME_INSTALL_ROOT}/daimon ${RUNTIME_INSTALL_ROOT}/daimon`
    ]);
  });
});
