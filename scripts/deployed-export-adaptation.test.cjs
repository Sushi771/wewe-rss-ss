const restorePreOriginalLinkRouter = require('./xhs-original-link-router-seams.cjs');
const restorePlatformDirectory = require('./xhs-platform-directory-seams.cjs');
const restorePreReviewedRecoveryRouter = require('./xhs-reviewed-recovery-router-seams.cjs');
const restoreLegacyWriter = require('./legacy-writer-seams.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const ts = require(
  require.resolve('typescript', { paths: [path.resolve('apps/server')] }),
);
const pins = require('./fixtures/deployed-export-adaptation.json');
const xhsCompatibility = require('./fixtures/xhs-integration-router-compatibility.json');
const { restoreXhsReaderRoute } = require('./xhs-reader-removal.cjs');
const copyPins = require('./fixtures/product-copy-layout.json');
const searchPins = require('./fixtures/deployed-body-search-scope.json');
const read = (file) => fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
const hash = (text) => crypto.createHash('sha256').update(text).digest('hex');

test('approved startup and retired Mp2RSS inverses reject unrelated writer changes', () => {
  for (const [file, before, after] of [
    [
      'apps/server/src/prisma/prisma.service.ts',
      'this.writerLease?.check();',
      'void 0;',
    ],
    [
      'scripts/local-release/runtime.cjs',
      "settings.wechat2RssEnabled === '1'",
      "settings.wechat2RssEnabled !== '1'",
    ],
  ]) {
    const source = read(file);
    assert(source.includes(before));
    assert.throws(
      () =>
        restoreLegacyWriter.restoreCompatible(
          file,
          source.replace(before, after),
        ),
      /exact candidate legacy writer seam/,
    );
  }
});

test('reviewed runtime family inverse preserves every historical pin and rejects changed new or old gates', () => {
  const fixtures = require('./fixtures/runtime-family-compat.json'),
    installed = require('./fixtures/installed-writer-compat.json'),
    file = 'scripts/local-release/restart.cjs';
  assert.deepEqual(Object.keys(fixtures), [file]);
  const reviewed = fixtures[file],
    source = read(file);
  assert.equal(
    reviewed.reviewedFromCommit,
    '8fb806a54d415fc779881cee93fe7f3035dec385',
  );
  assert.equal(
    reviewed.reviewedThroughCommit,
    '52a34b16475728fbbd98b50db90cc339cd54270f',
  );
  assert.equal(hash(source), reviewed.afterSha256);
  assert.equal(reviewed.beforeSha256, installed[file].afterSha256);
  assert.equal(reviewed.hunks.length, 7);
  let precursor = source;
  for (const hunk of reviewed.hunks) {
    assert.equal(precursor.split(hunk.after).length, 2);
    precursor = precursor.replace(hunk.after, hunk.before);
    assert.equal(source.split(hunk.after).length, 2);
    assert.throws(
      () =>
        restoreLegacyWriter.restoreCompatible(
          file,
          source.replace(
            hunk.after,
            '/* changed reviewed runtime family hunk */',
          ),
        ),
      /exact candidate legacy writer seam/,
    );
  }
  assert.equal(hash(precursor), installed[file].afterSha256);
  const restored = restoreLegacyWriter.restoreCompatible(file, source);
  assert.equal(
    restored,
    restoreLegacyWriter.restoreCompatible(file, precursor),
  );
  assert.equal(hash(restored), installed[file].beforeSha256);
  for (const [before, after] of [
    [
      '.preparePreservingProcessFamily(identity);',
      '.preparePreservingProcessFamily(undefined);',
    ],
    [
      'if (familyError) throw familyError;',
      'if (familyError) void familyError;',
    ],
    [
      'assert.equal(result.stopped, true);',
      'assert.equal(result.stopped, false);',
    ],
    ["'PROJECT_WRITER_BOUNDARY_UNPROVEN'", "'BYPASSED_WRITER_BOUNDARY'"],
    ['timeoutMs = 15000,', 'timeoutMs = Infinity,'],
  ]) {
    assert(source.includes(before));
    assert.throws(
      () =>
        restoreLegacyWriter.restoreCompatible(
          file,
          source.replace(before, after),
        ),
      /exact candidate legacy writer seam/,
    );
  }
});

