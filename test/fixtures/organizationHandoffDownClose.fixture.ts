import { initializeOrganizationHandoffAuthorityStore } from "../../src/deployment/organizationHandoffAuthorityStore.js";

const VERSION = "spawnfile.deployment-handoff-close.v1" as const;
const MAX_MESSAGE_BYTES = 4_096;
const validMessage = (raw: unknown): raw is {
  readonly expectedHandoff: unknown;
  readonly organizationHandoffHandle: string;
  readonly version: typeof VERSION;
} =>
  raw !== null && typeof raw === "object" && Object.getPrototypeOf(raw) === Object.prototype
  && Buffer.byteLength(JSON.stringify(raw), "utf8") <= MAX_MESSAGE_BYTES
  && Object.keys(raw).sort().join(",") === "expectedHandoff,organizationHandoffHandle,version"
  && (raw as { version?: unknown }).version === VERSION
  && typeof (raw as { organizationHandoffHandle?: unknown }).organizationHandoffHandle === "string"
  && /^opaque_[a-f0-9]{16,64}$/u.test((raw as { organizationHandoffHandle: string }).organizationHandoffHandle);
const send = (message: { readonly failed?: true; readonly ok?: true; readonly ready?: true; readonly version: typeof VERSION }): void => {
  if (process.send?.(message) !== true) process.exit(1);
};

let received = false;
process.once("message", async (raw: unknown) => {
  if (received || !validMessage(raw)) {
    send({ failed: true, version: VERSION });
    process.exit(1);
    return;
  }
  received = true;
  let authority: Awaited<ReturnType<typeof initializeOrganizationHandoffAuthorityStore>> | undefined;
  try {
    authority = await initializeOrganizationHandoffAuthorityStore();
    await authority.close({
      expectedHandoff: raw.expectedHandoff,
      organizationHandoffHandle: raw.organizationHandoffHandle
    });
    await authority.dispose();
    send({ ok: true, version: VERSION });
    process.exit(0);
  } catch {
    await authority?.dispose().catch(() => undefined);
    send({ failed: true, version: VERSION });
    process.exit(1);
  }
});

send({ ready: true, version: VERSION });
