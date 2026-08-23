import { describe, expect, it } from "vitest";

import { parseDockerBaseImageReference } from "./dockerBaseImage.js";

describe("Docker base-image reference", () => {
  it.each(["node:22-bookworm-slim", `registry.example/node@sha256:${"a".repeat(64)}`])(
    "accepts %s", (value) => expect(parseDockerBaseImageReference(value)).toBe(value)
  );
  it.each([" sha", "sha ", "sha256:" + "a".repeat(64), "bad image", "node@sha256:short"])(
    "rejects %s", (value) => expect(parseDockerBaseImageReference(value)).toBeNull()
  );
});
