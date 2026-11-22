import { expect, it } from "vitest";

import type { ResolvedAuthProfile } from "../auth/index.js";
import { prepareImageRuntimeAuthMounts } from "./imageRuntimeAuth.js";
import type { DistributionReport, DistributionRuntimeInstance } from "./types.js";

it("refuses to stage a raw import into one image when an unrelated external runtime shares it", async () => {
  const recipient: DistributionRuntimeInstance = {
    id: "assistant", runtime: "openclaw", home_path: "/state/openclaw/home",
    config_path: "/state/openclaw/home/config.json", workspace_path: "/state/openclaw/workspace",
    internal_port: null, published_port: null, node_ids: ["agent:assistant"],
    model_auth_methods: { provider: "codex" }, model_secrets_required: []
  };
  const external: DistributionRuntimeInstance = {
    ...recipient, id: "guest", runtime: "external-harness", home_path: "/state/guest/home",
    workspace_path: "/state/guest/workspace", config_path: "/state/guest/config.json",
    node_ids: ["agent:guest"], model_auth_methods: {}
  };
  const report = { runtime_instances: [recipient, external] } as DistributionReport;
  const authProfile: ResolvedAuthProfile = {
    name: "fixture", authHome: "/auth", profileDirectory: "/auth/fixture", profilePath: "/auth/fixture/profile.json",
    version: 1, env: {}, imports: { codex: { kind: "codex", path: "/auth/fixture/codex" } }
  };
  await expect(prepareImageRuntimeAuthMounts({ report, authProfile, tempRoot: "/unused" }))
    .rejects.toThrow(/external-harness does not request or support the codex import/u);
});

it("keeps the image preparation receiver when invoking a class-based auth hook", async () => {
  class PreparedImage {
    #mountArgs = ["-v", "/fixture/source:/state/auth"];

    securityArgs: string[] = [];

    async prepareAuth() {
      return this.#mountArgs;
    }
  }
  const instance: DistributionRuntimeInstance = {
    id: "fixture", runtime: "external-harness", home_path: null,
    config_path: "/state/config.json", workspace_path: "/workspace",
    internal_port: null, published_port: null, node_ids: ["agent:fixture"],
    model_auth_methods: {}, model_secrets_required: []
  };
  const report = { runtime_instances: [instance] } as DistributionReport;
  await expect(prepareImageRuntimeAuthMounts({
    report, authProfile: null, tempRoot: "/unused",
    runtimePreparations: new Map([[instance.runtime, new PreparedImage()]])
  })).resolves.toMatchObject({ mountArgs: ["-v", "/fixture/source:/state/auth"] });
});
