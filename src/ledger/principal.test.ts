import { describe, expect, it } from "vitest";

import {
  ANONYMOUS_SYSTEM_PRINCIPAL,
  isAuthenticatedPrincipal,
  isPrincipalParseError,
  parsePrincipal,
  PRINCIPAL_GRAMMAR_SOURCE
} from "./principal.js";

describe("PRINCIPAL_GRAMMAR_SOURCE", () => {
  it("matches the schema pattern documented in specs/causal-event.v1.schema.json", () => {
    expect(PRINCIPAL_GRAMMAR_SOURCE).toBe("^(agent|operator|system):.+");
  });
});

describe("parsePrincipal", () => {
  it.each([
    ["agent:mapper", "agent", "mapper"],
    ["operator:control", "operator", "control"],
    ["operator:juancfortunatti@gmail.com", "operator", "juancfortunatti@gmail.com"],
    ["system:simfile.world", "system", "simfile.world"],
    ["system:moltnet.anonymous", "system", "moltnet.anonymous"]
  ])("parses %s into kind=%s id=%s", (value, kind, id) => {
    const result = parsePrincipal(value);
    expect(isPrincipalParseError(result)).toBe(false);
    expect(result).toEqual({ id, kind });
  });

  it.each([
    ["mapper", "a bare id with no prefix"],
    ["", "an empty string"],
    ["moltnet:authn:agent-1", "an unrecognized prefix"],
    ["agent:", "a prefix with no id"],
    ["anonymous", "the bare literal anonymous"],
    [" agent:mapper", "leading whitespace before the prefix"]
  ])("reports a parse error for %s (%s)", (value) => {
    const result = parsePrincipal(value);
    expect(isPrincipalParseError(result)).toBe(true);
    expect(isPrincipalParseError(result) && result.message.length).toBeGreaterThan(0);
  });
});

describe("isAuthenticatedPrincipal", () => {
  it.each(["agent:mapper", "operator:control", "system:simfile.world", "agent:agent-1"])(
    "accepts %s",
    (value) => {
      expect(isAuthenticatedPrincipal(value)).toBe(true);
    }
  );

  it.each([
    ["mapper", "a bare id"],
    ["", "an empty string"],
    ["anonymous", "the literal anonymous"],
    [ANONYMOUS_SYSTEM_PRINCIPAL, "moltnet's unauthenticated dev-mode placeholder"],
    ["moltnet:authn:agent-1", "an unrecognized kind prefix"],
    ["agent:", "an empty trailing id"],
    ["  ", "whitespace only"]
  ])("rejects %s (%s)", (value) => {
    expect(isAuthenticatedPrincipal(value)).toBe(false);
  });

  it("rejects non-string input without throwing", () => {
    expect(isAuthenticatedPrincipal(undefined as unknown as string)).toBe(false);
    expect(isAuthenticatedPrincipal(null as unknown as string)).toBe(false);
  });
});
