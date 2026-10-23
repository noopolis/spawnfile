/** Frozen pre-rename hash inputs. Never use these as emitted wire IDs or prompts.
 * Bump a domain only for a behavioral/protocol change, never a display rename.
 */
export const EXTRACTION_CHECKPOINT_DOMAIN = 'paideia.extraction.v9';
export const TRAP_CHECKPOINT_DOMAIN = 'paideia.traps.v1';
export const JUDGMENT_CACHE_DOMAIN = 'paideia.judgment-cache.v3';
export const GRADER_CACHE_PROMPT_DOMAIN = 'paideia.grader-prompt.v4';
export const GRADER_CACHE_LEGACY_DIRECTORY = '.paideia';
export const DECOMPOSITION_DIGEST_SCHEMA = 'paideia.decomposition.v1';
export const CHECK_TEMPLATES_DIGEST_SCHEMA = 'paideia.check-templates.v1';
export const EVIDENCE_UNITS_DIGEST_SCHEMA = 'paideia.evidence-units.v1';