test('metadata-only exclusion inverse cannot hide changed new or historical writer gates', () => {
  const file = 'apps/server/src/collection/sqlite-write-coordinator.ts';
  const source = read(file);
  const addedAt = source.indexOf('  async knownAuthMetadataWrite<T>');
  assert(addedAt > 0);
  const added = source.slice(addedAt);
  for (const [before, after] of [
    ["this.acquire('backup')", "this.acquire('write')"],
    ['this.context.getStore()?.active ||', 'false ||'],
    ['this.protectedContext.getStore()?.active', 'false'],
    [
      'return await this.protectedContext.run(permit, operation);',
      'return operation();',
    ],
    ['permit.active = false;', 'permit.active = true;'],
    ['release();', 'void 0;'],
  ]) {
    assert.equal(added.split(before).length, 2);
    assert.throws(
      () =>
        restoreLegacyWriter(
          file,
          source.slice(0, addedAt) + added.replace(before, after),
        ),
      /exact known-auth metadata exclusion method/,
    );
  }
  assert.throws(
    () =>
      restoreLegacyWriter(
        file,
        source
          .slice(0, addedAt)
          .replace("this.acquire('backup')", "this.acquire('write')") + added,
      ),
    /exact reviewed collection integration source/,
    'the original protected writer remains fully pinned',
  );
});

test('approved XHS inverses reject lost local authentication, acknowledgements and client session injection', () => {
  const source = read('apps/server/src/trpc/trpc.router.ts');
  const fixture = require('./fixtures/xhs-approved-router-seams.json');
  for (const [key, before, after] of [
    [
      'route:confirmFullHistoryNarrowReview',
      'this.requireLocalXhsAccess(ctx);',
      'void ctx;',
    ],
    [
      'route:confirmFullHistoryNarrowReview',
      'acknowledgedUnknownExclusions: z.literal(true)',
      'acknowledgedUnknownExclusions: z.boolean()',
    ],
    [
      'top:xhsFullNarrowInput',
      'creatorId: z.string().uuid(),',
      'creatorId: z.string().uuid(), sessionBinding: z.string(),',
    ],
    [
      'route:savedSession',
      'this.trpcService.protectedProcedure',
      'this.trpcService.publicProcedure',
    ],
  ]) {
    const entry = fixture.entries.find((e) => e.key === key);
    assert(entry.after.includes(before));
    const changed = source.replace(
      entry.after,
      entry.after.replace(before, after),
    );
    assert.notEqual(changed, source);
    assert.throws(
      () => restorePreReviewedRecoveryRouter(ts, changed),
      /exact approved XHS node/,
    );
  }
});

test('retired pre-verification clear routes are absent and all historical router protection remains', () => {
  const fixture = require('./fixtures/xhs-approved-router-seams.json');
  assert.equal(
    hash(JSON.stringify(fixture)),
    '3a04c22d49e3ec9b57afe1f681c1476ddafb0cd76c2003ddd7e7256635418f4a',
  );
  const source = read('apps/server/src/trpc/trpc.router.ts');
  for (const name of [
    'prepareKnownResponseAuthReview',
    'confirmKnownResponseAuthReview',
    'prepareKnownAuthProfileProbe',
    'confirmKnownAuthProfileProbe',
  ]) {
    assert(!source.includes(name + ':'));
    const extra =
      name + ': this.trpcService.protectedProcedure.mutation(() => undefined),';
    assert.throws(
      () =>
        restorePreReviewedRecoveryRouter(
          ts,
          source.replace('connectionStatus:', extra + '\nconnectionStatus:'),
        ),
      /complete pre-recovery router AST preserved/,
    );
  }
});

test('approved XHS inverses reject unreviewed parentheses and parse errors', () => {
  const source = read('apps/server/src/trpc/trpc.router.ts');
  const entry =
    require('./fixtures/xhs-approved-router-seams.json').entries.find(
      (e) => e.key === 'route:confirmFullHistoryNarrowReview',
    );
  const before = 'this.requireLocalXhsAccess(ctx);';
  assert(entry.after.includes(before));
  for (const [after, error] of [
    ['this.requireLocalXhsAccess((ctx));', /exact approved XHS node/],
    ['this.requireLocalXhsAccess((ctx);', /approved XHS source must parse/],
  ]) {
    const changed = source.replace(
      entry.after,
      entry.after.replace(before, after),
    );
    assert.notEqual(changed, source);
    assert.throws(() => restorePreReviewedRecoveryRouter(ts, changed), error);
  }
});

