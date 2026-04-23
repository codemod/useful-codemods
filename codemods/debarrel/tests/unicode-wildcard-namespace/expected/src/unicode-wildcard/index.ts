// Semantics: one wildcard re-export to `./mod` and one explicit to `./zed` — both
// should appear in barrel-metric (the latter for migration scoring).
export * as 名前 from "./mod";
export { zed } from "./zed";
