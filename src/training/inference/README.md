# Subscription inference

`createClaudeInference()` supplies tool-free saved-subscription generations for
judges and optimizer proposals. It verifies the native CLI's empty tool list,
rejects missing/unsuccessful terminal output, and reports measured usage or unknown
counters. Temperature and seed are unsupported; no API/model fallback is selected.

Claude safe/restricted mode disables ordinary user/project instructions, skills,
hooks and settings. **Admin-managed policy still applies** under the native CLI's
documented contract. An experiment must treat that host policy as part of its
inference environment; Paideia does not claim to override or inspect managed policy.

Authentication stays in the saved native subscription mechanism. Raw auth-status
account details are discarded, and API/provider environment overrides are removed.
Generation runs in a fresh disposable directory with no subject workspace mounted.
