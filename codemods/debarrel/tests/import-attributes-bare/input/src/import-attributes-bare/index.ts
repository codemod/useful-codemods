// Semantics: this is a top-level side-effect import. Per metrics rules, the barrel
// should be treated as having load-time side effects, so explicit re-exports (below)
// get `cycles-or-side-effects` risk, not a clean score of 0.
import "./side.json" with { type: "json" };
export { b } from "./b";
