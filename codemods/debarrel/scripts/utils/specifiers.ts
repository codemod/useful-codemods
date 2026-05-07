import type { SgNode, SgRoot } from "codemod:ast-grep";
import type { Language } from "./language.ts";
import { getStringContent } from "./ast.ts";
import {
  getPackageName,
  isBarrelFile,
  isInsideNodeModules,
  isLocalRelativePath,
  joinImportPaths,
} from "./paths.ts";
import { parseBarrelExport } from "./barrel.ts";

function getImportPackageName(importPath: string): string | null {
  if (importPath.startsWith("@")) {
    const segments = importPath.split("/");
    return segments.length >= 2 ? `${segments[0]}/${segments[1]}` : null;
  }

  const [packageName] = importPath.split("/");
  return packageName || null;
}

export interface SpecRewrite {
  consumerName: string;
  newImportPath: string;
  localName: string;
  importType: "default" | "named" | "namespace";
  resolvedFilePath: string;
}

/**
 * Given a definition result for an import specifier, resolve it to
 * a direct import path bypassing the barrel.
 */
export function resolveSpecifier(
  localBinding: SgNode<Language>,
  importPath: string,
  def: { kind: string; root: SgRoot<Language>; node: SgNode<Language> },
): SpecRewrite | null {
  if (def.kind !== "external") return null;

  // Never rewrite imports that resolve into node_modules — those are
  // third-party or published workspace packages with potentially restricted
  // package.json "exports" that would break if we change the import subpath.
  if (isInsideNodeModules(def.root.filename())) return null;

  // For non-relative imports, only preserve the package boundary when the
  // resolved file belongs to the same named package as the import specifier.
  // This keeps tsconfig aliases like `~/foo` or `@acme/pkg/*` rewriteable
  // even when the surrounding repo has an unrelated package.json.
  if (!isLocalRelativePath(importPath)) {
    const packageName = getPackageName(def.root.filename());
    const importPackage = getImportPackageName(importPath);
    if (packageName && importPackage === packageName) {
      return null;
    }
  }

  if (isBarrelFile(def.root.filename())) {
    // Definition landed on an export_statement in the barrel
    if (def.node.is("export_statement")) {
      const info = parseBarrelExport(def.node, localBinding.text());
      if (!info) return null;
      return {
        consumerName: localBinding.text(),
        newImportPath: joinImportPaths(importPath, info.sourceFromBarrel),
        localName: info.localName,
        importType: info.importType,
        resolvedFilePath: def.root.relativeFilename(),
      };
    }
    // Import-then-reexport: definition landed on import_specifier in the barrel
    const barrelImportStmt = def.node.is("import_statement")
      ? def.node
      : def.node.ancestors().find((a) => a.is("import_statement"));
    if (!barrelImportStmt) return null;
    const impSource = barrelImportStmt.children().find((c) => c.is("string"));
    if (!impSource) return null;
    const impPath = getStringContent(impSource);
    if (!impPath || !isLocalRelativePath(impPath)) return null;
    let originalName = localBinding.text();
    if (def.node.is("import_specifier")) {
      const idents = def.node.findAll({ rule: { kind: "identifier" } });
      if (idents.length >= 1) originalName = idents[0]?.text() ?? "";
    }
    return {
      consumerName: localBinding.text(),
      newImportPath: joinImportPaths(importPath, impPath),
      localName: originalName,
      importType: "named",
      resolvedFilePath: def.root.relativeFilename(),
    };
  }

  // Semantic analyzer resolved all the way through to the actual source file
  // (not a barrel). Only rewrite if the import actually went through a barrel
  // that we can bypass. If the resolved file is already the direct target of
  // the import (e.g. @acme/api/models/utils/ratelimiter → ratelimiter.ts),
  // the import is already correct — don't rewrite.
  return null;
}
