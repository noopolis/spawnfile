import type { DaimonCapabilityReceipts } from "./registry.js";
import { DAIMON_CONTRACT_MANIFEST_SHA256, DAIMON_GROK_ENGINE_BROKER } from "./daimon/contractManifest.js";

/**
 * A published multi-architecture Daimon index embeds a different receipt per
 * platform (the packaged broker and pinned CLIs are per-architecture), so the
 * generated image checks the receipt pinned for the architecture it builds.
 */
const createDaimonReceiptCheck = (receiptPath: string, receipt: string | DaimonCapabilityReceipts): string => {
  const actual = `test -f ${receiptPath} && actual="$(sha256sum ${receiptPath} | awk '{print "sha256:" $1}')"`;
  if (typeof receipt === "string") return `${actual} && test "$actual" = ${JSON.stringify(receipt)}`;
  const cases = Object.entries(receipt)
    .map(([architecture, digest]) => `${architecture}) expected=${JSON.stringify(digest)} ;;`)
    .join(" ");
  return `${actual} && arch="$(dpkg --print-architecture)" && case "$arch" in ${cases} *) echo "No pinned Daimon capability receipt for $arch" >&2; exit 1 ;; esac && test "$actual" = "$expected"`;
};

/** Shared install verification and launchers for organization and training images. */
export const createDaimonInstallCommands = (
  installRoot: string,
  capabilityReceipt: string | DaimonCapabilityReceipts
): string[] => [
  createDaimonReceiptCheck(`${installRoot}/capability-receipt.json`, capabilityReceipt),
  `test -f ${installRoot}/contract-manifest.json && test -f ${installRoot}/contract-manifest.sha256 && manifest="$(cat ${installRoot}/contract-manifest.sha256)" && test "$manifest" = ${JSON.stringify(DAIMON_CONTRACT_MANIFEST_SHA256)} && test "$(sha256sum ${installRoot}/contract-manifest.json | awk '{print "sha256:" $1}')" = "$manifest" && node -e 'const fs=require("fs");const r=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));if(r.manifest_sha256!==process.argv[2])process.exit(1)' ${installRoot}/capability-receipt.json "$manifest"`,
  `ln -sf ${installRoot}/bin/daimon-runtime /usr/local/bin/daimon-runtime`,
  `ln -sf ${installRoot}/bin/codex /usr/local/bin/codex`,
  `install -o root -g root -m 0555 ${installRoot}/bin/grok /usr/local/bin/grok && arch="$(dpkg --print-architecture)" && case "$arch" in amd64) expected=${DAIMON_GROK_ENGINE_BROKER.grokCliArtifacts.x64.sha256} ;; arm64) expected=${DAIMON_GROK_ENGINE_BROKER.grokCliArtifacts.arm64.sha256} ;; *) exit 1 ;; esac && test "$(sha256sum /usr/local/bin/grok | awk '{print $1}')" = "$expected"`,
  `ln -sf ${installRoot}/bin/agy /usr/local/bin/agy`,
  `mkdir -p /opt/daimon/bin && install -o root -g root -m 0555 ${installRoot}/bin/daimon-engine-broker /opt/daimon/bin/daimon-engine-broker && arch="$(dpkg --print-architecture)" && case "$arch" in amd64) expected=${DAIMON_GROK_ENGINE_BROKER.artifacts.x64Sha256} ;; arm64) expected=${DAIMON_GROK_ENGINE_BROKER.artifacts.arm64Sha256} ;; *) exit 1 ;; esac && test "$(sha256sum /opt/daimon/bin/daimon-engine-broker | awk '{print $1}')" = "$expected"`
];
