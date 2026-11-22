import { nativeLoginCapability, type NativeLoginFlow } from "../nativeLogin.js";
import { hermesAuthValidatorSource } from "./authStore.js";
import { hermesBinary } from "./install.js";

function flow(provider: string, native: string): NativeLoginFlow {
  return {
    provider, command: [hermesBinary, "auth", "add", native, "--type", "oauth", "--no-browser"],
    credentialFile: ".hermes/auth.json",
    persistLockFile: "auth.lock",
    hasLogin: `${hermesAuthValidatorSource}(store, ${JSON.stringify(native)})`
  };
}

export const portalRoutes = new Map([
  ["nous", { native: "nous", transport: "chat_completions" }],
  ["minimax", { native: "minimax-oauth", transport: "anthropic_messages" }]
]);

export const hermesLogin = nativeLoginCapability("hermes-agent", {
  chatgpt: flow("openai", "openai-codex"),
  supergrok: flow("xai", "xai-oauth"),
  ...Object.fromEntries([...portalRoutes].map(([provider, route]) => [provider, flow(provider, route.native)]))
});
