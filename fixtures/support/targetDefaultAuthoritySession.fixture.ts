import { initializeTargetDefaultAuthoritySession } from "../../src/cli/targetDefaultAuthorities.js";
import { loadTargetDefaultConfig } from "../../src/cli/targetDefaultConfig.js";
import { parseOrganizationAttachmentAuthorizationForDeployment } from "../../src/deployment/organizationHandoffAuthorityTypes.js";
import { parseTargetSecretSourceAuthorization } from "../../src/target/dockerSecretsAuthority.js";

const VERSION = "spawnfile.target-default-authority-child.v1";
const FAILURE_STAGES = new Set(["config", "init", "secret", "handoff", "dispose"]);
const sendResult = (message: Record<string, unknown>): void => { process.send?.(message, () => { process.disconnect(); }); };
const ordinary = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
    ? value as Record<string, unknown> : undefined;

process.once("message", async (raw: unknown) => {
  const input = ordinary(raw);
  if (!input || Buffer.byteLength(JSON.stringify(raw), "utf8") > 16_384
    || Object.keys(input).sort().join(",") !== "config,handoff,secret,version" || input.version !== VERSION) {
    process.exitCode = 1;
    sendResult({ kind: "result", ok: false, stage: "config", version: VERSION }); return;
  }
  let session: Awaited<ReturnType<typeof initializeTargetDefaultAuthoritySession>> | undefined;
  let ok = false;
  let stage = "config";
  try {
    const config = await loadTargetDefaultConfig(input.config as never);
    stage = "init";
    session = await initializeTargetDefaultAuthoritySession(config);
    stage = "secret";
    await session.authorities.secretResolver.resolve({ authorization: parseTargetSecretSourceAuthorization(input.secret) });
    stage = "handoff";
    await session.authorities.handoffResolver.resolve({ authorization: parseOrganizationAttachmentAuthorizationForDeployment(input.handoff) });
    ok = true;
  } catch { /* bounded result below */ }
  finally {
    await session?.dispose().catch(() => { ok = false; stage = "dispose"; });
    process.exitCode = ok ? 0 : 1;
    sendResult(ok ? { handoff: true, kind: "result", ok: true, secret: true, version: VERSION }
      : { kind: "result", ok: false, stage: FAILURE_STAGES.has(stage) ? stage : "dispose", version: VERSION });
  }
});

process.send?.({ kind: "ready", version: VERSION });
