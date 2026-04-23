import type { SgNode } from "codemod:ast-grep";
import type { Language } from "./language.ts";

export function getStringContent(node: SgNode<Language>): string | null {
  const fragment = node.find({ rule: { kind: "string_fragment" } });
  if (fragment) return fragment.text();
  if (node.is("string")) {
    const t = node.text();
    if (t.length >= 2) {
      const open = t[0];
      const close = t[t.length - 1];
      if ((open === '"' && close === '"') || (open === "'" && close === "'")) {
        return t.slice(1, -1);
      }
    }
  }
  return null;
}
