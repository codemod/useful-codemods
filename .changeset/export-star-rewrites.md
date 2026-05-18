---
"debarrel": patch
---

Rewrite consumer imports that flow through bare `export * from "./x"` re-exports. Previously the semantic analyzer couldn't enumerate the wildcard's bindings, so the codemod silently left those imports pointing at the barrel; now the codemod manually walks the barrel's `export *` chain to find the declaring file. Also preserves the top-level `import type` modifier when every specifier in a type-only import is rewritten.
