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
