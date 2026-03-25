# debarrel

Debarrel JS/TS codebases. Removing barrel files and replacing import statements.

## Installation

```bash
# Install from registry
codemod run debarrel

# Or run locally
codemod run -w workflow.yaml
```

## Usage

This codemod transforms typescript code by:

- Converting `var` declarations to `const`/`let`
- Removing debug statements
- Modernizing syntax patterns

## Development

```bash
# Test the transformation
npm test

# Validate the workflow
codemod validate -w workflow.yaml

# Publish to registry
codemod login
codemod publish
```

## License

MIT 
## Skill Installation

```bash
npx codemod@latest debarrel
```
