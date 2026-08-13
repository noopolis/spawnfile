import { describe, expect, it } from "vitest";

import type { CausalEvent } from "../ledger/index.js";

import type { RunLedgerEvidence, StaticContainerEvidence } from "./checks.js";
import {
  checkContainerNoBakedSecrets,
  checkControlWakeFailClosed,
  checkDeniedLedgerVisible,
  checkMemoryCrossScopeCapability,
  checkNonMemberWriteDenied,
  checkPrincipalsAuthenticated,
  checkProvenanceSignedReport
} from "./checks.js";

const buildEvent = (overrides: Partial<CausalEvent> & { type: string }): CausalEvent => ({
  cause_event_ids: [],
  emitter: { system: "moltnet", stream_id: "room:general", seq: 1 },
  event_id: "moltnet:e1",
  payload: {},
  principal_id: "agent:alice",
  recorded_at: "2026-07-01T00:00:00.000Z",
  run_id: "b92-conformance",
  version: "noopolis.causal-event.v1",
  ...overrides
});

const buildLedgerEvidence = (overrides: Partial<RunLedgerEvidence> = {}): RunLedgerEvidence => ({
  eventCount: 0,
  events: [],
  expectedDenialTypes: [],
  issues: [],
  manifestPresent: false,
  sources: ["ledger"],
  ...overrides
});

const buildStaticEvidence = (overrides: Partial<StaticContainerEvidence> = {}): StaticContainerEvidence => ({
  dockerfile: "FROM node:22-slim\n",
  entrypoint: "",
  piAppSource: "",
  requiredSecrets: [],
  ...overrides
});

describe("checkPrincipalsAuthenticated", () => {
  it("is not_applicable with no run artifacts, and never pass without them", () => {
    const check = checkPrincipalsAuthenticated(undefined);
    expect(check.status).toBe("not_applicable");
    expect(check.evidence).toEqual({ reason: "no run artifacts provided" });
  });

  it("passes when there are zero issues and every principal is authenticated", () => {
    const evidence = buildLedgerEvidence({
      eventCount: 1,
      events: [buildEvent({ type: "message.accepted", principal_id: "agent:alice" })]
    });
    expect(checkPrincipalsAuthenticated(evidence).status).toBe("pass");
  });

  it("fails and names the offending event/principal for a bare or anonymous principal", () => {
    const offending = buildEvent({
      event_id: "moltnet:bad",
      principal_id: "system:moltnet.anonymous",
      type: "message.accepted"
    });
    const evidence = buildLedgerEvidence({ eventCount: 1, events: [offending] });
    const check = checkPrincipalsAuthenticated(evidence);
    expect(check.status).toBe("fail");
    expect(check.evidence.offendingPrincipals).toEqual([
      { event_id: "moltnet:bad", principal_id: "system:moltnet.anonymous" }
    ]);
  });

  it("fails when runRealConformance reported any other issue, even with authenticated principals", () => {
    const evidence = buildLedgerEvidence({
      eventCount: 1,
      events: [buildEvent({ type: "message.accepted" })],
      issues: [{ message: "some other conformance problem", source: "ledger" }]
    });
    expect(checkPrincipalsAuthenticated(evidence).status).toBe("fail");
  });
});

