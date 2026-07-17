export function cache<T>(fn: () => T): T {
  return fn();
}
