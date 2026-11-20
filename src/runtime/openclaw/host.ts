import type { RuntimeHostIntegration } from "../hostTypes.js";

export const openClawHostIntegration: RuntimeHostIntegration = {
  generatedSecrets: {
    OPENCLAW_GATEWAY_TOKEN: { bytes: 24, encoding: "hex", generateForImage: true },
    OPENCLAW_HOOKS_TOKEN: { bytes: 24, encoding: "hex", generateForImage: true }
  },
  environmentPrelude: [
    'if [ -n "${OPENCLAW_GATEWAY_TOKEN:-}" ] && [ -z "${OPENCLAW_HOOKS_TOKEN:-}" ]; then',
    '  export OPENCLAW_HOOKS_TOKEN="hooks-${OPENCLAW_GATEWAY_TOKEN}"',
    "fi",
    ""
  ]
};