describe("checkDeniedLedgerVisible", () => {
  it("is not_applicable with no run artifacts", () => {
    expect(checkDeniedLedgerVisible(undefined).status).toBe("not_applicable");
  });

  it("is not_applicable — never pass — when there are zero denial events and no expected-denials manifest", () => {
    // The defect this replaces: `malformed.length === 0` was trivially true
    // with zero denial events present, so this used to report `pass` even
    // though enforcement was never exercised. See AGENTS.md's cardinal rule.
    const check = checkDeniedLedgerVisible(buildLedgerEvidence());
    expect(check.status).toBe("not_applicable");
    expect(check.evidence).toEqual({
      reason: "no denial events and no expected-denials manifest; cannot assess silent-drop"
    });
  });

  it("fails when a present denied event is missing a required key, even with no manifest present", () => {
    const malformedDenial = buildEvent({
      event_id: "moltnet:denied1",
      payload: { reason: "not a room member" }, // missing target + content_sha256
      type: "message.denied"
    });
    const evidence = buildLedgerEvidence({ events: [malformedDenial] });
    const check = checkDeniedLedgerVisible(evidence);
    expect(check.status).toBe("fail");
    expect(check.evidence.malformed).toEqual([
      { event_id: "moltnet:denied1", missingKeys: ["target", "content_sha256"], type: "message.denied" }
    ]);
  });

  it("fails on a silent drop — a manifest-asserted denial type with no matching event", () => {
    const evidence = buildLedgerEvidence({ events: [], expectedDenialTypes: ["message.denied"], manifestPresent: true });
    const check = checkDeniedLedgerVisible(evidence);
    expect(check.status).toBe("fail");
    expect(check.evidence.silentlyDropped).toEqual(["message.denied"]);
  });

  it("passes when the manifest-asserted denial type has a well-shaped matching event", () => {
    const denial = buildEvent({
      event_id: "moltnet:denied1",
      payload: { content_sha256: "abc", reason: "not a room member", target: "room:secret" },
      type: "message.denied"
    });
    const evidence = buildLedgerEvidence({
      events: [denial],
      expectedDenialTypes: ["message.denied"],
      manifestPresent: true
    });
    expect(checkDeniedLedgerVisible(evidence).status).toBe("pass");
  });

  it("passes when a manifest is present but asserts nothing and no denial events exist (a real, grounded absence-of-expectation, not silence)", () => {
    const evidence = buildLedgerEvidence({ events: [], expectedDenialTypes: [], manifestPresent: true });
    expect(checkDeniedLedgerVisible(evidence).status).toBe("pass");
  });
});

describe("checkControlWakeFailClosed", () => {
  const failClosedSource =
    'return { ok: false, reason: "no operator token configured (" + CONTROL_TOKEN_ENV + " is unset)" };';

  it("passes when the token is referenced, the fail-closed branch is present, and no default is baked", () => {
    const evidence = buildStaticEvidence({
      piAppSource: `const CONTROL_TOKEN_ENV = "SPAWNFILE_PI_CONTROL_TOKEN";\n${failClosedSource}`
    });
    expect(checkControlWakeFailClosed(evidence).status).toBe("pass");
  });

  it("fails when the fail-closed rejection branch is absent from the compiled Pi app source", () => {
    const evidence = buildStaticEvidence({
      piAppSource: 'const CONTROL_TOKEN_ENV = "SPAWNFILE_PI_CONTROL_TOKEN";'
    });
    const check = checkControlWakeFailClosed(evidence);
    expect(check.status).toBe("fail");
    expect(check.evidence.failClosedMarkerFound).toBe(false);
  });

  it("fails when a literal default token value is baked into the Dockerfile", () => {
    const evidence = buildStaticEvidence({
      dockerfile: "ENV SPAWNFILE_PI_CONTROL_TOKEN=insecure-default\n",
      piAppSource: `const CONTROL_TOKEN_ENV = "SPAWNFILE_PI_CONTROL_TOKEN";\n${failClosedSource}`
    });
    const check = checkControlWakeFailClosed(evidence);
    expect(check.status).toBe("fail");
    expect(check.evidence.bakedDefaultFound).toBe(true);
  });

  it("fails when the token env is never referenced at all", () => {
    expect(checkControlWakeFailClosed(buildStaticEvidence()).status).toBe("fail");
  });
});

