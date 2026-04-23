import path from "path";
import { parse } from "codemod:ast-grep";
import type { SgNode, SgRoot } from "codemod:ast-grep";
import { getStringContent } from "./ast.ts";
import type { Language } from "./language.ts";
import { isLocalRelativePath } from "./paths.ts";

export type BarrelEmission = { source: string; isWildcard: boolean };

/** Per barrel path: one parse + walk for all sibling file visits. */
export type BarrelMetricCache = Map<
  string,
  { barrelHasSideEffects: boolean; emissions: BarrelEmission[] } | null
>;

const cache: BarrelMetricCache = new Map();

export function clearBarrelMetricCache(): void {
  cache.clear();
}

function parseLangName(filePath: string): string {
  const ext = filePath.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  if (ext === "tsx" || ext === "jsx") return "tsx";
  if (ext === "ts" || ext === "mts" || ext === "cts") return "typescript";
  return "javascript";
}

function tryParse(
  filePath: string,
  content: string,
): SgRoot<Language> | null {
  try {
    return parse<Language>(parseLangName(filePath), content) as SgRoot<Language>;
  } catch {
    return null;
  }
}

function importClauseHasValueBindings(clause: SgNode<Language>): boolean {
  if (clause.find({ rule: { kind: "named_imports" } })) return true;
  if (clause.find({ rule: { kind: "namespace_import" } })) return true;
  for (const ch of clause.children()) {
    if (ch.is("identifier") && !ch.inside({ rule: { kind: "named_imports" } })) {
      return true;
    }
  }
  return false;
}

/**
 * @param t Normalized (single-line) import statement or line text.
 * Reject package imports: only `import` with a `from`-free specifier that is
 * a local relative path counts as a runtime side effect for metrics.
 */
