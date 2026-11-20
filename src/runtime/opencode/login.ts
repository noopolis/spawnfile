import { nativeLoginCapability, type NativeLoginFlow } from "../nativeLogin.js";
import { opencodeBinary } from "./launch.js";
import { usableOpenCodeLogin } from "./storeFormat.js";

function flow(provider: string, method: string): NativeLoginFlow {
  return {
    provider, command: [opencodeBinary, "providers", "login", "--provider", provider, "--method", method],
    credentialFile: ".local/share/opencode/auth.json",
    hasLogin: usableOpenCodeLogin(provider)
  };
}

export const openCodeLogin = nativeLoginCapability("opencode", {
  chatgpt: flow("openai", "ChatGPT Pro/Plus (headless)"),
  supergrok: flow("xai", "SuperGrok Subscription"),
  copilot: flow("github-copilot", "Login with GitHub Copilot")
});
