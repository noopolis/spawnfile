import path from "node:path";

import { shellQuote } from "../../../compiler/containerEntrypointShell.js";
import {
  RUNTIME_LINK_MATERIALIZER_PATH, renderRuntimeLinkMaterializer
} from "../../../compiler/containerRuntimeLinkMaterializer.js";
import type { RuntimeHostEntrypoint } from "../../hostTypes.js";
import { renderDaimonStateOwnership } from "./stateOwnership.js";
import { DAIMON_RUNTIME_UID, DAIMON_UID_ENTRYPOINT_PATH, renderDaimonUidEntrypoint } from "./uidEntrypointRender.js";

const healthProgram = "const fs=require('node:fs');const c=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));fetch(`http://127.0.0.1:${c.host.port}/healthz`).then(async r=>{if(!r.ok||JSON.stringify(await r.json())!==JSON.stringify({status:'ok'}))process.exit(1)}).catch(()=>process.exit(1))";

export const daimonHostEntrypoint: RuntimeHostEntrypoint = {
  path: DAIMON_UID_ENTRYPOINT_PATH,
  accountUid: DAIMON_RUNTIME_UID,
  prelude: [
    'if [ "$#" -ne 3 ] || [ "$1" != "--spawnfile-runtime-identity" ]; then echo "Missing trusted Daimon runtime identity" >&2; exit 1; fi',
    'volume_bootstrap_uid="$2"',
    'volume_bootstrap_gid="$3"',
    'if ! [[ "$volume_bootstrap_uid" =~ ^[1-9][0-9]{0,9}$ ]] || [ "$volume_bootstrap_uid" -gt 2147483647 ]; then echo "Invalid trusted Daimon runtime UID" >&2; exit 1; fi',
    'if ! [[ "$volume_bootstrap_gid" =~ ^[1-9][0-9]{0,9}$ ]] || [ "$volume_bootstrap_gid" -gt 2147483647 ]; then echo "Invalid trusted Daimon runtime GID" >&2; exit 1; fi',
    "shift 3"
  ],
  rootfsFiles({ runtimePlans, persistentMountPaths, moltnet, persistentMounts }) {
    return [{
      content: renderRuntimeLinkMaterializer(),
      mode: 0o600,
      path: RUNTIME_LINK_MATERIALIZER_PATH.slice(1)
    }, {
      content: renderDaimonUidEntrypoint(runtimePlans, persistentMountPaths, moltnet, persistentMounts),
      mode: 0o755,
      path: DAIMON_UID_ENTRYPOINT_PATH.slice(1)
    }];
  },
  afterRootfsCopy: ["RUN chown root:root /var /var/lib /var/lib/spawnfile && chmod 755 /var /var/lib && chmod 711 /var/lib/spawnfile"],
  afterEntrypointChmod: " && chmod 711 /opt /opt/spawnfile",
  finalizeInstall(plans) {
    return [...new Set(plans.map((plan) => plan.runtimeRoot))].sort().map((runtimeRoot) =>
      `RUN node ${shellQuote(RUNTIME_LINK_MATERIALIZER_PATH)} ${shellQuote(runtimeRoot)} && rm ${shellQuote(RUNTIME_LINK_MATERIALIZER_PATH)} && test -d ${shellQuote(runtimeRoot)} && test ! -L ${shellQuote(runtimeRoot)} && test -z "$(find -P ${shellQuote(runtimeRoot)} \\( -type l -o ! -user root -o ! -group root \\) -print -quit)" && chmod 711 /opt/spawnfile/runtime-installs ${shellQuote(runtimeRoot)} && find -P ${shellQuote(runtimeRoot)} -type d -exec chmod 711 {} + && find -P ${shellQuote(runtimeRoot)} -type f -perm /111 -exec chmod 555 {} + && find -P ${shellQuote(runtimeRoot)} -type f ! -perm /111 -exec chmod 444 {} + && chmod 555 ${shellQuote(path.posix.join(runtimeRoot, "daimon-start.sh"))}`);
  },
  healthcheck(plan) {
    if (!plan.instancePaths.configPath) throw new Error("Daimon container plan is missing its runtime config path");
    return `HEALTHCHECK --interval=5s --timeout=3s --start-period=10s --retries=12 CMD ["node","-e",${JSON.stringify(healthProgram)},${JSON.stringify(plan.instancePaths.configPath)}]`;
  },
  stateOwnership: renderDaimonStateOwnership
};
