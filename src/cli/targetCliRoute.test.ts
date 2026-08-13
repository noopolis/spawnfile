import { describe, expect, it } from "vitest";

import { isTargetLookupInvocation } from "./targetCliRoute.js";

describe("target CLI entry routing", () => {
  it("routes lookup for every supported config position and form", () => {
    for (const argv of [
      ["target", "--config", "-", "lookup_operation", "/tmp/request.json"],
      ["target", "--config=-", "lookup_operation", "/tmp/request.json"],
      ["target", "lookup_operation", "--config", "-", "/tmp/request.json"],
      ["target", "lookup_operation", "--config=-", "/tmp/request.json"]
    ]) expect(isTargetLookupInvocation(argv)).toBe(true);
  });

  it("lets the first actual subcommand decide, never a request filename", () => {
    for (const argv of [
      ["target", "create_data_network", "lookup_operation"],
      ["target", "--config", "-", "create_data_network", "lookup_operation"],
      ["target", "create_data_network", "--config", "-", "lookup_operation"],
      ["target", "--unknown", "lookup_operation"],
      ["target", "--config", "lookup_operation"]
    ]) expect(isTargetLookupInvocation(argv)).toBe(false);
  });
});
