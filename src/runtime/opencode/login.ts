import { nativeLoginCapability, type NativeLoginFlow } from "../nativeLogin.js";
import { opencodeBinary } from "./launch.js";

function flow(provider: string, method: string): NativeLoginFlow {
  return {
    provider, command: [opencodeBinary, "providers", "login", "--provider", provider, "--method", method],
    credentialFile: ".local/share/opencode/auth.json",
    hasLogin: `Object.keys(store).length === 1 && store[${JSON.stringify(provider)}]?.type === "oauth" && store[${JSON.stringify(provider)}].refresh`
  };
}

export const openCodeLogin = nativeLoginCapability("opencode", {
  chatgpt: flow("openai", "ChatGPT Pro/Plus (headless)"),
  supergrok: flow("xai", "SuperGrok Subscription"),
  copilot: flow("github-copilot", "Login with GitHub Copilot")
});
