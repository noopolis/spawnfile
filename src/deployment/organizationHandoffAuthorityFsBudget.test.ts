import { describe, expect, it } from "vitest";

import {
  createOrganizationHandoffAuthorityError,
  describeOrganizationHandoffAuthorityFailure,
  OrganizationHandoffAuthorityBudget, OrganizationHandoffAuthorityFailure,
  ORGANIZATION_HANDOFF_AUTHORITY_ERROR,
  parseOrganizationHandoffAuthorityFailureDetail,
  PUBLICATION_BUDGET_MS, PUBLICATION_MAX_ATTEMPTS, PUBLICATION_PATIENCE_FRACTION,
  toOrganizationHandoffAuthorityFailureDetail
} from "./organizationHandoffAuthorityFsBudget.js";

/** A controllable clock so budget behaviour is asserted, never timed. */
const clock = (): { advance(ms: number): void; now(): number } => {
  let value = 0;
  return { advance: (ms) => { value += ms; }, now: () => value };
};

describe("organization handoff authority budget", () => {
  it("bounds convergence by wall clock rather than attempt count", async () => {
    const time = clock();
    // Each attempt costs a tenth of the budget in real time, whatever the
    // nominal backoff was: this is the loaded-machine case.
    const budget = new OrganizationHandoffAuthorityBudget({
      limitMs: 1_000, now: time.now, sleep: async () => { time.advance(100); }
    });
    let attempts = 0;
    while (!budget.exhausted()) { await budget.wait(); attempts += 1; }
    expect(attempts).toBe(10);
    expect(budget.elapsedMs).toBe(1_000);
  });

  it("spends the same deadline over far more attempts when attempts are cheap", async () => {
    const time = clock();
    const budget = new OrganizationHandoffAuthorityBudget({
      limitMs: 1_000, now: time.now, sleep: async () => { time.advance(1); }
    });
    let attempts = 0;
    while (!budget.exhausted()) { await budget.wait(); attempts += 1; }
    // The attempt-counted predecessor would have given up after a fixed 64
    // attempts in both cases; the deadline is what must stay constant.
    expect(attempts).toBe(1_000);
    expect(budget.elapsedMs).toBe(1_000);
  });

  it("keeps the attempt cap as a secondary bound against a stalled clock", async () => {
    const time = clock();
    const budget = new OrganizationHandoffAuthorityBudget({
      limitMs: 1_000, maxAttempts: 5, now: time.now, sleep: async () => undefined
    });
    let attempts = 0;
    while (!budget.exhausted()) { await budget.wait(); attempts += 1; }
    expect(attempts).toBe(5);
    expect(budget.elapsedMs).toBe(0);
  });

  it("expires patience strictly before the budget so recovery can still run", () => {
    const time = clock();
    const budget = new OrganizationHandoffAuthorityBudget({ limitMs: 1_000, now: time.now });
    expect(budget.patient()).toBe(true);
    time.advance(1_000 * PUBLICATION_PATIENCE_FRACTION);
    expect(budget.patient()).toBe(false);
    expect(budget.exhausted()).toBe(false);
    time.advance(1_000);
    expect(budget.exhausted()).toBe(true);
    expect(budget.patient()).toBe(false);
  });

  it("grows and jitters the backoff without ever waiting past the deadline", async () => {
    const time = clock();
    const delays: number[] = [];
    const budget = new OrganizationHandoffAuthorityBudget({
      limitMs: 100, now: time.now, sleep: async (ms) => { delays.push(ms); time.advance(ms); }
    });
    for (let index = 0; index < 40 && !budget.exhausted(); index += 1) await budget.wait();
    expect(delays.length).toBeGreaterThan(1);
    // Jittered, so never assert exact values: assert the envelope instead.
    for (const delay of delays) expect(delay).toBeGreaterThanOrEqual(0);
    expect(Math.max(...delays)).toBeLessThanOrEqual(25);
    expect(delays.slice(-1)[0]).toBeGreaterThan(delays[0] as number);
    expect(time.now()).toBeLessThanOrEqual(100);
  });

  it("ships defaults that fit inside one client request", () => {
    expect(PUBLICATION_BUDGET_MS).toBeGreaterThan(0);
    expect(PUBLICATION_MAX_ATTEMPTS).toBeGreaterThan(PUBLICATION_BUDGET_MS / 25);
    expect(PUBLICATION_PATIENCE_FRACTION).toBeGreaterThan(0);
    expect(PUBLICATION_PATIENCE_FRACTION).toBeLessThan(1);
  });
});

describe("organization handoff authority failure detail", () => {
  it("keeps the uniform message and appends the diagnosis", () => {
    const time = clock();
    const budget = new OrganizationHandoffAuthorityBudget({ limitMs: 500, now: time.now });
    time.advance(500);
    const error = createOrganizationHandoffAuthorityError(
      budget.snapshot("settle_budget_exhausted", "settle", "final:absent pending:nlink=1,size=10,mode=600"));
    expect(error.message).toContain(ORGANIZATION_HANDOFF_AUTHORITY_ERROR);
    expect(error.message).toContain("settle_budget_exhausted");
    expect(error.message).toContain("budget=settle");
    expect(error.message).toContain("attempts=0");
    expect(error.message).toContain("elapsed=500ms");
    expect(error.message).toContain("limit=500ms");
    expect(error.message).toContain("pending:nlink=1");
  });

  it("produces the exact historical message when there is nothing to add", () => {
    expect(createOrganizationHandoffAuthorityError().message).toBe(ORGANIZATION_HANDOFF_AUTHORITY_ERROR);
  });

  it("renders a bare code with no field list", () => {
    expect(describeOrganizationHandoffAuthorityFailure({ code: "not_ready" })).toBe("not_ready");
  });

  it("narrows and clamps an untrusted IPC payload", () => {
    expect(parseOrganizationHandoffAuthorityFailureDetail(undefined)).toBeUndefined();
    expect(parseOrganizationHandoffAuthorityFailureDetail({ code: "" })).toBeUndefined();
    expect(parseOrganizationHandoffAuthorityFailureDetail(["code"])).toBeUndefined();
    const parsed = parseOrganizationHandoffAuthorityFailureDetail({
      attempts: 3, budget: "settle", code: "x".repeat(200), elapsedMs: 12.5,
      extra: "dropped", limitMs: Number.NaN, state: "y".repeat(1_000)
    });
    expect(parsed?.code).toHaveLength(64);
    expect(parsed?.state).toHaveLength(240);
    expect(parsed?.attempts).toBe(3);
    expect(parsed?.elapsedMs).toBe(12.5);
    expect(parsed?.limitMs).toBeUndefined();
    expect(parsed).not.toHaveProperty("extra");
  });

  it("reduces an arbitrary thrown value to a bounded detail", () => {
    const failure = new OrganizationHandoffAuthorityFailure({ code: "settle_budget_exhausted" });
    expect(toOrganizationHandoffAuthorityFailureDetail(failure)).toBe(failure.detail);
    expect(toOrganizationHandoffAuthorityFailureDetail(new TypeError("boom")))
      .toEqual({ code: "unexpected_error", state: "TypeError" });
    expect(toOrganizationHandoffAuthorityFailureDetail("boom"))
      .toEqual({ code: "unexpected_error", state: "string" });
  });

  it("never carries record bytes into the diagnostic", () => {
    const secret = "s".repeat(30_000);
    const detail = toOrganizationHandoffAuthorityFailureDetail(new Error(secret));
    expect(describeOrganizationHandoffAuthorityFailure(detail)).not.toContain("ssss");
  });
});
