import { lstat, readFile, realpath } from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";
import { slotFixture } from "./fixtures.test-helper.js";
import { prepareTrainingSessionSlot } from "./slot.js";

vi.mock("node:fs/promises", () => ({ lstat: vi.fn(), readFile: vi.fn(), realpath: vi.fn() }));
afterEach(() => vi.resetAllMocks());
const fixture = () => {
  const f = slotFixture();
  vi.mocked(lstat).mockResolvedValue({ isFile: () => true, isSymbolicLink: () => false, size: 1000, mode: 0o640 } as never);
  vi.mocked(realpath).mockImplementation(async path => String(path));
  vi.mocked(readFile).mockImplementation(async file => JSON.stringify(await f.dependencies.read(String(file))));
  const { read: _read, ...dependencies } = f.dependencies;
  return { ...f, dependencies };
};
it("reads bounded protected metadata and refuses writable, aliased and malformed control receipts", async () => {
  const f = fixture();
  await expect(prepareTrainingSessionSlot(f.options, f.dependencies)).resolves.toMatchObject({ generation: 2 });
  for (const metadata of [{ mode: 0o666 }, { size: 65_537 }, { isSymbolicLink: () => true }, { isFile: () => false }]) {
    vi.mocked(lstat).mockResolvedValueOnce({ isFile: () => true, isSymbolicLink: () => false, size: 1000, mode: 0o640, ...metadata } as never);
    await expect(prepareTrainingSessionSlot(f.options, f.dependencies)).rejects.toThrow("bounded canonical");
  }
  vi.mocked(realpath).mockResolvedValueOnce("/alias");
  await expect(prepareTrainingSessionSlot(f.options, f.dependencies)).rejects.toThrow("bounded canonical");
  vi.mocked(readFile).mockResolvedValueOnce("not-json");
  await expect(prepareTrainingSessionSlot(f.options, f.dependencies)).rejects.toThrow();
});
it("allocates a nonce when the caller supplies no persisted freshness request", async () => {
  const f = fixture();
  f.dependencies.recycle.mockImplementationOnce(async (index: number, nonce: string) => {
    f.receipt.nonce = nonce;
    return { ok: true, verb: "recycle", slot: index, generation: 2, nonce, receipt: f.p.preflightReceipt, durationMs: 1 };
  });
  const result = await prepareTrainingSessionSlot({ ...f.options, expectedNonce: undefined, minGeneration: undefined }, f.dependencies);
  expect(result.nonce).toMatch(/^[a-f0-9]{64}$/u);
  expect(result.broker.minGeneration).toBe(1);
});
