import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createDockerTargetExecutors: vi.fn(),
  createDockerWorldClockReader: vi.fn(),
  initializeWorldServiceAuthorityReader: vi.fn(),
  parseTargetWorldClockRequest: vi.fn(),
  query: vi.fn(),
}));

vi.mock("../target/dockerCommandExecutor.js", () => ({
  createDockerTargetExecutors: mocks.createDockerTargetExecutors,
}));
vi.mock("../target/dockerWorldClock.js", () => ({
  createDockerWorldClockReader: mocks.createDockerWorldClockReader,
}));
vi.mock("../target/dockerWorldServiceStore.js", () => ({
  initializeWorldServiceAuthorityReader: mocks.initializeWorldServiceAuthorityReader,
}));
vi.mock("../target/worldClock.js", () => ({
  parseTargetWorldClockRequest: mocks.parseTargetWorldClockRequest,
}));

import { queryTargetDefaultWorldClock } from "./targetDefaultWorldClock.js";

describe("default world clock query composition", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.parseTargetWorldClockRequest.mockReturnValue({ parsed: true });
    mocks.initializeWorldServiceAuthorityReader.mockResolvedValue({ authority: true });
    mocks.createDockerTargetExecutors.mockReturnValue({
      publicArtifact: { kind: "content" },
      world: { kind: "world" },
    });
    mocks.query.mockResolvedValue({ receipt: true });
    mocks.createDockerWorldClockReader.mockReturnValue({ query: mocks.query });
  });

  it("passes only validated request and configured authorities to the reader", async () => {
    const config = {
      context: "local",
      dockerCommand: "docker",
      paths: { worldAuthority: "/authority/world" },
      timeoutMs: 1_000,
    };
    const request = { request: true };
    await expect(queryTargetDefaultWorldClock(config, request)).resolves.toEqual({ receipt: true });
    expect(mocks.parseTargetWorldClockRequest).toHaveBeenCalledWith(request);
    expect(mocks.initializeWorldServiceAuthorityReader).toHaveBeenCalledWith(
      "/authority/world",
    );
    expect(mocks.createDockerTargetExecutors).toHaveBeenCalledWith({ dockerCommand: "docker" });
    expect(mocks.createDockerWorldClockReader).toHaveBeenCalledWith({
      authorityStore: { authority: true },
      contentExecutor: { kind: "content" },
      context: "local",
      executor: { kind: "world" },
      timeoutMs: 1_000,
    });
    expect(mocks.query).toHaveBeenCalledWith({ parsed: true });
  });

  it("stops before authority initialization when request parsing fails", async () => {
    mocks.parseTargetWorldClockRequest.mockImplementation(() => {
      throw new Error("invalid request");
    });
    await expect(queryTargetDefaultWorldClock({
      context: "local",
      dockerCommand: "docker",
      paths: { worldAuthority: "/authority/world" },
      timeoutMs: 1_000,
    }, null)).rejects.toThrow("invalid request");
    expect(mocks.initializeWorldServiceAuthorityReader).not.toHaveBeenCalled();
  });
});
