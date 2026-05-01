# Web3.py v6 -> v7 Migration Codemod

A production-grade, deterministic codemod engine designed for zero false positives, using Codemod JSSG (ast-grep) with an NVIDIA NIM fallback for complex class refactoring.

## Why this Codemod? ("Boring AI" Hackathon Submission)

Codemods fail when they try to use AI for *everything*. We built a production-grade Web3.py v6 -> v7 migration tool that respects engineering trust. We use **Codemod JSSG (ast-grep)** to deterministically map 90% of breaking changes (Provider renaming, WebSocket namespace transposition) with zero false positives. 

Where AST matching fails—specifically translating functional middleware into v7's new Class-based middleware architecture—we securely inject an **NVIDIA NIM (Llama 3 70B)** fallback via prompt sandboxing. It proves that AI in codemods is best utilized as a surgical scalpel, not a sledgehammer.

### Features
* **Deterministic First:** 90% of the breaking changes (Providers, Namespaces, standard Middleware) are handled via QuickJS/ast-grep pattern matching. 
* **AI Isolation:** Generative AI is strictly sandboxed to refactoring custom `def mw(make_request, w3)` middleware implementations. It is never allowed to blindly rewrite application logic.
* **Syntax Validation:** The AI output is validated to ensure it starts with `class` (as all v7 middleware must be classes) before injection, ensuring broken LLM generation doesn't break your codebase.

### Usage
```bash
export NVIDIA_NIM_API_KEY="your-api-key"
npx codemod @boring-ai/web3py-v7-migration ./target-directory
```

### Safety Notes
* **Dry Run:** You can run `npx codemod ... --dry-run` to see the proposed AST and AI changes without writing to disk.
* **Idempotency:** Custom middleware blocks converted to classes will not be double-processed on subsequent runs.
* **AI Fallback:** If you do not provide `NVIDIA_NIM_API_KEY`, the codemod gracefully skips complex middleware rewrites and leaves a warning in your terminal.

---
*Built for the Boring AI Hackathon.*
