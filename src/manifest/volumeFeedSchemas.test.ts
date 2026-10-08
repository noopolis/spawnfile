import { describe, expect, it } from "vitest";

import { isFeedTimeZone, volumeFeedSchema } from "./volumeFeedSchemas.js";

const IMAGE = `node:22-bookworm-slim@sha256:${"a".repeat(64)}`;
const issues = (feed: Record<string, unknown>): string[] => {
  const result = volumeFeedSchema.safeParse(feed);
  return result.success ? [] : result.error.issues.map((issue) => issue.message);
};
const git = (ref: unknown): Record<string, unknown> => ({ git: { ref, repo: "../repo" } });

describe("volume feed prepare, include, moving refs and freeze", () => {
  it("accepts the full shape", () => {
    expect(issues({
      freeze: { after: "12:00", timezone: "Europe/Berlin" },
      git: { fetch: true, ref: { fallback: "origin/main", template: "origin/data/${date:Europe/Berlin}" }, repo: "../repo" },
      include: [{ from: "../fonts", to: "assets/fonts" }],
      prepare: { command: ["npm", "ci", "--omit=dev"], image: IMAGE, network: true, platform: "linux/arm64", timeout_seconds: 600 }
    })).toEqual([]);
    expect(issues({ ...git({ command: ["node", "pick-ref.mjs"] }), prepare: { command: ["cp", "-r", "x", "y"], host: true } })).toEqual([]);
    expect(issues(git("origin/main"))).toEqual([]);
    expect(issues(git({ template: "data/${date}" }))).toEqual([]);
  });

  it("requires a pinned image or an explicit host prepare, never both", () => {
    expect(issues({ directory: "a", prepare: { command: ["npm", "ci"] } })).toContain("volume feed prepare must declare exactly one of image (digest-pinned) or host: true");
    expect(issues({ directory: "a", prepare: { command: ["npm", "ci"], host: true, image: IMAGE } })).toContain("volume feed prepare must declare exactly one of image (digest-pinned) or host: true");
    expect(issues({ directory: "a", prepare: { command: ["npm", "ci"], image: "node:22" } })).toContain("image must be a reference pinned by @sha256 digest");
    expect(issues({ directory: "a", prepare: { command: ["x"], host: true, platform: "linux/amd64" } })).toContain("volume feed prepare platform and network apply only to an image");
    expect(issues({ directory: "a", prepare: { command: ["x"], host: false } }).length).toBeGreaterThan(0);
    expect(issues({ directory: "a", prepare: { command: [], host: true } }).length).toBeGreaterThan(0);
  });

  it("refuses ref rules that are ambiguous or use unknown placeholders", () => {
    expect(issues(git({ fallback: "main" }))).toContain("a volume feed ref rule must declare exactly one of template or command");
    expect(issues(git({ command: ["x"], template: "a" }))).toContain("a volume feed ref rule must declare exactly one of template or command");
    expect(issues(git({ template: "data/${branch}" }))).toContain("volume feed ref templates know only ${date} and ${date:<time zone>}");
    expect(issues(git({ template: "data/${date:Mars/Olympus}" }))).toContain('volume feed ref template time zone "Mars/Olympus" is not an IANA time zone');
    expect(issues(git({ template: "a", extra: 1 })).length).toBeGreaterThan(0);
  });

  it("validates the freeze clock and zone, and include targets", () => {
    expect(issues({ directory: "a", freeze: { after: "24:00", timezone: "UTC" } })).toContain("freeze.after must be HH:MM (24-hour)");
    expect(issues({ directory: "a", freeze: { after: "9:00", timezone: "UTC" } })).toContain("freeze.after must be HH:MM (24-hour)");
    expect(issues({ directory: "a", freeze: { after: "09:00", timezone: "Nowhere" } })).toContain("freeze.timezone must be an IANA time zone");
    expect(issues({ directory: "a", include: [{ from: "f", to: "../x" }] })).toContain("volume feed include target ../x must be a plain tree-relative path");
    expect(issues({ directory: "a", include: [{ from: "f", to: "/x" }] })).toContain("volume feed include target /x must be a plain tree-relative path");
    expect(issues({ directory: "a", include: [{ from: "f", to: "assets" }, { from: "g", to: "assets/fonts" }] })).toContain("volume feed include target assets overlaps another include");
    expect(issues({ directory: "a", include: [] }).length).toBeGreaterThan(0);
    expect(isFeedTimeZone("Europe/Berlin")).toBe(true);
    expect(isFeedTimeZone(" ")).toBe(false);
  });
});
