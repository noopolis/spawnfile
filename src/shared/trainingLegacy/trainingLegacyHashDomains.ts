/** Frozen pre-rename hash inputs. Never use these as emitted wire IDs. Historical prompt versions stay in model requests.
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

export const LEGACY_DEFAULT_JUDGE_VERSION = 'cli.claude-subscription.v1';
export const LEGACY_INFERENCE_VERSION_PREFIX = 'paideia.legacy-inference:';
export const AUTHORED_JUDGE_VERSION_PREFIX = 'paideia.authored-judge.v1:sha256:';
export const OPTIMIZER_ROUTE_PREFIX = 'paideia.optimizer:';
export const INFERENCE_POLICY_VERSIONS = Object.freeze({
  'grok-subscription': 'paideia.grok-attested-response.v3',
  'grok-broker': 'paideia.grok-broker-grant-response.v1',
  'claude-subscription': 'paideia.claude-attested-response.v3',
  'codex-subscription': 'paideia.codex-contained-response.v1',
  ollama: 'paideia.ollama-attested-response.v2',
});
export const LABEL_PROMPT_VERSION = 'paideia.grader-label-prompt.v1';
export const ADJUDICATION_SEED = 'paideia.adjudication.v1';
export const COUNCIL_PROMPT_VERSION = 'paideia.council.v7';
export const COUNCIL_SEED = 'paideia.council';
export const GRADING_POLICY_VERSION = 'paideia.grading.v1';
export const CANDIDATE_DIGEST_SCHEMA = 'paideia.candidate.v1';
export const DATASET_DIGEST_SCHEMA = 'paideia.dataset.v1';
export const LABELS_DIGEST_SCHEMA = 'paideia.labels.v1';
export const CALIBRATION_DIGEST_SCHEMA = 'paideia.grader-calibration.v1';
export const COMMAND_EXECUTION_DOMAIN = 'paideia.command-execution.v1';
export const COMPARISON_CHECKPOINT_DOMAIN = 'paideia.comparison-checkpoint.v1';
// Canary keys and text affect the observed decision incorporated into the fingerprint.
export const JEV_IDENTITY_KEY = 'paideia_identity';
export const JEV_IDENTITY_LONG_KEY = 'paideia_identity_long';
export const JEV_CANARY_MARKER = 'PAIDEIA_CANARY_END';
export const JEV_CANARY_QUESTION = 'Does the supplied text end with PAIDEIA_CANARY_END?';

/** Frozen repair compatibility discriminator; retained for existing signed receipts. */
export const LEGACY_MEASUREMENT_COMPATIBILITY_VERSION = 'spawnfile.daimon-dspy-compatibility.v1';
