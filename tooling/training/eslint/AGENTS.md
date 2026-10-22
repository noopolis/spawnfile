# Structural ESLint rules

Owns line targets, directory budgets and module import boundaries. Public seam:
index.ts exports the local plugin. Rules may read repository metadata, never
change files. Paths are rooted in ESLint's explicit cwd, including fixture tests.

- Check all managed implementation directories, including data-only descendants,
  so moving a file deeper cannot evade its guide or directory budget.
- Imports cross public indexes; contracts are explicit shared public type files.
- Negative tests use ESLint itself and real temporary file/symlink structures.
- Check 90% per-file coverage with npx vitest run tooling --coverage.
- Only root `.tmp/` is excluded for generated test/tool caches; nested `.tmp/`
  and other hidden implementation folders remain checked.
