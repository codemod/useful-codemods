# debarrel

Removes barrel files (index re-export files) from JavaScript and TypeScript codebases, rewriting imports to point directly at the source modules.

## Before / After

```ts
// Before — importing through a barrel
import { Button } from "./components";

// After — importing directly from the source
import { Button } from "./components/Button";
```

Pure barrel files (files that only re-export) are renamed to `index.barrel.bak.ts` for review.

## What it handles

- Named re-exports (`export { X } from './X'`)
- Aliased re-exports (`export { X as Y } from './X'`)
- Default-as-named re-exports (`export { default as X } from './X'`)
- Namespace re-exports (`export * as X from './X'`)
- Import-then-reexport patterns
- Mixed barrel files that contain their own declarations (only the re-exported imports are rewritten; the barrel is kept)

## Migration complexity metric

Alongside the rewrite, the codemod emits a `barrel-metric` event per re-export found in each barrel. Each event carries five cardinalities so you can estimate migration effort before rolling the codemod out at scale:

| Cardinality | Values |
| --- | --- |
| `export_style` | `explicit` \| `wildcard` |
| `chaining` | `single-level` \| `chained` |
| `risk_amplifier` | `none` \| `heavy-usage-or-public-api` \| `cycles-or-side-effects` |
| `file` | workspace-relative path of the affected barrel |
| `migration_complexity_score` | `0`–`4` (sum of the other dimensions) |

Scoring rules: `wildcard` adds 1, `chained` adds 1, `heavy-usage-or-public-api` adds 1, `cycles-or-side-effects` adds 2. Roughly: **0–1 = Low**, **2 = Medium**, **3–4 = High**.

Notes:

- `heavy-usage-or-public-api` fires only when the barrel matches the advertised entry point of its nearest `package.json` (`main`, `module`, `types`, or any leaf of `exports`). A random internal `index.ts` inside a repo is not flagged.
- `count` aggregates raw emission events, not unique re-export sites. Because every file in a barrel's directory emits the same metric tuple (a workaround for per-directory test snapshots), the value is inflated by directory density in proportion to the number of sibling files. To recover an approximate re-export count, divide `count` by the number of files in the barrel's directory.

## Usage

```bash
# Run from the registry
codemod run debarrel

# Run locally during development
codemod run -w workflow.yaml
```

## Development

```bash
# Run tests
pnpm test

# Type-check
pnpm check-types
```

## License

MIT
