---
"debarrel": patch
---

Fix cloud runtime crash in project file walking when `readdirSync` entries lack a usable `.name` (avoid `entry.name.startsWith` on undefined).
