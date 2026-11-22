import { expect, it } from "vitest";
import { createMoltnetDaimonReceiptStorePath } from "./wiring.js";

it("renders only collision-free absolute Daimon receipt-store paths", () => {
  const stateDirectory = "/var/lib/spawnfile/moltnet/networks/local";
  expect(createMoltnetDaimonReceiptStorePath("local", "relay-agent", stateDirectory))
    .toBe("/var/lib/spawnfile/moltnet/networks/local/daimon-receipts/relay-agent.json");
  expect(() => createMoltnetDaimonReceiptStorePath("local", "../relay-agent", stateDirectory))
    .toThrow("invalid Daimon receipt-store path segment");
  expect(() => createMoltnetDaimonReceiptStorePath("local net", "relay-agent", stateDirectory))
    .toThrow("invalid Daimon receipt-store path segment");
});
