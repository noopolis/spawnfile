# Native experiment services

`slot-freshness.ts` owns durable, locked replay protection for broker subject slots; `freshness.ts` places it in the experiment state directory. Composition creates one store and hands the same capability to preparation and execution. Preserve the existing filename, schema and generation floors across resumes.

`account-lease.ts` serializes complete Codex hosts on one persistent account. Its private SQLite inode is retained across trials; kernel ownership survives waiter cancellation and ends on confirmed native cleanup or process death. Wait outside trial deadlines. Unknown cleanup holds a strongly reachable fence until the container exits.
