import { nativeLoginCapability, type NativeLoginFlow } from "../nativeLogin.js";
import { hermesBinary } from "./install.js";

function flow(provider: string, native: string): NativeLoginFlow {
  const id = JSON.stringify(native);
  return {
    provider, command: [hermesBinary, "auth", "add", native, "--type", "oauth", "--no-browser"],
    credentialFile: ".hermes/auth.json",
    hasLogin: `store.version === 1 && (store.providers?.[${id}]?.refresh_token || store.providers?.[${id}]?.tokens?.refresh_token || store.credential_pool?.[${id}]?.some(entry => entry.auth_type === "oauth" && entry.refresh_token))`
  };
}

export const hermesLogin = nativeLoginCapability("hermes-agent", {
  chatgpt: flow("openai", "openai-codex"),
  supergrok: flow("xai", "xai-oauth"),
  nous: flow("nous", "nous")
});
