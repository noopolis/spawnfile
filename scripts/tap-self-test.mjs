import { readdirSync } from "node:fs";
import path from "node:path";

const passingTitles = (text) => new Set(
  [...text.matchAll(/^ok \d+ - (.+?)\s*$/gmu)].map((match) => match[1]),
);

const isExcluded = (relative, entry, exclude) => {
  if (!exclude) return false;
  if (typeof exclude === "function") return exclude(relative, entry);
  const excluded = new Set(Array.isArray(exclude) ? exclude : [exclude]);
  return excluded.has(relative) || excluded.has(entry.name);
};

export const parseTapSummary = (output) => {
  const text = String(output ?? "");
  const numbers = (pattern) => [...text.matchAll(pattern)].map((match) => Number(match[1]));
  const plans = numbers(/^1\.\.(\d+)\s*$/gmu);
  const passes = numbers(/^# pass (\d+)\s*$/gmu);
  const failures = numbers(/^# fail (\d+)\s*$/gmu);
  if (plans.length === 0 || passes.length === 0 || failures.length === 0) {
    throw new Error("TAP summary is absent or unparseable");
  }
  const lines = text.split(/\r?\n/u);
  for (let index = 0; index < lines.length - 1; index += 1) {
    const subtest = lines[index].match(/^# Subtest: (.+\.test\.mjs)\s*$/u);
    const next = lines[index + 1].match(/^ok \d+ - (.+?)\s*$/u);
    if (subtest && next?.[1] === subtest[1]) {
      throw new Error("TAP test file registered zero tests: " + subtest[1]);
    }
  }
  if (plans.includes(0)) throw new Error("TAP plan ran zero tests");
  const passed = passes.at(-1);
  const failed = failures.at(-1);
  if (passed < 1) throw new Error("TAP summary reported zero passed tests");
  if (failed > 0) throw new Error(`TAP summary reported ${failed} failed`);
  return { passed };
};

export const discoverTestFiles = (directory, { exclude } = {}) => {
  const root = path.resolve(directory);
  const files = [];
  const visit = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      const relative = path.relative(root, full);
      if (entry.isDirectory()) visit(full);
      else if (entry.name.endsWith(".test.mjs") && !isExcluded(relative, entry, exclude)) files.push(relative);
    }
  };
  visit(root);
  return files.sort();
};

export const assertExpectedCases = (output, { minimumCases, requiredCaseNames }) => {
  const text = String(output ?? "");
  const passes = [...text.matchAll(/^# pass (\d+)\s*$/gmu)].map((match) => Number(match[1]));
  const passed = passes.at(-1) ?? 0;
  const titles = passingTitles(text);
  const missing = requiredCaseNames.find((title) => !titles.has(title));
  if (passed < minimumCases) throw new Error(`expected at least ${minimumCases} passing self-test cases, found ${passed}${missing ? `; required self-test case missing or not passing: ${missing}` : ""}`);
  for (const title of requiredCaseNames) {
    if (!titles.has(title)) throw new Error("required self-test case missing or not passing: " + title);
  }
};
