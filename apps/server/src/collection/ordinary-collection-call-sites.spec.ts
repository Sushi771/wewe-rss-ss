import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';

describe('ordinary collection snapshot dependency regression guard', () => {
  it.each([
    [
      'collection.service.ts',
      [
        'collectOwnerSearch',
        'collectOwnerWereadLatest',
        'collectVerifiedWereadCandidate',
        'retryArticleBody',
        'supplementWechat2RssAvatar',
        'collectWechat2RssRecent',
      ],
    ],
    [
      '../trpc/trpc.service.ts',
      [
        'recordCollectionResult',
        'continueAcceptedSubscription',
        'bindAcceptedSubscription',
        'stageAcceptedSubscription',
      ],
    ],
    ['xiaohongshu.service.ts', ['add', 'edit', 'refresh']],
  ] as const)(
    '%s ordinary methods cannot request or hide a full snapshot',
    (file, methods) => {
      const name = path.resolve(__dirname, file);
      const source = ts.createSourceFile(
        name,
        readFileSync(name, 'utf8'),
        ts.ScriptTarget.Latest,
        true,
      );
      const found = new Set<string>();
      const visit = (node: ts.Node) => {
        if (
          ts.isMethodDeclaration(node) &&
          methods.some((method) => method === node.name.getText(source))
        ) {
          const method = node.name.getText(source);
          found.add(method);
          // Prohibit both a call and an alias/reference that could move the
          // costly snapshot to another ordinary wrapper without updating policy.
          expect(node.body?.getText(source)).not.toMatch(
            /createVerifiedSqliteBackup|\.snapshot\(/,
          );
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
      expect([...found].sort()).toEqual([...methods].sort());
    },
  );
});
