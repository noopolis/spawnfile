import { Readable } from "node:stream";

import { describe, expect, it } from "vitest";

import { createSecretMaskStream, maskSecrets, SECRET_MASK_WINDOW_BYTES } from "./secretMask.js";

const SECRET = "control-token-0123456789abcdef";
const JWT = `eyJ${"a".repeat(20)}.${"b".repeat(30)}.${"c".repeat(20)}`;

const through = async (chunks: readonly Buffer[], secrets: readonly string[] = []): Promise<Buffer> => {
  const out: Buffer[] = [];
  for await (const chunk of Readable.from(chunks).pipe(createSecretMaskStream(secrets))) out.push(chunk as Buffer);
  return Buffer.concat(out);
};

describe("maskSecrets", () => {
  it("masks known values and credential shapes without changing the length", () => {
    const text = `key=${SECRET} Authorization: Bearer abcdefghijklmnop sk-${"x".repeat(24)} ${JWT} ya29.${"y".repeat(30)} plain words stay`;
    const masked = maskSecrets(text, [SECRET]);
    expect(masked).toHaveLength(text.length);
    for (const leaked of [SECRET, "abcdefghijklmnop", "x".repeat(24), "b".repeat(30), "y".repeat(30)]) expect(masked).not.toContain(leaked);
    expect(masked).toContain("Bearer ****");
    expect(masked).toContain("plain words stay");
  });

  it("leaves ordinary diagnostics alone, including short values", () => {
    const text = "tokens=788000 input_tokens: 12 engine_failed: CLI engine timed out after 2700000ms";
    expect(maskSecrets(text, ["abc"])).toBe(text);
  });
});

describe("createSecretMaskStream", () => {
  it("masks a secret split across writes and keeps every other byte", async () => {
    const line = `daimon: env ${SECRET} and ${JWT}\nnext line\n`;
    const bytes = Buffer.from(line, "latin1");
    for (const at of [1, 15, 20, 30, 60, bytes.length - 3]) {
      const masked = (await through([bytes.subarray(0, at), bytes.subarray(at)], [SECRET])).toString("latin1");
      expect(masked).toBe(maskSecrets(line, [SECRET]));
      expect(masked).not.toContain(SECRET);
    }
  });

  it("passes binary bytes through one to one and bounds what it holds", async () => {
    const binary = Buffer.alloc(3 * SECRET_MASK_WINDOW_BYTES);
    for (let index = 0; index < binary.length; index++) binary[index] = index % 251 === 10 ? 11 : index % 251;
    const chunks = [binary.subarray(0, 1000), binary.subarray(1000, 150_000), binary.subarray(150_000)];
    const masked = await through(chunks);
    expect(masked.equals(Buffer.from(maskSecrets(binary.toString("latin1")), "latin1"))).toBe(true);
    expect(masked).toHaveLength(binary.length);
  });

  it("masks a secret inside a long stretch with no line end", async () => {
    const stretch = Buffer.from(`${"\u0001".repeat(SECRET_MASK_WINDOW_BYTES)}${SECRET}${"\u0002".repeat(SECRET_MASK_WINDOW_BYTES)}`, "latin1");
    const chunks = [stretch.subarray(0, SECRET_MASK_WINDOW_BYTES + 5), stretch.subarray(SECRET_MASK_WINDOW_BYTES + 5)];
    const masked = (await through(chunks, [SECRET])).toString("latin1");
    expect(masked).toHaveLength(stretch.length);
    expect(masked).not.toContain(SECRET);
  });
});
