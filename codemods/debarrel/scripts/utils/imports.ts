import type { Edit, SgNode } from "codemod:ast-grep";
import { addImport } from "@jssg/utils/javascript/imports";
import type { Language } from "./language.ts";
import type { SpecRewrite } from "./specifiers.ts";

export function buildImportText(
  sourcePath: string,
  specs: SpecRewrite[],
  quoteChar: string,
): string {
  const parts: string[] = [];
  const defaultSpec = specs.find((s) => s.importType === "default");
  if (defaultSpec) parts.push(defaultSpec.consumerName);
  for (const ns of specs.filter((s) => s.importType === "namespace")) {
    parts.push(`* as ${ns.consumerName}`);
  }
  const namedSpecs = specs.filter((s) => s.importType === "named");
  if (namedSpecs.length > 0) {
    const specTexts = namedSpecs.map((s) =>
      s.localName !== s.consumerName
        ? `${s.localName} as ${s.consumerName}`
        : s.consumerName,
    );
    parts.push(`{ ${specTexts.join(", ")} }`);
  }
  return `import ${parts.join(", ")} from ${quoteChar}${sourcePath}${quoteChar};`;
}

export function groupByPath(
  rewrites: SpecRewrite[],
): Map<string, SpecRewrite[]> {
  const byPath = new Map<string, SpecRewrite[]>();
  for (const rw of rewrites) {
    const existing = byPath.get(rw.newImportPath) ?? [];
    existing.push(rw);
    byPath.set(rw.newImportPath, existing);
  }
  return byPath;
}

export function addImportsFromRewrites(
  rootNode: SgNode<Language, "program">,
  byPath: Map<string, SpecRewrite[]>,
  edits: Edit[],
): void {
  for (const [sourcePath, specs] of byPath) {
    const defaultSpec = specs.find((s) => s.importType === "default");
    if (defaultSpec) {
      const e = addImport(rootNode, {
        type: "default",
        name: defaultSpec.consumerName,
        from: sourcePath,
      });
      if (e) edits.push(e);
    }

    for (const ns of specs.filter((s) => s.importType === "namespace")) {
      const e = addImport(rootNode, {
        type: "namespace",
        name: ns.consumerName,
        from: sourcePath,
      });
      if (e) edits.push(e);
    }

    const namedSpecs = specs.filter((s) => s.importType === "named");
    if (namedSpecs.length > 0) {
      const e = addImport(rootNode, {
        type: "named",
        specifiers: namedSpecs.map((s) =>
          s.localName !== s.consumerName
            ? { name: s.localName, alias: s.consumerName }
            : { name: s.consumerName },
        ),
        from: sourcePath,
      });
      if (e) edits.push(e);
    }
  }
}
