---
"debarrel": minor
---

Add `barrel-metric` event emitted per re-export in every barrel the codemod visits. Each event carries five cardinalities — `export_style`, `chaining`, `risk_amplifier`, `file`, and a derived `migration_complexity_score` (0–4) — so you can estimate migration effort before rolling the codemod out at scale.
