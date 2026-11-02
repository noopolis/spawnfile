import { expect, it } from "vitest";

import { createTrialDocker } from "./docker.js";

it("returns stderr after stdout only when asked, so container logs keep the runtime's own refusal", async () => {
  const run = createTrialDocker("/bin/sh");
  const args = ["-c", "echo out; echo err >&2"];
  await expect(run(args)).resolves.toBe("out");
  await expect(run(args, { combined: true })).resolves.toBe("out\nerr");
});
