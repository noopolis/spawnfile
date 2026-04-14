import { describe, expect, it } from "vitest";

import {
  buildOpenClawMoltnetConfig,
  buildOpenClawMoltnetEnvBindings,
  validateOpenClawMoltnetRuntimeOptions
} from "./moltnet.js";

describe("openclaw moltnet runtime options", () => {
  it("returns no config or env bindings when moltnet options are omitted", () => {
    expect(validateOpenClawMoltnetRuntimeOptions({})).toEqual([]);
    expect(buildOpenClawMoltnetConfig({})).toBeUndefined();
    expect(buildOpenClawMoltnetEnvBindings({})).toBeUndefined();
  });

  it("builds compact config and token env bindings for valid options", () => {
    const options = {
      moltnet: {
        base_url: "http://127.0.0.1:8787/",
        enabled: true,
        network_id: "local",
        timeout_ms: 2500,
        token_secret: "MOLTNET_TOKEN"
      }
    };

    expect(validateOpenClawMoltnetRuntimeOptions(options)).toEqual([]);
    expect(buildOpenClawMoltnetConfig(options)).toEqual({
      baseUrl: "http://127.0.0.1:8787",
      enabled: true,
      networkId: "local",
      timeoutMs: 2500
    });
    expect(buildOpenClawMoltnetEnvBindings(options)).toEqual([
      {
        envName: "MOLTNET_TOKEN",
        jsonPath: "moltnet.token"
      }
    ]);
  });

  it("validates malformed option shapes and field values", () => {
    expect(validateOpenClawMoltnetRuntimeOptions({ moltnet: true })).toContain(
      "OpenClaw runtime option moltnet must be an object with enabled/base_url/network_id/timeout_ms/token/token_secret"
    );

    expect(
      validateOpenClawMoltnetRuntimeOptions({
        moltnet: {
          base_url: "ftp://example.test",
          enabled: "yes",
          network_id: "",
          timeout_ms: 0,
          token: "",
          token_secret: "",
          unknown: true
        }
      })
    ).toEqual(
      expect.arrayContaining([
        "OpenClaw runtime option moltnet.unknown is unsupported",
        "OpenClaw runtime option moltnet.enabled must be a boolean",
        "OpenClaw runtime option moltnet.base_url must use http or https",
        "OpenClaw runtime option moltnet.network_id must be a non-empty string",
        "OpenClaw runtime option moltnet.timeout_ms must be a positive integer",
        "OpenClaw runtime option moltnet.token must be a non-empty string",
        "OpenClaw runtime option moltnet.token_secret must be a non-empty string"
      ])
    );

    expect(
      validateOpenClawMoltnetRuntimeOptions({
        moltnet: {
          base_url: "not a url"
        }
      })
    ).toContain("OpenClaw runtime option moltnet.base_url must be a valid URL");
  });

  it("validates required base URLs and mutually exclusive token options", () => {
    expect(
      validateOpenClawMoltnetRuntimeOptions({
        moltnet: {
          enabled: true
        }
      })
    ).toContain("OpenClaw runtime option moltnet.base_url is required when moltnet.enabled=true");

    expect(
      validateOpenClawMoltnetRuntimeOptions({
        moltnet: {
          token: "inline",
          token_secret: "MOLTNET_TOKEN"
        }
      })
    ).toContain("OpenClaw runtime option moltnet must not declare both token and token_secret");
  });
});
