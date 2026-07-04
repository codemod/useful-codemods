import type { SgNode } from "codemod:ast-grep";
import type { Language } from "./language.ts";

export function getStringContent(node: SgNode<Language>): string | null {
  const fragment = node.find({ rule: { kind: "string_fragment" } });
  return fragment ? fragment.text() : null;
}

/** Imported binding vs local alias for `import { Foo as Bar }`. */
export function getImportSpecifierNames(
  spec: SgNode<Language>,
): { importedName: string; localName: string } | null {
  const identifiers = spec.findAll({ rule: { kind: "identifier" } });
  if (identifiers.length === 0) return null;
  const importedName = identifiers[0]!.text();
  const localName = identifiers[identifiers.length - 1]!.text();
  return { importedName, localName };
}
