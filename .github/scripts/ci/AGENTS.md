# Commit policy checker

Owns the dependency-free commit-message.mts checker and adjacent tests.
Reuse the reference message rules; AUTHOR_EMAILS is the explicit author policy.
Node built-ins only in the checker. Tests use disposable Git objects and hooks;
never change the caller's Git identity, history or hooks. No application imports.

Verify with node --test against commit-message.test.mts.
Set TMPDIR inside this worktree. Strict typing is included in npm run typecheck.
