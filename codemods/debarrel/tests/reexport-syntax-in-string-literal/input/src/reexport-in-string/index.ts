// The string is not an export. Semantically, barrel-metric should only record
// the real `export { value } from "./real"` re-export, not a fake `./decoy` path.
const _samplePathHint = 'export { decoy } from "./decoy"';
export { value } from "./real";
