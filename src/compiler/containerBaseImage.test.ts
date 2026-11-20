import { expect, it } from "vitest";
import { selectContainerBaseImage } from "./containerBaseImage.js";

it("uses one required base across repeated and mixed agent targets", () => {
  const plans = ["node:22", "node:24", "node:22"];
  expect(selectContainerBaseImage(plans, [{ requiredBaseImage: "pinned:1" }, { baseImage: "preferred:2" }])).toBe("pinned:1");
  expect(selectContainerBaseImage(plans, [{ requiredBaseImage: "pinned:1" }, { requiredBaseImage: "pinned:1" }])).toBe("pinned:1");
  expect(() => selectContainerBaseImage(plans, [{ requiredBaseImage: "a:1" }, { requiredBaseImage: "b:2" }]))
    .toThrow(/incompatible.*a:1, b:2/);
});

it("preserves existing image choices for recipes with optional bases", () => {
  expect(selectContainerBaseImage([], [])).toBe("debian:bookworm-slim");
  expect(selectContainerBaseImage(["debian:one"], [{}])).toBe("debian:one");
  expect(selectContainerBaseImage(["node:22", "node:24"], [{ baseImage: "preferred:1" }, {}])).toBe("preferred:1");
  expect(selectContainerBaseImage(["node:22", "node:24"], [{ baseImage: "p:1" }, { baseImage: "p:2" }])).toBe("node:24");
});
