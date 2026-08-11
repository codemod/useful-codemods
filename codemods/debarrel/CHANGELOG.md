# debarrel

## 0.7.13

### Patch Changes

- 2ed134e: Fix cloud runtime crash in project file walking when `readdirSync` entries lack a usable `.name` (avoid `entry.name.startsWith` on undefined).

## 0.7.12

### Patch Changes

- Respect package.json exports boundaries and preserve non-static consumers; handle aliased re-exports, additional export shapes, and test mock updates.

## 0.7.11

### Patch Changes

- Parse JSONC `tsconfig.json` files (comments and trailing commas) so tsconfig path aliases resolve on real-world configs.
- Route semantic-analyzer-resolved rewrites through `buildRewriteFromTarget` so default imports and barrel metrics stay correct.
- Distinguish `export { default } from "./x"` from `export { Foo as default }` when choosing import type.
- Cache workspace source file listings during namespace-importer detection.
- Use `path.relative` instead of a hand-rolled relative path helper.

## 0.7.10

### Patch Changes

- Commit barrel renames when a barrel file has no import edits (fixes `.tsx` barrels being skipped when `edits` is empty).
- Add Sentry-shaped test fixtures for `sentry/stories` and `sentry/icons` namespace barrel preservation.

## 0.7.9

### Patch Changes

- Preserve namespace-imported barrels when tsconfig aliases share the package name (e.g. `sentry/stories` with `sentry/*` paths) by inverse-mapping alias strings and matching import paths directly.
- Scan `.mdx` files for namespace imports when deciding whether to keep a barrel.
- Resolve tsconfig and workspace roots with absolute paths during namespace-importer detection.

## 0.7.8

### Patch Changes

- Resolve barrel symbols using the imported name (`Foo` in `import { Foo as Bar }`), not the local alias, so folder barrels and wildcard aliases debarrel correctly.
- Replace `path.relative` with portable helpers for the JSSG runtime when computing paths from a barrel directory to its exports.
- Normalize barrel paths when detecting namespace importers so barrels are preserved reliably.

## 0.7.7

### Patch Changes

- Fix double `type` keyword in rewritten `import type { … }` statements when specifiers use inline `type` qualifiers.
- Resolve imports against `index.barrel.bak.*` when a barrel has already been renamed in the same pass, so consumers processed later still rewrite correctly.
- Match namespace-importer barrels by directory path, not only exact barrel file path.
- Rewrite relative folder imports (e.g. `../textarea`) to the concrete module when the directory barrel is removed.

## 0.7.6

### Patch Changes

- Fix invalid `import type { type Foo }` output when rewriting top-level `import type` statements. Inline `type` qualifiers are now only emitted for mixed value/type imports split across paths.
- Preserve barrel files that are namespace-imported (`import * as Ns from "…"`), since those imports cannot be debarreled to a single module.

## 0.7.5

### Patch Changes

- Rewrite default imports that flow through `export { Foo as default }` barrel re-exports when the semantic analyzer cannot resolve the binding. Also walk explicit `export { … } from` re-exports before falling back to `export *` chains, and preserve inline `import { type Foo }` specifiers when splitting partial barrel imports.

## 0.7.4

### Patch Changes

- Fix debarreling of tsconfig/webpack subpath aliases whose prefix matches the workspace `package.json` name (e.g. `myapp/widgets` when the package is named `myapp`). Previously the package-boundary guard treated every such import as a root package import and skipped rewriting, leaving consumers pointing at deleted barrel files. Also resolve alias imports when walking `export *` barrels and when semantic analysis resolves through a barrel to the source file.

## 0.7.3

### Patch Changes

- 4d9e3e4: Skip renaming Next.js Pages API route `index` files when they look like pure re-export barrels. Also tighten pure-barrel detection so an `index` file is only treated as a barrel when every export is a `from "..."` re-export.

## 0.7.2

### Patch Changes

- d7aad62: Rewrite consumer imports that flow through bare `export * from "./x"` re-exports. Previously the semantic analyzer couldn't enumerate the wildcard's bindings, so the codemod silently left those imports pointing at the barrel; now the codemod manually walks the barrel's `export *` chain to find the declaring file. Also preserves the top-level `import type` modifier when every specifier in a type-only import is rewritten.

## 0.7.1

### Patch Changes

- 38aa0e7: Fix debarreling codemod's issue with alias imports

## 0.7.0

### Minor Changes

- 7099b68: Multiple workflows in debarreling codemod

## 0.6.1

### Patch Changes

- e3763d1: Fix debarrel selector initialization in the current JSSG runtime.

## 0.6.0

### Minor Changes

- 2e3b105: Add metrics

## 0.5.0

### Minor Changes

- 6590f6f: fix jest mocks in test files after transforming barrel imports

## 0.4.1

### Patch Changes

- b0d6ca0: Update the debarrel skill compatibility marker to `skill-package-v1`.

## 0.4.0

### Minor Changes

- b4eab4e: handle type-qualified specifiers in partial barrel rewrites

## 0.3.3

### Patch Changes

- 3299c10: Fix issue with adding import

## 0.3.2

### Patch Changes

- 284c1d7: Configurable PR size via parameters

## 0.3.1

### Patch Changes

- e1ec376: Add sharding back

## 0.3.0

### Minor Changes

- de914ad: Remove sharding

### Patch Changes

- 4f6d3d7: Add include paths

## 0.2.0

### Minor Changes

- 1f944a0: Add sharding

## 0.1.8

### Patch Changes

- 2c02f64: Add fs capability

## 0.1.7

### Patch Changes

- a058a8a: handle barrel import paths ending with '/index' to ensure correct path resolution

## 0.1.6

### Patch Changes

- 599cb9e: resolve path joining issue in joinImportPaths function and update workflow step formatting

## 0.1.5

### Patch Changes

- efa51f3: prevent rewriting non-relative imports from packages with package.json

## 0.1.4

### Patch Changes

- d1b45c9: remove computeRelativeImportPath function and simplify resolveSpecifier logic

## 0.1.3

### Patch Changes

- c2b06a1: Improve handling of aliased package sources

## 0.1.2

### Patch Changes

- 16be2db: Fix the error due to missing @jssg/utils

## 0.1.1

### Patch Changes

- 5858736: Initial release