test('approved XHS inverses retain unrelated WeChat and export router protection', () => {
  const source = read('apps/server/src/trpc/trpc.router.ts');
  for (const anchor of ['exportIds:', 'wechat2rssLoginStart:']) {
    const start = source.indexOf(anchor);
    assert(start >= 0, 'existing protected router');
    const at = source.indexOf('this.trpcService.protectedProcedure', start);
    assert(at > start);
    const changed =
      source.slice(0, at) +
      source
        .slice(at)
        .replace(
          'this.trpcService.protectedProcedure',
          'this.trpcService.publicProcedure',
        );
    assert.throws(
      () => restorePreReviewedRecoveryRouter(ts, changed),
      /complete pre-recovery router AST preserved/,
    );
  }
});
test('legacy writer additions cannot hide changed original admission or restart gates', () => {
  const seams = require('./fixtures/legacy-writer-seams.json');
  for (const [file, entries] of Object.entries(seams))
    for (const seam of entries) {
      const source = restoreLegacyWriter.restoreCompatible(file, read(file));
      assert.equal(source.split(seam.after).length, 2);
      assert.throws(
        () =>
          restoreLegacyWriter(
            file,
            source.replace(seam.after, '/* changed legacy writer gate */'),
          ),
        /exact candidate legacy writer seam/,
      );
    }
});
function tokens(text) {
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    true,
    ts.LanguageVariant.JSX,
    text,
  );
  const result = [];
  while (scanner.scan() !== ts.SyntaxKind.EndOfFileToken)
    result.push(scanner.getTokenText());
  return hash(result.join('\0'));
}

test('platform directory seams retain every prior controller and source statement', () => {
  // The reviewed avatar change reads avatar_url and adds avatarUrl to creator items.
  const originals = {
    'apps/server/src/article-download.controller.ts':
      '4923fa9409ce762b28863e97788de0912dcb7060',
    'apps/server/src/article-export-source.ts':
      'c2e7642b52e4a3a15d684eec219e87e3ff260ade',
    'apps/server/src/collection/xiaohongshu.service.ts':
      'bb68cf3617dab43ff292575ab2e2061e40dc612a',
  };
  for (const [file, expected] of Object.entries(originals)) {
    const restored = restorePlatformDirectory(file, read(file));
    assert.equal(
      crypto
        .createHash('sha1')
        .update('blob ' + Buffer.byteLength(restored) + '\0')
        .update(restored)
        .digest('hex'),
      expected,
    );
  }
});

test('platform directory seams refuse changes to any reviewed addition', () => {
  const seams = require('./fixtures/xhs-platform-directory-seams.json');
  for (const [file, entries] of Object.entries(seams))
    for (const seam of entries)
      assert.throws(
        () =>
          restorePlatformDirectory(
            file,
            read(file)
              .replace(seam.after, seam.after + '/* changed */')
              .replace(seam.after, '/* removed */'),
          ),
        /exact reviewed platform directory seam/,
      );
});

test('reviewed recovery seam retains the exact existing router source', () => {
  const restored = restorePreReviewedRecoveryRouter(
    ts,
    read('apps/server/src/trpc/trpc.router.ts'),
  );
  const blob = crypto
    .createHash('sha1')
    .update('blob ' + Buffer.byteLength(restored) + '\0')
    .update(restored)
    .digest('hex');
  assert.equal(
    blob,
    '782fbcd89c949bd06063488594e05b316d61008d',
    'exact pre-recovery router from the reviewed baseline',
  );
});

