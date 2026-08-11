import { cache as unstable_cache } from "./cache/unstable_cache";

export const getValue = unstable_cache(() => 42);