describe("checkContainerNoBakedSecrets", () => {
  it("passes when every required secret is require_env-guarded and never assigned a literal value", () => {
    const evidence = buildStaticEvidence({
      entrypoint: "require_env 'OPENAI_API_KEY'\nexec node app.mjs\n",
      requiredSecrets: ["OPENAI_API_KEY"]
    });
    expect(checkContainerNoBakedSecrets(evidence).status).toBe("pass");
  });

  it("fails when a required secret has no require_env guard in the entrypoint", () => {
    const evidence = buildStaticEvidence({
      entrypoint: "exec node app.mjs\n",
      requiredSecrets: ["OPENAI_API_KEY"]
    });
    const check = checkContainerNoBakedSecrets(evidence);
    expect(check.status).toBe("fail");
    expect(check.evidence.missingRequireEnv).toEqual(["OPENAI_API_KEY"]);
  });

  it("fails when a required secret is baked as a literal value in the Dockerfile", () => {
    const evidence = buildStaticEvidence({
      dockerfile: "ENV OPENAI_API_KEY=sk-test-baked-value\n",
      entrypoint: "require_env 'OPENAI_API_KEY'\n",
      requiredSecrets: ["OPENAI_API_KEY"]
    });
    const check = checkContainerNoBakedSecrets(evidence);
    expect(check.status).toBe("fail");
    expect(check.evidence.bakedLiteralValues).toEqual(["OPENAI_API_KEY"]);
  });

  it("does not flag a shell variable reference as a baked literal", () => {
    const evidence = buildStaticEvidence({
      entrypoint: "require_env 'OPENAI_API_KEY'\nOPENAI_API_KEY=\"$OPENAI_API_KEY\" exec node app.mjs\n",
      requiredSecrets: ["OPENAI_API_KEY"]
    });
    expect(checkContainerNoBakedSecrets(evidence).status).toBe("pass");
  });
});

describe("checkMemoryCrossScopeCapability", () => {
  it("is not_applicable with no run artifacts", () => {
    expect(checkMemoryCrossScopeCapability(undefined).status).toBe("not_applicable");
  });

  it("is not_applicable — never pass — when no memory.write.denied events exist", () => {
    // The defect this replaces: `malformed.length === 0` was trivially true
    // with zero denial events present, so a ledger that never exercised the
    // cross-scope guard used to earn a green `pass` here.
    const check = checkMemoryCrossScopeCapability(buildLedgerEvidence());
    expect(check.status).toBe("not_applicable");
    expect(check.evidence).toEqual({
      deniedEventCount: 0,
      reason: "no memory.write.denied events observed; cross-scope enforcement was not exercised in this run"
    });
  });

  it("fails when a memory.write.denied event is missing requested_scope or reason", () => {
    const malformed = buildEvent({ payload: { reason: "blocked" }, type: "memory.write.denied" });
    const check = checkMemoryCrossScopeCapability(buildLedgerEvidence({ events: [malformed] }));
    expect(check.status).toBe("fail");
  });

  it("passes when every memory.write.denied event carries requested_scope and reason", () => {
    const wellShaped = buildEvent({
      payload: { reason: "foreign scope write blocked", requested_scope: "team:other" },
      type: "memory.write.denied"
    });
    expect(checkMemoryCrossScopeCapability(buildLedgerEvidence({ events: [wellShaped] })).status).toBe("pass");
  });
});

describe("checkNonMemberWriteDenied", () => {
  it("is not_applicable with no run artifacts", () => {
    expect(checkNonMemberWriteDenied(undefined).status).toBe("not_applicable");
  });

  it("is not_applicable — never pass — when no message.denied events exist", () => {
    // The defect this replaces: the committed broken-silent-drop fixture
    // made this report `pass` with deniedEventCount:0 — rubber-stamping
    // green the very silent-drop check 2 flags.
    const check = checkNonMemberWriteDenied(buildLedgerEvidence());
    expect(check.status).toBe("not_applicable");
    expect(check.evidence).toEqual({
      deniedEventCount: 0,
      reason: "no message.denied events observed; non-member write enforcement was not exercised in this run"
    });
  });

  it("fails when a message.denied event is missing target, reason, or content_sha256", () => {
    const malformed = buildEvent({ payload: { reason: "not a member" }, type: "message.denied" });
    expect(checkNonMemberWriteDenied(buildLedgerEvidence({ events: [malformed] })).status).toBe("fail");
  });

  it("passes when every message.denied event carries target, reason, and content_sha256", () => {
    const wellShaped = buildEvent({
      payload: { content_sha256: "abc", reason: "not a room member", target: "room:secret" },
      type: "message.denied"
    });
    expect(checkNonMemberWriteDenied(buildLedgerEvidence({ events: [wellShaped] })).status).toBe("pass");
  });
});

describe("checkProvenanceSignedReport", () => {
  it("is always not_applicable, deferred to B66, and never pass", () => {
    const check = checkProvenanceSignedReport();
    expect(check.status).toBe("not_applicable");
    expect(check.evidence).toEqual({ reason: "not yet enforced (see B66)" });
    expect(check.id).toBe("provenance.signed-report");
  });
});
