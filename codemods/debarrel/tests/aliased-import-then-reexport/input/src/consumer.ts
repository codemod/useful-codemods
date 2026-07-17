import { unstable_cache } from "./cache";

export const getValue = unstable_cache(() => 42);
