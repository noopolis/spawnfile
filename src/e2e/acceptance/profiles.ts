// B60 — Acceptance profile model.
//
// This module only PREDECLARES the check sets for the "slice" and "full"
// acceptance profiles. It does not run any check. See evaluate.ts for the
// pure verdict logic, and AGENTS.md for the design decisions (D1-D3).

export type AcceptanceProfileId = "slice" | "full";

export type CheckRequirement = "required" | "optional";

export type AcceptanceCheckStatus = "passed" | "skipped" | "failed";

export interface AcceptanceCheckDeclaration {
  id: string;
  title: string;
  requirement: CheckRequirement;
  burnlistRefs: string[];
}

export interface AcceptanceProfile {
  id: AcceptanceProfileId;
  title: string;
  checks: AcceptanceCheckDeclaration[];
}

export interface AcceptanceCheckResult {
  checkId: string;
  status: AcceptanceCheckStatus;
  reason?: string;
  artifacts?: string[];
}

const requiredCheck = (
  id: string,
  title: string,
  burnlistRefs: string[]
): AcceptanceCheckDeclaration => ({ id, title, requirement: "required", burnlistRefs });

const optionalCheck = (
  id: string,
  title: string,
  burnlistRefs: string[]
): AcceptanceCheckDeclaration => ({ id, title, requirement: "optional", burnlistRefs });

// The 10 slice checks. Every one is required: in the slice profile a single
// skip of any kind blocks acceptance (there is no optional escape hatch).
export const SLICE_CHECKS: AcceptanceCheckDeclaration[] = [
  requiredCheck(
    "slice-live-two-agent-task",
    "Live two-agent task completes end to end",
    ["B0", "B58", "B75"]
  ),
  requiredCheck(
    "slice-typed-world-action",
    "Typed world action is accepted and applied",
    ["B0", "B58"]
  ),
  requiredCheck("slice-hidden-fact", "Hidden fact stays hidden until surfaced", ["B0"]),
  requiredCheck(
    "slice-memory-write-recall",
    "Memory write is recalled by the same agent",
    ["B0", "B59", "B70"]
  ),
  // B70 evidence for this check no longer comes from a live E2E harness.
  // The former `memoryAblation.ts` (`npm run test:e2e:daimon-memory-ablation`)
  // was deleted as redundant: its on/off/shuffled recall-mode assertions are
  // now proven in-process by @noopolis/mneme's own `runtime.test.ts`/
  // `recallMode.test.ts`, plus the generated-code seam (does
  // `MNEME_RECALL_MODE` actually gate what lands in the CLI-engine prompt
  // `createCliEnginePrompt` builds?) by this repo's own
  // `src/runtime/pi/appCliSource.test.ts` ("wired to the real @noopolis/mneme
  // memory runtime" describe block). The check id/title/refs stay as-is —
  // this is still a real, required slice check — only the evidence source
  // changed from a live-process E2E run to unit-test results.
  requiredCheck(
    "slice-memory-ablation",
    "Memory ablation measurably degrades recall",
    ["B0", "B70"]
  ),
  requiredCheck(
    "slice-causal-chain",
    "Causal chain across turns is preserved",
    ["B0", "B57", "B89", "B90", "B91", "B92"]
  ),
  requiredCheck("slice-baseline-echo-bot", "Echo-bot baseline runs for comparison", ["B0"]),
  requiredCheck(
    "slice-baseline-single-agent",
    "Single-agent baseline runs for comparison",
    ["B0"]
  ),
  requiredCheck(
    "slice-injected-failure",
    "Injected failure is surfaced rather than silently swallowed",
    ["B0"]
  ),
  requiredCheck(
    "slice-human-ratings",
    "Human ratings are collected for the slice transcripts",
    ["B0", "B32"]
  )
];

export const SLICE_PROFILE: AcceptanceProfile = {
  id: "slice",
  title: "Slice acceptance profile",
  checks: SLICE_CHECKS
};

// The 12 subsystem checks layered on top of the slice for the full profile.
// subsystem-remote-4090 is the sole optional check in either profile — the
// one permissible external-gap example (an on-prem GPU box may be offline).
const SUBSYSTEM_CHECKS: AcceptanceCheckDeclaration[] = [
  requiredCheck(
    "subsystem-spawnfile-cli-status",
    "spawnfile CLI status surface is correct",
    ["B38", "B56"]
  ),
  requiredCheck("subsystem-spawnfile-dev", "spawnfile dev loop works end to end", ["B39"]),
  requiredCheck("subsystem-compiler", "Compiler produces a valid resolved graph", ["B93"]),
  requiredCheck("subsystem-runtime-images", "Runtime images build and boot", ["B44"]),
  requiredCheck(
    "subsystem-moltnet",
    "Moltnet bridges deliver messages across agents",
    ["B20", "B21", "B22", "B23"]
  ),
  requiredCheck(
    "subsystem-mneme",
    "Mneme memory subsystem persists and recalls",
    ["B26", "B59", "B68"]
  ),
  requiredCheck("subsystem-daimon", "Daimon runtime executes generated apps", ["B24", "B91"]),
  requiredCheck(
    "subsystem-simfile-runtime",
    "Simfile runtime executes authored scenarios",
    ["B33", "B58"]
  ),
  requiredCheck(
    "subsystem-simfile-viewer",
    "Simfile viewer renders transcripts and reports",
    ["B35", "B36", "B49", "B53"]
  ),
  optionalCheck(
    "subsystem-remote-4090",
    "Remote 4090 Docker context is reachable",
    ["B43"]
  ),
  requiredCheck(
    "subsystem-security-audit",
    "Security audit findings are triaged and closed",
    ["B46", "B54"]
  ),
  requiredCheck("subsystem-conformance", "Conformance suite passes against the spec", ["B67"])
];

// The 6 production-readiness checks. B67 (conformance) is carried by
// subsystem-conformance above and must not be double-declared here.
const PRODUCTION_CHECKS: AcceptanceCheckDeclaration[] = [
  requiredCheck("prod-threat-model", "Threat model is documented and reviewed", ["B61"]),
  requiredCheck(
    "prod-identity-capability",
    "Identity and capability boundaries are enforced",
    ["B62"]
  ),
  requiredCheck("prod-data-governance", "Data governance policy is enforced", ["B63"]),
  requiredCheck(
    "prod-distributed-failure",
    "Distributed failure modes are handled gracefully",
    ["B64"]
  ),
  requiredCheck(
    "prod-slo-budgets-estop",
    "SLO budgets and emergency stop are wired up",
    ["B65"]
  ),
  requiredCheck("prod-provenance", "Provenance is tracked end to end", ["B66"])
];

export const FULL_CHECKS: AcceptanceCheckDeclaration[] = [
  ...SLICE_CHECKS,
  ...SUBSYSTEM_CHECKS,
  ...PRODUCTION_CHECKS
];

export const FULL_PROFILE: AcceptanceProfile = {
  id: "full",
  title: "Full acceptance profile",
  checks: FULL_CHECKS
};

export const ACCEPTANCE_PROFILES: Record<AcceptanceProfileId, AcceptanceProfile> = {
  slice: SLICE_PROFILE,
  full: FULL_PROFILE
};

export const getAcceptanceProfile = (id: AcceptanceProfileId): AcceptanceProfile =>
  ACCEPTANCE_PROFILES[id];
