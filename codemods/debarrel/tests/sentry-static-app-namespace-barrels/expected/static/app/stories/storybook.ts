export function story(name: string, fn: (s: unknown) => void) {
  return {name, fn};
}
