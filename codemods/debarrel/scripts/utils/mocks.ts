import type { Edit, SgNode } from "codemod:ast-grep";
import type { Language } from "./language.ts";
import { getStringContent } from "./ast.ts";
import type { SpecRewrite } from "./specifiers.ts";

export interface BarrelMockInfo {
  /** Every direct-module path that replaces the barrel, used to emit automocks. */
  allPaths: Set<string>;
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
    info = { allPaths: new Set() };
    barrelRewrites.set(importPath, info);
  }
  for (const rw of rewrites) {
    info.allPaths.add(rw.newImportPath);
  }
}

/**
 * Rewrite `jest.mock` / `vi.mock` calls whose target path matches a barrel we
 * rewrote.
 *
 * - **Automock** (`jest.mock('./barrel')`): preserve the original call and
 *   append an automock for each new direct path. Preserving the original is a
 *   safety net — we only rewrite the barrel import if every specifier can be
 *   resolved, but we don't statically verify no other file imports from the
 *   barrel, so leaving the original automock in place avoids accidentally
 *   un-mocking the barrel for the rest of the test suite.
 * - **Factory mock** (`jest.mock('./barrel', () => ({ ... }))`): leave
 *   unchanged. Rewriting factory mocks can drop the original barrel mock while
 *   the file still imports some symbols from the barrel.
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

    // Factory mocks are left unchanged (see docstring).
    if (mockArgs.length !== 1) continue;

    const quoteChar = pathArg.text().startsWith('"') ? '"' : "'";
    const exprStmt = callExpr
      .ancestors()
      .find((a) => a.is("expression_statement"));
    if (!exprStmt) continue;

    const lines = [
      exprStmt.text(),
      ...[...info.allPaths].map(
        (p) => `${fnText}(${quoteChar}${p}${quoteChar});`,
      ),
    ];
    edits.push(exprStmt.replace(lines.join("\n")));
  }
}
