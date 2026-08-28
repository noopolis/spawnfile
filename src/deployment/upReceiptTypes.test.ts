import { describe, expect, it } from "vitest";

import { parseUpReceipt, UP_RECEIPT_VERSION, type UpReceipt, upReceiptSchema } from "./upReceiptTypes.js";

const createReceipt = (overrides: Partial<UpReceipt> = {}): UpReceipt => ({
  compiled_schedule: [{ agent: "agent:analyst", cron: "0 5 * * *" }],
  deployment: { container_ids: ["container-123"], name: "default" },
  fingerprint: "sf1:abc123",
  readiness: { moltnet_base_url: "http://127.0.0.1:8787", state: "running" },
  run_id: "run-abc123",
  version: UP_RECEIPT_VERSION,
  ...overrides
});

const organizationReadiness = {
  code: "organization_ready",
  compile_fingerprint: "sf1:0123456789ab",
  run_id: "run-123",
  state: "ready",
  unit_id: "football-unit",
  version: "spawnfile.organization-ready.v1",
  world_binding_digest: `sha256:${"a".repeat(64)}`
} as const;

const organizationReadyStates = ["ready", "pending", "failed", "cancelled"] as const;
const organizationReadyCodes = [
  "organization_ready", "external_moltnet", "compiled_evidence_missing", "unit_unavailable",
  "unit_restarted", "probe_unavailable", "identity_mismatch", "topology_mismatch", "probe_timeout",
  "probe_cancelled"
] as const;
const validOrganizationReadyMappings = new Set([
  "ready:organization_ready",
  "pending:external_moltnet", "pending:compiled_evidence_missing", "pending:unit_unavailable",
  "pending:unit_restarted", "pending:probe_unavailable",
  "failed:identity_mismatch", "failed:topology_mismatch", "failed:probe_timeout",
  "cancelled:probe_cancelled"
]);

describe("upReceiptSchema / parseUpReceipt", () => {
  it("round-trips a conformant receipt", () => {
    const receipt = createReceipt();
    expect(parseUpReceipt(JSON.parse(JSON.stringify(receipt)))).toEqual(receipt);
  });

  it("accepts a null run_id, null deployment name, and an empty compiled_schedule", () => {
    const receipt = createReceipt({
      compiled_schedule: [],
      deployment: { container_ids: [], name: null },
      readiness: { moltnet_base_url: null, state: "unknown" },
      run_id: null
    });
    expect(parseUpReceipt(receipt)).toEqual(receipt);
  });

  it("rejects an unknown version string", () => {
    expect(() => parseUpReceipt({ ...createReceipt(), version: "spawnfile.up-receipt.v2" })).toThrow(
      /invalid spawnfile\.up-receipt\.v1/
    );
  });

  it("rejects an unknown readiness state", () => {
    const receipt = createReceipt();
    expect(() =>
      parseUpReceipt({ ...receipt, readiness: { ...receipt.readiness, state: "healthy" } })
    ).toThrow(/invalid spawnfile\.up-receipt\.v1/);
  });

  it("rejects credential-shaped extra fields (strict schema)", () => {
    expect(() => parseUpReceipt({ ...createReceipt(), auth_token: "sk-should-not-be-here" })).toThrow();
  });

  it("rejects a malformed compiled_schedule entry", () => {
    expect(() =>
      parseUpReceipt({ ...createReceipt(), compiled_schedule: [{ agent: "agent:x" }] })
    ).toThrow();
  });

  it("validates a receipt with no engines field at all (pre-Piece-5 receipts stay conformant)", () => {
    const receipt = createReceipt();
    expect("engines" in receipt).toBe(false);
    expect(parseUpReceipt(receipt)).toEqual(receipt);
  });

  it("accepts an engines list disclosing a scripted engine per agent", () => {
    const receipt = createReceipt({
      engines: [
        { agent: "agent:eleanor", engine: "scripted" },
        { agent: "agent:sam", engine: "grok" }
      ]
    });
    expect(parseUpReceipt(receipt)).toEqual(receipt);
  });

  it("rejects a malformed engines entry", () => {
    expect(() =>
      parseUpReceipt({ ...createReceipt(), engines: [{ agent: "agent:eleanor" }] })
    ).toThrow();
  });

  it("round-trips only a pinned Pi-bridge Moltnet release identity", () => {
    const identity = {
      architecture: "amd64" as const,
      asset: "moltnet_linux_amd64.tar.gz",
      asset_sha256: `sha256:${"b".repeat(64)}` as const,
      capabilities: ["pi-bridge"] as ["pi-bridge"],
      release_version: "v0.1.14-1-gaaaaaaa",
      source_revision: "a".repeat(40),
      version: "spawnfile.moltnet-release-identity.v1" as const
    };
    expect(parseUpReceipt(createReceipt({ moltnet_release: identity })).moltnet_release).toEqual(identity);
    for (const moltnet_release of [
      { ...identity, capabilities: [] },
      { ...identity, release_version: "latest" },
      { ...identity, source_revision: "b".repeat(40) },
      { ...identity, asset: "moltnet_linux_arm64.tar.gz" },
      { ...identity, token: "secret" }
    ]) {
      expect(() => parseUpReceipt({ ...createReceipt(), moltnet_release })).toThrow();
    }
  });

  it("round-trips stored organization readiness and retains old absence compatibility", () => {
    expect(upReceiptSchema.safeParse(createReceipt({ organization_ready: organizationReadiness })).success).toBe(true);
    expect(upReceiptSchema.safeParse(createReceipt()).success).toBe(true);
    expect(parseUpReceipt(createReceipt({ organization_ready: organizationReadiness })).organization_ready)
      .toEqual(organizationReadiness);
    expect(parseUpReceipt(createReceipt())).not.toHaveProperty("organization_ready");
  });

  it("rejects extra, sensitive, malformed, prototype-bearing, and unknown readiness values", () => {
    const prototypeBearing = Object.assign(Object.create({ inherited: true }), organizationReadiness);
    for (const organization_ready of [
      { ...organizationReadiness, url: "http://private.example" },
      { ...organizationReadiness, token: "AKIAIOSFODNN7EXAMPLE" },
      { ...organizationReadiness, code: "raw error: secret" },
      { ...organizationReadiness, version: "spawnfile.organization-ready.v0" },
      { ...organizationReadiness, state: "pending", code: "organization_ready" },
      { ...organizationReadiness, state: "failed", code: "probe_unavailable" },
      { ...organizationReadiness, compile_fingerprint: "sf1:bad" },
      { ...organizationReadiness, unit_id: "not valid" },
      { ...organizationReadiness, run_id: "bad/run" },
      { ...organizationReadiness, world_binding_digest: "sha256:bad" },
      { ...organizationReadiness, run_id: null },
      prototypeBearing
    ]) {
      const receipt = { ...createReceipt(), organization_ready };
      expect(upReceiptSchema.safeParse(receipt).success).toBe(false);
      expect(() => parseUpReceipt(receipt)).toThrow();
    }
  });

  it("exhaustively proves the organization readiness mapping at the parent schema", () => {
    for (const state of organizationReadyStates) {
      for (const code of organizationReadyCodes) {
        const organization_ready = { ...organizationReadiness, state, code };
        const accepted = upReceiptSchema.safeParse({
          ...createReceipt(),
          organization_ready
        }).success;
        expect(accepted, `${state}/${code}`).toBe(validOrganizationReadyMappings.has(`${state}:${code}`));
      }
    }
  });
});
