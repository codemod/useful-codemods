import type { Edit, SgNode } from "codemod:ast-grep";
import type { Language } from "./language.ts";
import { getStringContent } from "./ast.ts";
import type { SpecRewrite } from "./specifiers.ts";

export interface BarrelMockInfo {
  /** Every direct-module path that replaces the barrel, used to emit automocks. */
  allPaths: Set<string>;
  /** Consumer binding name -> direct import path for that symbol. */
  symbolPaths: Map<string, string>;
}

/**
 * Record the rewrites for a given barrel import path so that any
 * `jest.mock`/`vi.mock` call targeting the same path can later be updated.
 */
export function recordBarrelRewrites(
  barrelRewrites: Map<string, BarrelMockInfo>,
  importPath: string,
  rewrites: SpecRewrite[],
): void {
  let info = barrelRewrites.get(importPath);
  if (!info) {
    info = { allPaths: new Set(), symbolPaths: new Map() };
    barrelRewrites.set(importPath, info);
  }
  for (const rw of rewrites) {
    info.allPaths.add(rw.newImportPath);
    info.symbolPaths.set(rw.consumerName, rw.newImportPath);
  }
}

function quoteCharFor(node: SgNode<Language>): string {
  return node.text().startsWith('"') ? '"' : "'";
}

/**
 * Rewrite `jest.mock` / `vi.mock` calls whose target path matches a barrel we
 * rewrote.
 *
 * - **Automock** (`jest.mock('./barrel')`): preserve the original call and
 *   append an automock for each new direct path.
 * - **Factory mock** (`jest.mock('./barrel', () => ({ ... }))`): when every
 *   import from the barrel in this file was rewritten to a single direct path,
 *   update the mock path. Multi-symbol factory mocks are left unchanged.
 */
export function rewriteMockCalls(
  rootNode: SgNode<Language, "program">,
  barrelRewrites: Map<string, BarrelMockInfo>,
  edits: Edit[],
): void {
  if (barrelRewrites.size === 0) return;

  const mockCalls = rootNode.findAll({
    rule: {
      any: [
        { pattern: "jest.mock($$$ARGS)" },
        { pattern: "vi.mock($$$ARGS)" },
      ],
    },
  });

  for (const callExpr of mockCalls) {
    const fn = callExpr.field("function");
    if (!fn) continue;
    const fnText = fn.text();

    const argsNode = callExpr.field("arguments");
    if (!argsNode) continue;
    const mockArgs = argsNode.children().filter((c) => c.isNamed());
    const pathArg = mockArgs[0];
    if (!pathArg || !pathArg.is("string")) continue;

    const mockPath = getStringContent(pathArg);
    if (!mockPath) continue;

    const info = barrelRewrites.get(mockPath);
    if (!info) continue;

    const quoteChar = quoteCharFor(pathArg);
    const exprStmt = callExpr
      .ancestors()
      .find((a) => a.is("expression_statement"));
    if (!exprStmt) continue;

    if (mockArgs.length === 1) {
      const lines = [
        exprStmt.text(),
        ...[...info.allPaths].map(
          (p) => `${fnText}(${quoteChar}${p}${quoteChar});`,
        ),
      ];
      edits.push(exprStmt.replace(lines.join("\n")));
      continue;
    }

    if (info.allPaths.size === 1) {
      const [onlyPath] = [...info.allPaths];
      edits.push(
        exprStmt.replace(
          exprStmt.text().replace(
            pathArg.text(),
            `${quoteChar}${onlyPath}${quoteChar}`,
          ),
        ),
      );
    }
  }
}

/**
 * Rewrite `import("barrel")` / `await import('barrel')` string literals that
 * still target a barrel path we rewrote in the same file.
 */
export function rewriteDynamicImports(
  rootNode: SgNode<Language, "program">,
  barrelRewrites: Map<string, BarrelMockInfo>,
  edits: Edit[],
): void {
  if (barrelRewrites.size === 0) return;

  for (const callExpr of rootNode.findAll({
    rule: { kind: "call_expression" },
  })) {
    const callee = callExpr.children().find((c) => c.is("import"));
    if (!callee) continue;

    const args = callExpr.children().find((c) => c.is("arguments"));
    if (!args) continue;
    const sourceNode = args.children().find((c) => c.is("string"));
    if (!sourceNode) continue;

    const importPath = getStringContent(sourceNode);
    if (!importPath) continue;

    const info = barrelRewrites.get(importPath);
    if (!info || info.allPaths.size !== 1) continue;

    const [onlyPath] = [...info.allPaths];
    const quoteChar = quoteCharFor(sourceNode);
    edits.push(
      sourceNode.replace(`${quoteChar}${onlyPath}${quoteChar}`),
    );
  }
}
