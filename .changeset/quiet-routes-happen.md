---
"debarrel": patch
---

Skip renaming Next.js Pages API route `index` files when they look like pure re-export barrels. Also tighten pure-barrel detection so an `index` file is only treated as a barrel when every export is a `from "..."` re-export.
