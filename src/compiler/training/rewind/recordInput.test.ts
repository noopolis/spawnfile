import { describe, expect, it } from "vitest";
import { emptyRecord } from "./fixtures.test-helper.js";
import { recordInputErrors } from "./recordInput.js";
import type { InputIdentity } from "./types.js";

const memory: InputIdentity = { section: "memory", id: "self", declaredBy: "agent:a" };
const otherBank: InputIdentity = { ...memory, declaredBy: "team:publication" };
const feed: InputIdentity = { section: "resources", id: "news", declaredBy: "team:publication" };
const network: InputIdentity = { ...feed, section: "networks" };

describe("record input error attribution", () => {
  it.each([
    ["memory agent:a/self: capture failed", memory, otherBank],
    ["memory self (agent:a): capture failed", memory, otherBank],
    ["memory self declaredBy=agent:a: capture failed", memory, otherBank],
    ["memory/agent%3Aa/self: capture failed", memory, otherBank],
    ["feed news: capture failed", feed, network],
    ["moltnet news: capture failed", network, feed]
  ] as const)("honors qualified input identity in %s", (error, affected, healthy) => {
    const record = emptyRecord(); record.exact = false; record.errors = [error];
    expect(recordInputErrors(record, affected)).toEqual([error]);
    expect(recordInputErrors(record, healthy)).toEqual([]);
  });

  it("keeps unqualified errors conservative while respecting complete ID tokens", () => {
    const record = emptyRecord(); record.errors = ["self: capture failed", "other-self: failed", "myself: failed"];
    expect(recordInputErrors(record, memory)).toEqual([record.errors[0]]);
    expect(recordInputErrors(record, otherBank)).toEqual([record.errors[0]]);
  });
});
