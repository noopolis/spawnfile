import { describe, expect, it } from "vitest";

import { applyExecutionDefaults } from "./executionDefaults.js";

describe("applyExecutionDefaults", () => {
  it("applies workspace and sandbox defaults when execution is omitted", () => {
    expect(applyExecutionDefaults(undefined)).toEqual({
      model: undefined,
      sandbox: {
        mode: "workspace"
      },
      workspace: {
        isolation: "isolated"
      }
    });
  });

  it("preserves declared execution values", () => {
    expect(
      applyExecutionDefaults({
        model: {
          primary: {
            name: "gpt-5.4",
            provider: "openai"
          }
        },
        sandbox: {
          mode: "sandboxed"
        }
      })
    ).toEqual({
      model: {
        primary: {
          name: "gpt-5.4",
          provider: "openai"
        }
      },
      sandbox: {
        mode: "sandboxed"
      },
      workspace: {
        isolation: "isolated"
      }
    });
  });
});
