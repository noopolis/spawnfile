// Moving refs and the freeze: which git ref a refresh lands, decided per refresh from the host's clock,
// the declared rule and the host's own record -- never from anything inside the volume.
//
// WHY A PERIOD AND A REF NAME, NOT A COUNT OF ANYTHING. A freeze exists so readers who already started
// on this period's content are not moved mid-work. Whether they started cannot be read from the volume
// (agents can write and delete there, so any marker could freeze a period nobody used or thaw one they
// did). The host answers it from two things it owns: the period (local date in the freeze time zone) it
// stamped on the serving revision when it landed, and its clock. A spurious freeze keeps the period on
// content it already had; a spurious thaw moves content under readers. Both rules err toward the freeze.
//
// WHY A MISSING REF IS A WAIT BEFORE THE CUTOFF. A dated ref does not exist until its producer cuts it,
// so at period start "no such ref" is the normal state, not a failure; a timer that exits non-zero for
// it every poll trains people to ignore the alarm. Until the freeze cutoff it is a clean wait; after it
// (or with no freeze) it is a refusal.

import { spawnSync } from "node:child_process";

import { FEED_REF_PLACEHOLDER } from "../manifest/index.js";

import { feedError } from "./feedLayout.js";
import type { FeedLandedRecord } from "./feedRecord.js";
import type { FeedExec } from "./feedSource.js";
import type { FeedTarget } from "./feedTarget.js";

const dateFormats = new Map<string, Intl.DateTimeFormat>();
const clockFormats = new Map<string, Intl.DateTimeFormat>();
const memo = (cache: Map<string, Intl.DateTimeFormat>, zone: string, make: () => Intl.DateTimeFormat): Intl.DateTimeFormat => {
  if (!cache.has(zone)) cache.set(zone, make());
  return cache.get(zone) as Intl.DateTimeFormat;
};

/** YYYY-MM-DD in `zone` at `now`. */
export const feedLocalDate = (now: Date, zone: string): string =>
  memo(dateFormats, zone, () => new Intl.DateTimeFormat("en-CA", { day: "2-digit", month: "2-digit", timeZone: zone, year: "numeric" })).format(now);

/** HH:MM (24-hour, zero-padded, so a string compare orders it) in `zone` at `now`. */
export const feedLocalClock = (now: Date, zone: string): string =>
  memo(clockFormats, zone, () => new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hourCycle: "h23", minute: "2-digit", timeZone: zone })).format(now);

export const expandFeedRefTemplate = (template: string, now: Date): string =>
  template.replace(FEED_REF_PLACEHOLDER, (_match, zone: string | undefined) => feedLocalDate(now, zone ?? "UTC"));

/** The period a landing at `now` belongs to; only a feed that declares a freeze has periods. */
export const feedPeriod = (target: FeedTarget, now: Date): string | undefined =>
  target.freeze ? feedLocalDate(now, target.freeze.timezone) : undefined;

const pastCutoff = (target: FeedTarget, now: Date): boolean =>
  target.freeze !== undefined && feedLocalClock(now, target.freeze.timezone) >= target.freeze.after;

const runRefCommand = (target: FeedTarget, command: NonNullable<NonNullable<FeedTarget["refRule"]>["command"]>, repo: string): string | null => {
  const [file, ...args] = command.argv;
  const result = spawnSync(file as string, args, {
    cwd: command.cwd, encoding: "utf8",
    env: { ...process.env, SPAWNFILE_FEED_REPO: repo, SPAWNFILE_FEED_RESOURCE: target.resourceId },
    maxBuffer: 1024 * 1024, stdio: ["ignore", "pipe", "pipe"], timeout: command.timeoutMs
  });
  if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT") throw feedError(`the feed ref command for ${target.resourceId} did not finish within ${Math.round(command.timeoutMs / 1000)}s`);
  if (result.error) throw feedError(`the feed ref command for ${target.resourceId} could not run: ${result.error.message}`);
  if (result.status !== 0) throw feedError(`the feed ref command for ${target.resourceId} failed (${result.signal ? `killed by ${result.signal}` : `exit ${result.status}`}): ${String(result.stderr).trim().slice(-300)}`);
  return String(result.stdout).split("\n").map((line) => line.trim()).find((line) => line !== "") ?? null;
};

const refExists = (exec: FeedExec, repo: string, ref: string): boolean => {
  try { exec("git", ["-C", repo, "rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`]); return true; } catch { return false; }
};

export type FeedRefChoice = { kind: "ref"; ref: string } | { kind: "waiting"; reason: string };

/**
 * The ref this refresh lands: the fixed ref, or the rule's ref when it exists, else its fallback. A rule
 * whose ref and fallback are both missing is a wait before the freeze cutoff and a refusal after it.
 */
export const chooseFeedRef = (target: FeedTarget, { exec, now }: { exec: FeedExec; now: Date }): FeedRefChoice => {
  const source = target.source, rule = target.refRule;
  if (source.kind !== "git") return { kind: "ref", ref: "" };
  if (!rule) return { kind: "ref", ref: source.ref };
  const primary = rule.template !== undefined ? expandFeedRefTemplate(rule.template, now) : runRefCommand(target, rule.command!, source.repo);
  for (const candidate of [primary, rule.fallback]) {
    if (candidate && refExists(exec, source.repo, candidate)) return { kind: "ref", ref: candidate };
  }
  const wanted = `${primary ? JSON.stringify(primary) : "the ref command printed no ref"}${rule.fallback ? ` (fallback ${JSON.stringify(rule.fallback)} is missing too)` : ""}`;
  if (target.freeze && !pastCutoff(target, now)) {
    return { kind: "waiting", reason: `waiting for ${wanted} in ${source.repo}: it is ${feedLocalClock(now, target.freeze.timezone)} ${target.freeze.timezone} and it is due by ${target.freeze.after}` };
  }
  throw feedError(`no ref to land for ${target.resourceId}: ${wanted} does not exist in ${source.repo}${target.freeze ? ` and the ${target.freeze.after} ${target.freeze.timezone} cutoff has passed` : ""}`);
};

/**
 * Frozen: the host landed the serving revision in THIS period, the period's cutoff has passed, and the ref
 * chosen now is the ref it was landed from. A new period, or a different ref name (the next period's ref
 * appearing), advances again.
 */
export const feedFrozen = (target: FeedTarget, record: FeedLandedRecord | null, ref: string, now: Date): boolean => {
  if (!target.freeze || !record?.period || !pastCutoff(target, now)) return false;
  if (record.period !== feedLocalDate(now, target.freeze.timezone)) return false;
  const landed = record.identity.source;
  return landed.kind !== "git" || target.source.kind !== "git" || landed.ref === ref;
};
