import { afterEach, describe, expect, it } from "vitest";

import { NOOPOLIS_RUN_ID_ENV } from "./common.js";
import { createRuntimeContainerEnv, createRuntimeInstallRecipe, RUNTIME_INSTALL_ROOT } from "./container.js";

describe("runtime container install recipes", () => {
  afterEach(() => {
    delete process.env.SPAWNFILE_DAIMON_RUNTIME_BASE_IMAGE;
    delete process.env.SPAWNFILE_DAIMON_RUNTIME_IMAGE;
    delete process.env.SPAWNFILE_DAIMON_RUNTIME_CAPABILITY_RECEIPT;
    delete process.env.SPAWNFILE_OPENCLAW_RUNTIME_IMAGE;
    delete process.env.SPAWNFILE_PI_RUNTIME_BASE_IMAGE;
    delete process.env.SPAWNFILE_PICOCLAW_RUNTIME_IMAGE;
    delete process.env.NOOPOLIS_RUN_ID;
  });

  it("creates an OpenClaw image-copy recipe from the pinned runtime image", async () => {
    const recipe = await createRuntimeInstallRecipe("openclaw");

    expect(recipe.runtimeName).toBe("openclaw");
    expect(recipe.runtimeRoot).toBe(`${RUNTIME_INSTALL_ROOT}/openclaw`);
    expect(recipe.commands).toEqual([]);
    expect(recipe.copyCommands).toEqual([
      `COPY --from=noopolis/spawnfile-runtime-openclaw:2026.6.11 ${RUNTIME_INSTALL_ROOT}/openclaw ${RUNTIME_INSTALL_ROOT}/openclaw`
    ]);
  });

  it("creates a PicoClaw image-copy recipe from the pinned runtime image", async () => {
    const recipe = await createRuntimeInstallRecipe("picoclaw");

    expect(recipe.runtimeRoot).toBe(`${RUNTIME_INSTALL_ROOT}/picoclaw`);
    expect(recipe.copyCommands).toEqual([
      `COPY --from=noopolis/spawnfile-runtime-picoclaw:0.3.1 ${RUNTIME_INSTALL_ROOT}/picoclaw ${RUNTIME_INSTALL_ROOT}/picoclaw`
    ]);
    expect(recipe.commands).toEqual([
      `mkdir -p /usr/local/bin && ln -sf ${RUNTIME_INSTALL_ROOT}/picoclaw/bin/picoclaw /usr/local/bin/picoclaw`
    ]);
  });

  it("creates a Pi generated-app install root from the pinned runtime version", async () => {
    const recipe = await createRuntimeInstallRecipe("pi");

    expect(recipe.runtimeName).toBe("pi");
    expect(recipe.runtimeRoot).toBe(`${RUNTIME_INSTALL_ROOT}/pi`);
    expect(recipe.copyCommands).toEqual([]);
    expect(recipe.commands).toEqual([
      `mkdir -p ${RUNTIME_INSTALL_ROOT}/pi`,
      `cd ${RUNTIME_INSTALL_ROOT}/pi && npm install --omit=dev --no-fund --no-audit @noopolis/daimon@0.1.2 @noopolis/mneme@0.1.1 @earendil-works/pi-coding-agent@0.79.10 @earendil-works/pi-ai@0.79.10`
    ]);
  });

  it("creates a Daimon image-copy recipe from the pinned runtime image", async () => {
    const recipe = await createRuntimeInstallRecipe("daimon");

    expect(recipe.runtimeName).toBe("daimon");
    expect(recipe.runtimeRoot).toBe(`${RUNTIME_INSTALL_ROOT}/daimon`);
    expect(recipe.commands).toEqual(expect.arrayContaining([
      expect.stringContaining("capability-receipt.json"),
      expect.stringContaining('actual="$(sha256sum'),
      `ln -sf ${RUNTIME_INSTALL_ROOT}/daimon/bin/daimon-runtime /usr/local/bin/daimon-runtime`,
      `ln -sf ${RUNTIME_INSTALL_ROOT}/daimon/bin/codex /usr/local/bin/codex`,
      `ln -sf ${RUNTIME_INSTALL_ROOT}/daimon/bin/grok /usr/local/bin/grok`,
      `ln -sf ${RUNTIME_INSTALL_ROOT}/daimon/bin/agy /usr/local/bin/agy`
    ]));
    expect(recipe.copyCommands).toEqual([
      `COPY --from=noopolis/spawnfile-runtime-daimon@sha256:19b671e589ad8c9e8f1b55610ccbf86ee72f16b4cb2f707ec419f5ef0d6942aa ${RUNTIME_INSTALL_ROOT}/daimon ${RUNTIME_INSTALL_ROOT}/daimon`
    ]);
  });

  it("installs overridden runtime packages from the vendored tarball path in the Pi recipe", async () => {
    const recipe = await createRuntimeInstallRecipe("pi", {
      packageOverrides: {
        "@noopolis/daimon": { filename: "noopolis-daimon-0.1.2.tgz" },
        "@noopolis/mneme": { filename: "noopolis-mneme-0.1.1.tgz" }
      }
    });

    expect(recipe.copyCommands).toEqual(["COPY container/vendor/ /opt/spawnfile/vendor/"]);
    expect(recipe.commands).toEqual([
      `mkdir -p ${RUNTIME_INSTALL_ROOT}/pi`,
      `cd ${RUNTIME_INSTALL_ROOT}/pi && npm install --omit=dev --no-fund --no-audit /opt/spawnfile/vendor/noopolis-daimon-0.1.2.tgz /opt/spawnfile/vendor/noopolis-mneme-0.1.1.tgz @earendil-works/pi-coding-agent@0.79.10 @earendil-works/pi-ai@0.79.10`
    ]);
  });

  it("keeps the pinned registry spec for Pi recipe packages without an override entry", async () => {
    const recipe = await createRuntimeInstallRecipe("pi", {
      packageOverrides: { "@noopolis/daimon": { filename: "noopolis-daimon-0.1.2.tgz" } }
    });

    expect(recipe.commands[1]).toContain("@noopolis/mneme@0.1.1");
    expect(recipe.commands[1]).toContain("/opt/spawnfile/vendor/noopolis-daimon-0.1.2.tgz");
    expect(recipe.commands[1]).not.toContain("@noopolis/daimon@0.1.2");
  });

  it("omits the vendor copy command when the Pi recipe has no overrides", async () => {
    const recipe = await createRuntimeInstallRecipe("pi", {});
    expect(recipe.copyCommands).toEqual([]);
    expect(recipe.commands[1]).toContain("@noopolis/daimon@0.1.2");
  });

  it("omits the vendor copy command when a prebuilt Pi base image is configured, even with overrides set", async () => {
    process.env.SPAWNFILE_PI_RUNTIME_BASE_IMAGE = "noopolis/spawnfile-pi-runtime:test";

    const recipe = await createRuntimeInstallRecipe("pi", {
      packageOverrides: { "@noopolis/daimon": { filename: "noopolis-daimon-0.1.2.tgz" } }
    });

    expect(recipe.copyCommands).toEqual([]);
    expect(recipe.commands).toEqual([`mkdir -p ${RUNTIME_INSTALL_ROOT}/pi`]);
  });

  it("uses a prebuilt Pi runtime base image when configured", async () => {
    process.env.SPAWNFILE_PI_RUNTIME_BASE_IMAGE = "noopolis/spawnfile-pi-runtime:test";

    const recipe = await createRuntimeInstallRecipe("pi");

    expect(recipe.baseImage).toBe("noopolis/spawnfile-pi-runtime:test");
    expect(recipe.commands).toEqual([`mkdir -p ${RUNTIME_INSTALL_ROOT}/pi`]);
  });

  it("allows only an exact Daimon runtime image and receipt override", async () => {
    process.env.SPAWNFILE_DAIMON_RUNTIME_IMAGE = "noopolis/spawnfile-runtime-daimon@sha256:19b671e589ad8c9e8f1b55610ccbf86ee72f16b4cb2f707ec419f5ef0d6942aa";
    process.env.SPAWNFILE_DAIMON_RUNTIME_CAPABILITY_RECEIPT = "sha256:1a207c0cc5f081b2a8f941d59b74e37f905a1dc7b37a08c7984c6e39123fb4e7";

    const recipe = await createRuntimeInstallRecipe("daimon");

    expect(recipe.baseImage).toBeUndefined();
    expect(recipe.commands).toEqual(expect.arrayContaining([
      expect.stringContaining("capability-receipt.json"),
      `ln -sf ${RUNTIME_INSTALL_ROOT}/daimon/bin/daimon-runtime /usr/local/bin/daimon-runtime`
    ]));
    expect(recipe.copyCommands).toEqual([
      `COPY --from=noopolis/spawnfile-runtime-daimon@sha256:19b671e589ad8c9e8f1b55610ccbf86ee72f16b4cb2f707ec419f5ef0d6942aa ${RUNTIME_INSTALL_ROOT}/daimon ${RUNTIME_INSTALL_ROOT}/daimon`
    ]);
  });

  it("rejects mutable Daimon runtime image overrides", async () => {
    process.env.SPAWNFILE_DAIMON_RUNTIME_IMAGE = "noopolis/spawnfile-runtime-daimon:test";
    await expect(createRuntimeInstallRecipe("daimon")).rejects.toThrow(
      "source and tag-only overrides are disabled"
    );
  });

  it("uses a prebuilt OpenClaw runtime artifact image when configured", async () => {
    process.env.SPAWNFILE_OPENCLAW_RUNTIME_IMAGE = "noopolis/spawnfile-runtime-openclaw:test";

    const recipe = await createRuntimeInstallRecipe("openclaw");

    expect(recipe.baseImage).toBeUndefined();
    expect(recipe.commands).toEqual([]);
    expect(recipe.copyCommands).toEqual([
      `COPY --from=noopolis/spawnfile-runtime-openclaw:test ${RUNTIME_INSTALL_ROOT}/openclaw ${RUNTIME_INSTALL_ROOT}/openclaw`
    ]);
  });

  it("uses a prebuilt PicoClaw runtime artifact image when configured", async () => {
    process.env.SPAWNFILE_PICOCLAW_RUNTIME_IMAGE = "noopolis/spawnfile-runtime-picoclaw:test";

    const recipe = await createRuntimeInstallRecipe("picoclaw");

    expect(recipe.baseImage).toBeUndefined();
    expect(recipe.commands).toEqual([
      `mkdir -p /usr/local/bin && ln -sf ${RUNTIME_INSTALL_ROOT}/picoclaw/bin/picoclaw /usr/local/bin/picoclaw`
    ]);
    expect(recipe.copyCommands).toEqual([
      `COPY --from=noopolis/spawnfile-runtime-picoclaw:test ${RUNTIME_INSTALL_ROOT}/picoclaw ${RUNTIME_INSTALL_ROOT}/picoclaw`
    ]);
  });

  it("ignores the legacy Daimon base-image override", async () => {
    process.env.SPAWNFILE_DAIMON_RUNTIME_BASE_IMAGE = "noopolis/spawnfile-runtime-daimon:legacy";
    await expect(createRuntimeInstallRecipe("daimon")).resolves.toMatchObject({
      copyCommands: [expect.stringContaining("@sha256:")]
    });
  });

  it("omits NOOPOLIS_RUN_ID from every recipe's env when unset", async () => {
    for (const runtimeName of ["openclaw", "picoclaw", "daimon", "pi"] as const) {
      const recipe = await createRuntimeInstallRecipe(runtimeName);
      expect(recipe.env).toEqual({});
    }
  });

  it("stamps the same NOOPOLIS_RUN_ID into every recipe's env when set", async () => {
    process.env.NOOPOLIS_RUN_ID = "run-shared-1";

    for (const runtimeName of ["openclaw", "picoclaw", "daimon", "pi"] as const) {
      const recipe = await createRuntimeInstallRecipe(runtimeName);
      expect(recipe.env).toEqual({ [NOOPOLIS_RUN_ID_ENV]: "run-shared-1" });
    }
  });
});

describe("createRuntimeContainerEnv", () => {
  it("returns an empty env map when NOOPOLIS_RUN_ID is unset", () => {
    expect(createRuntimeContainerEnv({})).toEqual({});
  });

  it("returns a NOOPOLIS_RUN_ID env entry when set", () => {
    expect(createRuntimeContainerEnv({ NOOPOLIS_RUN_ID: "run-2" })).toEqual({
      NOOPOLIS_RUN_ID: "run-2"
    });
  });
});