function lineIsTopLevelSideEffectOnlyImport(t: string): boolean {
  if (!t.startsWith("import")) return false;
  if (/^import\s+type\b/.test(t)) return false;
  if (/^import\s*\{/.test(t)) return false;
  if (/^import\s+\*\s+as\b/.test(t)) return false;
  if (/^import\s+default\b/.test(t)) return false;
  if (/^import\s+[\p{L}\p{M}\p{N}_$][\w$]*\s+from\s*["']/u.test(t)) {
    return false;
  }
  if (
    !/^import\s*["'][^"']*["']\s*;?\s*$/.test(t) &&
    !/^import\s*["'][^"']*["']\s+with\s/.test(t)
  ) {
    return false;
  }
  const spec = t.match(/^import\s*["']([^"']*)["']/);
  const path = spec?.[1];
  return path != null && isLocalRelativePath(path);
}

function sideEffectImportByStatementText(stmt: SgNode<Language>): boolean {
  return lineIsTopLevelSideEffectOnlyImport(
    stmt.text().replace(/\s+/g, " ").trim(),
  );
}

/**
 * Module loaded for side effects: `import` with no (value) binding clause, or
 * a clause with no `import` bindings (e.g. some `import "m" with { … }` forms).
 */
function importStatementIsSideEffectOnly(stmt: SgNode<Language>): boolean {
  if (!stmt.is("import_statement")) return false;
  // Rely on statement text for bare `import "./m"`: the tree can omit
  // `string` (or the module node) in some JSSG/tree-sitter builds.
  if (sideEffectImportByStatementText(stmt)) return true;
  const str = lastLocalPathStringInStmt(stmt);
  if (!str) return false;
  const s = getStringContent(str);
  if (!s || !isLocalRelativePath(s)) return false;
  const importClause = stmt.find({ rule: { kind: "import_clause" } });
  if (!importClause) return true;
  if (!importClauseHasValueBindings(importClause)) return true;
  return false;
}

function walkHasSideEffectImport(
  program: SgNode<Language, "program">,
): boolean {
  for (const ch of program.children()) {
    if (ch.is("import_statement") && importStatementIsSideEffectOnly(ch)) {
      return true;
    }
  }
  return false;
}

// JSSG can omit `import_statement` or `string` nodes; line-scan fallback must
// ignore `import` inside block and line comments (wildcard-side-effect-in-comment).
function contentHasTopLevelSideEffectImportLineAfterComments(
  content: string,
): boolean {
  let inBlock = false;
  for (const raw of content.split("\n")) {
    let line = raw;
    if (inBlock) {
      const endIdx = line.indexOf("*/");
      if (endIdx === -1) {
        continue;
      }
      inBlock = false;
      line = line.slice(endIdx + 2);
    }
    for (;;) {
      const start = line.indexOf("/*");
      if (start === -1) break;
      const end = line.indexOf("*/", start + 2);
      if (end === -1) {
        inBlock = true;
        line = line.slice(0, start);
        break;
      }
      line = line.slice(0, start) + line.slice(end + 2);
    }
    const t = line.replace(/\/\/.*$/, "").replace(/\s+/g, " ").trim();
    if (t.length > 0 && lineIsTopLevelSideEffectOnlyImport(t)) {
      return true;
    }
  }
  return false;
}

/**
 * `import` bindings: localName → source path, for `export { a };` re-exports.
 */
function importSpecifierLocalBindingName(
  spec: SgNode<Language>,
): string | null {
  const ids = spec.findAll({ rule: { kind: "identifier" } });
  if (ids.length === 0) return null;
  if (ids[0]!.text() === "type" && ids[1]) return ids[1]!.text();
  return ids[ids.length - 1]!.text();
}

function collectImportBindings(
  program: SgNode<Language, "program">,
  fileContent: string,
): Map<string, string> {
  const m = new Map<string, string>();
  for (const stmt of program.children()) {
    if (!stmt.is("import_statement")) continue;
    const mod = lastLocalPathStringInStmt(stmt);
    if (!mod) continue;
    const modPath = getStringContent(mod);
    if (!modPath || !isLocalRelativePath(modPath)) continue;

    for (const spec of stmt.findAll({ rule: { kind: "import_specifier" } })) {
      const name = importSpecifierLocalBindingName(spec);
      if (name) m.set(name, modPath);
    }

    // `import { type }` (value import named `type`): JSSG may omit `import_clause`
    // and every `import_specifier` — but `stmt.text()` still has the right shape.
    const oneLine = stmt.text().replace(/\s+/g, " ");
    const typeAsValue = /import[\s.]*{[\s.]*type[\s.]*}[\s.]*from[\s.]*["']([./][^"']*)["']/.exec(
      oneLine,
    );
    if (typeAsValue) {
      const p = typeAsValue[1];
      if (p && isLocalRelativePath(p)) m.set("type", p);
    } else if (
      !/import[\s.]+type[\s.]*{/.test(oneLine) &&
      /import[\s.]*{[\s.]*type[\s.]*}[\s.]*from/.test(oneLine) &&
      modPath
    ) {
      m.set("type", modPath);
    }

    const importClause = stmt.find({ rule: { kind: "import_clause" } });
    if (importClause) {
      const named = importClause.find({ rule: { kind: "named_imports" } });
      if (named) {
        for (const spec of named.findAll({ rule: { kind: "import_specifier" } })) {
          const name = importSpecifierLocalBindingName(spec);
          if (name) m.set(name, modPath);
        }
      }
    }
    if (!importClause) continue;

    const ns = importClause.find({ rule: { kind: "namespace_import" } });
    if (ns) {
      const id = ns.find({ rule: { kind: "identifier" } });
      if (id) m.set(id.text(), modPath);
    }

    if (stmt.findAll({ rule: { kind: "import_specifier" } }).length > 0) {
      continue;
    }
    if (ns) continue;

    const def = importClause
      .children()
      .find(
        (c) =>
          c.is("identifier") && !c.inside({ rule: { kind: "named_imports" } }),
      );
    if (def) m.set(def.text(), modPath);
  }
  if (!m.has("type")) {
    const flat = fileContent.replace(/\s+/g, " ");
    const tBind = /import\s*{\s*type\s*}\s*from\s*["']([./][^"']*)["']/.exec(
      flat,
    );
    if (tBind?.[1] && isLocalRelativePath(tBind[1])) m.set("type", tBind[1]);
  }
  return m;
}

function exportSpecifierSourcelessLookupName(
  spec: SgNode<Language>,
): string | null {
  const ids = spec.findAll({ rule: { kind: "identifier" } });
  if (ids.length === 0) return null;
  if (ids[0]!.text() === "type" && ids[1]) return ids[1]!.text();
  return ids[0]!.text();
}

/**
 * `export * from "p"` and `export * as X from "p"` (and `export type * from`) can miss
 * `namespace_export` in some tree-sitter builds; use a local `export_statement` text
 * check (not a whole-file regex scan) as fallback — avoids `stmt.matches` which can
 * throw in the JSSG runtime.
 */
function isExportStarReexportForm(stmt: SgNode<Language>): boolean {
  if (!stmt.is("export_statement")) return false;
  if (stmt.find({ rule: { kind: "namespace_export" } })) return true;
  const t = stmt.text();
  if (/export\s+type\s+\*/.test(t) && t.includes("from")) return true;
  if (/export\s+\*\s+as\s+/.test(t) && t.includes("from")) return true;
  if (/export\s+\*\s*from/.test(t)) return true;
  return false;
}

/**
 * The `from "./m"` string is not always a direct child; use a deep search, and
 * if there are several path-like strings, the module in `import` / `export … from "…"`
 * is usually the last in source order (e.g. `import type` + string, `import … with`).
 */
function lastLocalPathStringInStmt(stmt: SgNode<Language>): SgNode<Language> | null {
  const allStr = stmt.findAll({ rule: { kind: "string" } });
  const rel: SgNode<Language>[] = [];
  for (const s of allStr) {
    const p = getStringContent(s);
    if (p && isLocalRelativePath(p)) rel.push(s);
  }
  if (rel.length === 0) return null;
  return rel[rel.length - 1] ?? null;
}

/**
 * JSSG's `export_statement#text` can mangle or omit non-ASCII in `* as` idents
 * (e.g. `export * as 名前 from "./m"`), so also scan a real `export` line that
 * contains the module string (not a `const` string that quotes a fake path).
 */
function fileLineIsExportStarReexport(
  fileContent: string,
  relPath: string,
): boolean {
  const d = `"${relPath}"`;
  const s = `'${relPath}'`;
  for (const raw of fileContent.split(/\r?\n/)) {
    if (!raw.includes(d) && !raw.includes(s)) continue;
    const t = raw
      .replace(/^\uFEFF/, "")
      .replace(/\/\/.*$/, "")
      .trim()
      .replace(/\r$/, "");
    if (!/^\s*export\s+/.test(t)) continue;
    if (/export\s+type\s+\*/.test(t) && t.includes("from")) return true;
    if (t.includes("from") && t.includes("* as") && t.includes("export")) {
      return true;
    }
    if (t.includes("from") && /export[\s.]*\*\s*from/.test(t)) return true;
  }
  return false;
}

/**
 * `export { … } from "p"` (and `export type { … } from`) on the real file line
 * for `p`. Distinguishes from star re-exports so heuristics never misclassify.
 */
function fileLineIsExplicitNamedReexport(
  fileContent: string,
  relPath: string,
): boolean {
  const d = `"${relPath}"`;
  const s = `'${relPath}'`;
  for (const raw of fileContent.split(/\r?\n/)) {
    if (!raw.includes(d) && !raw.includes(s)) continue;
    const t = raw
      .replace(/^\uFEFF/, "")
      .replace(/\/\/.*$/, "")
      .trim();
    if (!/^\s*export\s+/.test(t) || !/\bfrom\s*["']/.test(t)) continue;
    if (/^\s*export(\s+type)?\s*\{/.test(t)) return true;
  }
  return false;
}

/**
 * JSSG/tree-sitter can break `export { type, Foo }` (ERROR nodes) so
 * `export_specifier` walks miss names. Parse the clause from statement text
 * and return local names for the binding map.
 */
function localNameFromExportSpecPartSegment(part: string): string | null {
  const p = part.trim();
  if (!p) return null;
  const asChunk = p.split(/\s+as\s+/);
  if (asChunk.length >= 2) {
    return asChunk[0]!.replace(/^\btype\s+/, "").trim() || null;
  }
  return p.replace(/^\btype\s+/, "").trim() || null;
}

function sourcelessExportLocalNamesFromStmtText(
  stmt: SgNode<Language>,
): string[] {
  const t = stmt.text().replace(/\s+/g, " ");
  const m = /\bexport\s*\{([^}]+)\}/.exec(t);
  if (!m?.[1]) return [];
  const out: string[] = [];
  for (const part of m[1]!.split(",")) {
    const n = localNameFromExportSpecPartSegment(part);
    if (n) out.push(n);
  }
  return out;
}

/**
 * Strip `//` line comments and `/* … *\/` block comments; jump OVER string
 * literals (preserving their contents verbatim), so that `;` and `//` inside
 * a quoted string are treated as string chars, not as statement / comment
 * boundaries. See the `reexport-syntax-in-string-literal` fixture: a `const
 * x = 'export { decoy } from "./decoy"'` must not be parsed as a re-export.
 */
function stripComments(src: string): string {
  let out = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i]!;
    const c2 = src[i + 1];
    if (c === "/" && c2 === "/") {
      while (i < n && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && c2 === "*") {
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) {
        if (src[i] === "\n") out += "\n";
        i++;
      }
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      out += quote;
      i++;
      while (i < n && src[i] !== quote) {
        if (src[i] === "\\" && i + 1 < n) {
          out += src[i]!;
          out += src[i + 1]!;
          i += 2;
          continue;
        }
        out += src[i]!;
        i++;
      }
      if (i < n) {
        out += src[i]!;
        i++;
      }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/**
 * Split on `;` at top level (strings/comments already handled by `stripComments`),
 * flatten whitespace so multi-line `export { a, b } from "m"` becomes one chunk.
 */
function splitLogicalStatements(stripped: string): string[] {
  return stripped
    .split(";")
    .map((t) => t.replace(/\s+/g, " ").trim())
    .filter((t) => t.length > 0);
}

/**
 * Emit `{ source, isWildcard }` directly from the stripped barrel text —
 * robust against JSSG tree-sitter quirks on non-ASCII identifiers and
 * `export * as` ownership (see the `unicode-wildcard-namespace` fixture).
 */
/**
 * Match `from "…"` / `from '…'` at the end of `stmt`, return the quoted path.
 * Avoids `[^"']+` classes: some runtimes handle non-ASCII inconsistently.
 */
function extractFromSource(stmt: string): string | null {
  const m = /\bfrom\s+(["'])/.exec(stmt);
  if (!m) return null;
  const quote = m[1]!;
  const start = m.index + m[0].length;
  const end = stmt.indexOf(quote, start);
  if (end === -1) return null;
  return stmt.slice(start, end);
}

/**
 * Each `stmt` is already whitespace-flattened. Tokenize: strip `export`, an
 * optional `type`, and classify by the next char (`*` → wildcard, `{` → named).
 * Avoids regex features (Unicode `\S`, negated classes) that behave
 * differently on LLRT; see the `unicode-wildcard-namespace` fixture.
 */
type ParsedStmt =
  | { kind: "wildcard"; source: string }
  | { kind: "explicitFrom"; source: string }
  | { kind: "sourcelessNamed"; names: string[] }
  | { kind: "other" };

function parseExportStatement(stmt: string): ParsedStmt {
  if (!stmt.startsWith("export ") && !stmt.startsWith("export\t")) {
    return { kind: "other" };
  }
  let rest = stmt.slice("export".length).trimStart();
  if (rest.startsWith("type ") || rest.startsWith("type\t")) {
    rest = rest.slice("type".length).trimStart();
  }
  if (rest.startsWith("*")) {
    const src = extractFromSource(rest);
    if (src) return { kind: "wildcard", source: src };
    return { kind: "other" };
  }
  if (rest.startsWith("{")) {
    const closeIdx = rest.indexOf("}");
    if (closeIdx === -1) return { kind: "other" };
    const inside = rest.slice(1, closeIdx);
    const afterBrace = rest.slice(closeIdx + 1).trimStart();
    const src = extractFromSource(rest);
    if (src) return { kind: "explicitFrom", source: src };
    if (afterBrace.length === 0 || afterBrace.startsWith(";")) {
      const names: string[] = [];
      for (const part of inside.split(",")) {
        const n = localNameFromExportSpecPartSegment(part);
        if (n) names.push(n);
      }
      return { kind: "sourcelessNamed", names };
    }
  }
  return { kind: "other" };
}

function collectReexportsFromContent(
  content: string,
  bindingMap: Map<string, string>,
): BarrelEmission[] {
  const out: BarrelEmission[] = [];
  const stripped = stripComments(content);

  for (const stmt of splitLogicalStatements(stripped)) {
    const parsed = parseExportStatement(stmt);
    if (parsed.kind === "wildcard") {
      if (isLocalRelativePath(parsed.source)) {
        out.push({ source: parsed.source, isWildcard: true });
      }
    } else if (parsed.kind === "explicitFrom") {
      if (isLocalRelativePath(parsed.source)) {
        out.push({ source: parsed.source, isWildcard: false });
      }
    } else if (parsed.kind === "sourcelessNamed") {
      const seenSource = new Set<string>();
      for (const localName of parsed.names) {
        const src = bindingMap.get(localName);
        if (src && isLocalRelativePath(src) && !seenSource.has(src)) {
          seenSource.add(src);
          out.push({ source: src, isWildcard: false });
        }
      }
    }
  }

  return out;
}

function buildBarrelEmissions(
  barrelFile: string,
  readFile: (p: string) => string,
): { barrelHasSideEffects: boolean; emissions: BarrelEmission[] } | null {
  let content: string;
  try {
    content = readFile(barrelFile);
  } catch {
    return null;
  }
  const root = tryParse(barrelFile, content);
  if (!root) return null;
  const program = root.root();
  if (!program.is("program")) return null;

  const barrelHasSideEffects =
    walkHasSideEffectImport(program) ||
    contentHasTopLevelSideEffectImportLineAfterComments(content);
  const bindingMap = collectImportBindings(program, content);
  const emissions = collectReexportsFromContent(content, bindingMap);

  const wild = emissions
    .filter((e) => e.isWildcard)
    .sort((a, b) => a.source.localeCompare(b.source));
  const rest = emissions
    .filter((e) => !e.isWildcard)
    .sort((a, b) => a.source.localeCompare(b.source));
  const ordered: BarrelEmission[] = [...wild, ...rest];

  return { barrelHasSideEffects, emissions: ordered };
}

export function getBarrelEmissions(
  absBarrelFile: string,
  readFile: (p: string) => string,
): { barrelHasSideEffects: boolean; emissions: BarrelEmission[] } | null {
  const key = path.normalize(absBarrelFile);
  const c = cache.get(key);
  if (c !== undefined) return c;
  const next = buildBarrelEmissions(key, readFile);
  cache.set(key, next);
  return next;
}

/**
 * True if a top-level side-effect `import` exists (e.g. `import "./x"` or
 * `import "./x" with { … }` without a binding clause), for a given file.
 */
export function fileHasTopLevelSideEffectOnlyImport(
  filePath: string,
  readFile: (p: string) => string,
): boolean {
  let content: string;
  try {
    content = readFile(filePath);
  } catch {
    return false;
  }
  const root = tryParse(filePath, content);
  if (!root) return false;
  const program = root.root();
  if (!program.is("program")) return false;
  if (walkHasSideEffectImport(program)) return true;
  return contentHasTopLevelSideEffectImportLineAfterComments(content);
}
