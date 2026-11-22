import { openJudgmentCacheStore, type JudgmentCacheStore } from "../../../../compiler/training/trial/cache/index.js";

import { JUDGE_INSTRUCTIONS } from "./judge.js";

export const openDaimonJudgmentCacheStore = (root: string, reuse = true): JudgmentCacheStore =>
  openJudgmentCacheStore(root, JUDGE_INSTRUCTIONS, reuse);