test('reviewed recovery seam rejects missing routes and changed writable authentication', () => {
  const source = read('apps/server/src/trpc/trpc.router.ts');
  for (const name of [
    'prepareWholeCreatorReviewedAttempt',
    'executeWholeCreatorReviewedAttempt',
    'reviewWholeCreatorUnknown',
    'prepareXhsHistoryHandoff',
    'confirmXhsHistoryHandoff',
  ]) {
    const declaration = name + ': this.trpcService.protectedProcedure';
    assert.equal(source.split(declaration).length, 2);
    assert.throws(
      () =>
        restorePreReviewedRecoveryRouter(
          ts,
          source.replace(
            declaration,
            name + ': this.trpcService.publicProcedure',
          ),
        ),
      /exact reviewed recovery route/,
    );
    assert.throws(
      () =>
        restorePreReviewedRecoveryRouter(
          ts,
          source.replace(name + ':', 'unreviewedReplacement:'),
        ),
      /all reviewed recovery routes/,
    );
  }
});
test('new selected recovery routes and group ordering retain their protected declarations', () => {
  const source = read('apps/server/src/trpc/trpc.router.ts');
  for (const name of [
    'reorderGroups',
    'resumeWholeCreatorMedia',
    'resumeWholeCreatorMissingBasic',
  ]) {
    const fixture = require('./fixtures/xhs-cache-router-seams.json').find(
      (entry) => entry.name === name,
    );
    assert.ok(
      fixture &&
        fixture.before === null &&
        fixture.after.includes('this.trpcService.protectedProcedure'),
    );
    const changed = fixture.after.replace(
      'this.trpcService.protectedProcedure',
      'this.trpcService.publicProcedure',
    );
    assert.notEqual(changed, fixture.after);
    assert.throws(
      () =>
        restorePreReviewedRecoveryRouter(
          ts,
          source.replace(fixture.after, changed),
        ),
      /exact cache collection route/,
    );
  }
});
test('deployment baseline keeps existing routes and safety/startup/reader/title policies', () => {
  assert.deepEqual(Object.keys(searchPins.criticalFiles).sort(), [
    'apps/server/src/article-body-search.ts',
    'apps/server/src/article-list-page.ts',
  ]);
  assert.deepEqual(Object.keys(searchPins.articleRoutes).sort(), [
    'exportIds',
    'list',
    'prepareSearch',
    'searchStatus',
    'summary',
  ]);
  const file = 'apps/server/src/trpc/trpc.router.ts';
  // Assert deletion, then reconstruct only the exact removed reader seam.
  // All old router/wholeCreator/engagement pins remain authoritative.
  const pinnedRouterSource = restoreXhsReaderRoute(
    ts,
    restorePreOriginalLinkRouter(
      restorePreReviewedRecoveryRouter(ts, read(file)),
    ),
  );
  const ast = ts.createSourceFile(
    file,
    pinnedRouterSource,
    ts.ScriptTarget.Latest,
    true,
  );
  const declaration = ast.statements.find(ts.isClassDeclaration);
  const members = {},
    routes = {};
  for (const member of declaration.members) {
    const key = member.name?.getText(ast) || 'constructor';
    if (key === 'articleRouter') {
      for (const route of member.initializer.arguments[0].properties) {
        const name = route.name.getText(ast);
        if (name !== 'saveToObsidianBatch')
          routes[name] = tokens(route.getText(ast));
      }
    } else if (
      !['buildOfflineFeedDirectory', 'applyMiddleware'].includes(key)
    ) {
      members[key] = tokens(member.getText(ast));
    }
  }
  // Keep every unrelated historical pin. This explicit layer records the four
  // independently reproduced f8fbb3c XHS differences and the two reviewed
  // engagement injection/router changes; it is not a full router repin.
  assert.deepEqual(Object.keys(xhsCompatibility.baseline).sort(), [
    'constructor',
    'requireLocalXhsAccess',
    'requireLocalXhsConnection',
    'xiaohongshuRouter',
  ]);
  assert.deepEqual(Object.keys(xhsCompatibility.engagement).sort(), [
    'constructor',
    'xiaohongshuRouter',
  ]);
  // The whole-creator extension may change only this injection and five XHS routes.
  // Remove those exact AST nodes and still enforce the previous engagement pins.
  assert.deepEqual(Object.keys(xhsCompatibility.wholeCreator).sort(), [
    'constructor',
    'xiaohongshuRouter',
  ]);
  const wholeRoutes = [
    'wholeCreatorJobs',
    'startWholeCreator',
    'resumeWholeCreator',
    'cancelWholeCreator',
    'extendWholeCreatorBudget',
  ];
  for (const key of ['constructor', 'xiaohongshuRouter']) {
    const member = declaration.members.find(
      (node) => (node.name?.getText(ast) || 'constructor') === key,
    );
    const removed =
      key === 'constructor'
        ? member.parameters.filter(
            (parameter) => parameter.name.getText(ast) === 'xhsWhole',
          )
        : member.initializer.arguments[0].properties.filter((property) =>
            wholeRoutes.includes(property.name.getText(ast)),
          );
    assert.equal(removed.length, key === 'constructor' ? 1 : 5);
    let prior = member.getText(ast);
    const offset = member.getStart(ast);
    for (const node of [...removed].reverse()) {
      assert.equal(
        pinnedRouterSource[node.end],
        ',',
        'exact additive seam must retain its delimiter',
      );
      prior =
        prior.slice(0, node.getFullStart() - offset) +
        prior.slice(node.end + 1 - offset);
    }
    assert.equal(
      tokens(prior),
      xhsCompatibility.engagement[key],
      `unchanged pre-whole ${key}`,
    );
  }
  assert.deepEqual(members, {
    ...pins.routerMembers,
    ...xhsCompatibility.baseline,
    ...xhsCompatibility.engagement,
    ...xhsCompatibility.wholeCreator,
  });
  assert.deepEqual(routes, {
    ...pins.articleRoutes,
    ...searchPins.articleRoutes,
  });
  for (const [file, expected] of Object.entries({
    ...pins.criticalFiles,
    ...searchPins.criticalFiles,
    ...xhsCompatibility.criticalFiles,
  })) {
    // Reader-only files were intentionally removed; keep every download/cache
    // baseline pin below and require these exact retired components to stay absent.
    const removedReaders = {
      'apps/web/src/components/ArticleReader.tsx':
        '5427dcc31fac30a42f7daaa09dcbf3e842013d8a65a29ec94c30750ceca1c071',
      'apps/web/src/utils/article-reader-find.ts':
        'f46a6144c8dac9cce7cbb1f3835e1606b5be8b8bd8d192ac336fd73c8eac1b79',
    };
    if (file in removedReaders) {
      assert.equal(expected, removedReaders[file], 'exact retired reader pin');
      assert.equal(fs.existsSync(file), false, file + ' must remain removed');
      continue;
    }
    let source = restoreLegacyWriter(
      file,
      restorePlatformDirectory(file, read(file)),
    );
    if (file === 'apps/server/src/article-download.controller.ts') {
      const additions = [
        [
          'import { basename, dirname, isAbsolute, join }',
          'import { dirname, isAbsolute, join }',
        ],
        ['          withSource.afterSave = prepare.afterSave;\n', ''],
        [
          '    let snapshotSavedCount = 0;\n    const snapshotFiles: string[] = [];\n',
          '',
        ],
        [
          "        if (result.supplement) {\n          snapshotFiles.push(basename(result.supplement.path));\n          if (result.supplement.status !== 'retained') snapshotSavedCount++;\n        }\n",
          '',
        ],
        ['        snapshotSavedCount,\n        snapshotFiles,\n', ''],
      ];
      for (const [addition, original] of additions) {
        assert.equal(
          source.split(addition).length,
          2,
          'reviewed XHS supplement seam',
        );
        source = source.replace(addition, original);
      }
    }
    if (file === 'scripts/local-release/runtime.cjs') {
      // The separately tested release scope adds exactly one entry guard. Keep
      // every pre-existing runtime statement pinned to its deployed baseline.
      const guarded =
        "async function runtime() {\n  require('./lib.cjs').hostEffects.assertRuntime();\n";
      assert.equal(source.split(guarded).length, 2);
      source = source.replace(guarded, 'async function runtime() {\n');
    }
    let requiredHash = expected;
    if (file === 'scripts/local-release/restart.cjs') {
      assert.equal(
        expected,
        'd958e4f2be1bb1f3f031f809669dde57057ffa6c6c7b2cce993862b4c466a4cc',
        'exact pre-preserving restart baseline',
      );
      // Reviewed schema proof retention and closed-copy restart inspection.
      requiredHash =
        '4ff5d4deb9dc621f6b91ee55309fd1e7674e650f4dcc6c53fc40caea0d7061ea';
      const restartAst = ts.createSourceFile(
        file,
        source,
        ts.ScriptTarget.Latest,
        true,
      );
      const calls = [];
      const visit = (node) => {
        if (
          ts.isCallExpression(node) &&
          ts.isPropertyAccessExpression(node.expression)
        )
          calls.push(node.expression.name.text);
        ts.forEachChild(node, visit);
      };
      visit(restartAst);
      for (const [name, count] of [
        ['validateSameSchema', 1],
        ['validateActiveBinding', 1],
        ['bindPreservingChild', 1],
        ['confirmPreservingProcessExit', 2],
      ])
        assert.equal(
          calls.filter((value) => value === name).length,
          count,
          'reviewed preserving restart ' + name,
        );
    }
    if (file === 'apps/server/src/prisma/prisma.service.ts') {
      // Keep the deployed baseline pin authoritative. Only this independently
      // reviewed recovery version is accepted; all unknown changes still fail.
      assert.equal(
        expected,
        '5e5887853c41a58205e6b6a22e217dff5501bfa964969044f510c9ef36731aaf',
        'exact pre-recovery Prisma baseline',
      );
      requiredHash =
        '6b71dbdced274a391826ccd6844eff781fd5e01a1dfa9fc765ab46eb2a1a7ab4';
      const recoveryAst = ts.createSourceFile(
        file,
        source,
        ts.ScriptTarget.Latest,
        true,
      );
      const service = recoveryAst.statements.find(ts.isClassDeclaration);
      const recovery = service.members.filter(
        (member) =>
          member.name?.getText(recoveryAst) === 'recoverFailedMediaTransaction',
      );
      assert.equal(recovery.length, 1, 'one reviewed recovery owner');
      assert.equal(
        recovery[0].parameters.length,
        0,
        'recovery cannot receive a replay callback',
      );
      assert.ok(
        recovery[0].body
          .getText(recoveryAst)
          .includes('await this.$disconnect();'),
      );
      assert.ok(
        recovery[0].body
          .getText(recoveryAst)
          .includes('await this.$connect();'),
      );
      assert.ok(
        recovery[0].body
          .getText(recoveryAst)
          .includes("setDatabaseRecovery('failed')"),
      );
    }
    assert.equal(hash(source), requiredHash, file);
  }
  // Export conversion now reuses its current DOM. Pin all other conversion
  // statements and the uncertainty predicate to the deployed source semantics.
  const conversion = ts.createSourceFile(
    'article-export.ts',
    restoreLegacyWriter(
      'apps/server/src/article-export.ts',
      read('apps/server/src/article-export.ts'),
    ),
    ts.ScriptTarget.Latest,
    true,
  );
  const functions = conversion.statements.filter(ts.isFunctionDeclaration);
  const build = functions.find(
    (node) => node.name.text === 'buildArticleMarkdown',
  );
  const rest = build.body.statements.filter(
    (node) =>
      !ts.isVariableStatement(node) ||
      !node.declarationList.declarations.some(
        (decl) => decl.name.getText(conversion) === 'mediaUnconfirmed',
      ),
  );
  assert.equal(
    tokens(rest.map((node) => node.getText(conversion)).join('\n')),
    pins.articleExportConversion,
  );
  const predicate = functions.find(
    (node) => node.name.text === 'mediaUnconfirmedInDocument',
  );
  assert.equal(
    tokens(
      predicate.body.statements
        .map((node) => node.getText(conversion))
        .join('\n'),
    ),
    pins.articleExportPredicate,
  );
});
test('the reviewed export dialog and production reading layout retain their approved snapshot', () => {
  const file = 'apps/web/src/pages/feeds/index.tsx';
  const ast = ts.createSourceFile(
    file,
    read(file),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const feeds = ast.statements
    .flatMap((node) =>
      ts.isVariableStatement(node)
        ? [...node.declarationList.declarations]
        : [],
    )
    .find((node) => node.name.getText(ast) === 'Feeds');
  const returned = feeds.initializer.body.statements.find(ts.isReturnStatement);
  // This snapshot includes the authorized unified export dialog. The server,
  // startup and data contracts above remain pinned to the deployment baseline.
  function shape(node) {
    if (
      ts.isExpressionStatement(node) &&
      node.expression.getText(ast) === 'exportController.current?.abort()'
    )
      return undefined;
    const children = node.getChildren(ast);
    return children.length
      ? [node.kind, children.map(shape).filter((child) => child !== undefined)]
      : [node.kind, node.getText(ast)];
  }
  assert.equal(hash(JSON.stringify(shape(returned))), copyPins.indexLayout);
});

test('automatic AUTH connection inverse preserves exact prior routes and rejects wider authorization', () => {
  const source = read('apps/server/src/trpc/trpc.router.ts');
  const entries = require('./fixtures/xhs-auth-connection-seams.json');
  assert.deepEqual(
    entries.map((e) => e.name),
    ['connectSession', 'restoreSession'],
  );
  restorePreReviewedRecoveryRouter(ts, source);
  for (const entry of entries) {
    for (const [before, after] of [
      [
        'this.trpcService.protectedProcedure',
        'this.trpcService.publicProcedure',
      ],
      ['this.requireLocalXhsConnection(ctx);', 'void ctx;'],
      ['verifyKnownAuthenticationAfterConnection()', 'unreviewedOperation()'],
      ...(entry.name === 'connectSession'
        ? [['input.persist && this.xhsWhole', 'this.xhsWhole']]
        : []),
    ]) {
      assert(entry.after.includes(before));
      assert.throws(
        () =>
          restorePreReviewedRecoveryRouter(
            ts,
            source.replace(entry.after, entry.after.replace(before, after)),
          ),
        /exact approved XHS connection/,
      );
    }
  }
});
