import type { SgNode } from "codemod:ast-grep";
import type { Language } from "./language.ts";

export function getStringContent(node: SgNode<Language>): string | null {
  const fragment = node.find({ rule: { kind: "string_fragment" } });
  return fragment ? fragment.text() : null;
}
