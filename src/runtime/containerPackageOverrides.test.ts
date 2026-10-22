import { DAIMON_PACKAGE_NAME } from './daimon/packageName.js';
import { describe, expect, it } from "vitest";

import {
  createVendorCopyCommand,
  needsVendorCopyCommand,
  resolveInstallPackageSpec,
  VENDOR_BUILD_CONTEXT_DIR,
  VENDOR_CONTAINER_DIR,
  type RuntimeContainerPackageOverrides
} from "./containerPackageOverrides.js";

describe("resolveInstallPackageSpec", () => {
  it("returns the pinned registry spec when there is no override", () => {
    expect(resolveInstallPackageSpec(`${DAIMON_PACKAGE_NAME}`, "0.1.2")).toBe(`${DAIMON_PACKAGE_NAME}@0.1.2`);
  });

  it("returns the pinned registry spec when overrides exist for other packages only", () => {
    const overrides: RuntimeContainerPackageOverrides = {
      "@noopolis/mneme": { filename: "noopolis-mneme-0.1.1.tgz" }
    };
    expect(resolveInstallPackageSpec(`${DAIMON_PACKAGE_NAME}`, "0.1.2", overrides)).toBe(
      `${DAIMON_PACKAGE_NAME}@0.1.2`
    );
  });

  it("returns the vendored tarball path when this exact package is overridden", () => {
    const overrides: RuntimeContainerPackageOverrides = {
      [`${DAIMON_PACKAGE_NAME}`]: { filename: "noopolis-daimon-0.1.2.tgz" }
    };
    expect(resolveInstallPackageSpec(`${DAIMON_PACKAGE_NAME}`, "0.1.2", overrides)).toBe(
      `${VENDOR_CONTAINER_DIR}/noopolis-daimon-0.1.2.tgz`
    );
  });
});

describe("needsVendorCopyCommand", () => {
  it("is false with no overrides", () => {
    expect(needsVendorCopyCommand([`${DAIMON_PACKAGE_NAME}`, "@noopolis/mneme"])).toBe(false);
  });

  it("is false when overrides exist but none match the given package names", () => {
    expect(
      needsVendorCopyCommand([`${DAIMON_PACKAGE_NAME}`], {
        "@noopolis/mneme": { filename: "noopolis-mneme-0.1.1.tgz" }
      })
    ).toBe(false);
  });

  it("is true when at least one given package name is overridden", () => {
    expect(
      needsVendorCopyCommand([`${DAIMON_PACKAGE_NAME}`, "@noopolis/mneme"], {
        "@noopolis/mneme": { filename: "noopolis-mneme-0.1.1.tgz" }
      })
    ).toBe(true);
  });
});

describe("createVendorCopyCommand", () => {
  it("copies the vendor build-context directory into the image vendor path", () => {
    expect(createVendorCopyCommand()).toBe(`COPY ${VENDOR_BUILD_CONTEXT_DIR}/ ${VENDOR_CONTAINER_DIR}/`);
  });
});
