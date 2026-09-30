#!/usr/bin/env node
// Read-only, aggregate-only audit of links in cached target-account article bodies.
// Usage: node crosslink-graph-offline.cjs <absolute SQLite path>

const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const TARGET_MP_ID = 'MP_WXS_3895431412';
const TARGET_BIZ = 'Mzg5NTQzMTQxMg==';

function targetArticleKey(href) {
  let url;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.hostname !== 'mp.weixin.qq.com' ||
    url.pathname !== '/s'
  )
    return null;
  const fields = ['__biz', 'mid', 'idx', 'sn'];
  if (fields.some((field) => url.searchParams.getAll(field).length !== 1))
    return null;
  const [biz, mid, idx, sn] = fields.map((field) =>
    url.searchParams.get(field),
  );
  if (
    biz !== TARGET_BIZ ||
    !/^\d+$/.test(mid) ||
    !/^\d+$/.test(idx) ||
    !/^[0-9a-fA-F]+$/.test(sn)
  )
    return null;
  return {
    key: [biz, mid, idx, sn].join('\0'),
    pair: [mid, idx].join('\0'),
    url,
  };
}

function increment(object, key, amount = 1) {
  object[key] = (object[key] || 0) + amount;
}

function summarize(dbPath) {
  const cheerio = require(
    require.resolve('cheerio', { paths: [path.dirname(path.dirname(dbPath))] }),
  );
  const db = new DatabaseSync(dbPath, { readOnly: true });
  db.exec('PRAGMA query_only=ON');
  try {
    const integrity = db
      .prepare('PRAGMA quick_check')
      .all()
      .map((row) => Object.values(row)[0]);
    if (integrity.length !== 1 || integrity[0] !== 'ok')
      throw new Error('SQLite quick_check failed');
    const rows = db
      .prepare(
        'SELECT id, verified_source_url, content_html FROM articles WHERE mp_id = ?',
      )
      .all(TARGET_MP_ID);
    const allKnownPairs = new Set();
    for (const row of rows) {
      const article =
        row.verified_source_url && targetArticleKey(row.verified_source_url);
      if (article) allKnownPairs.add(article.pair);
    }

    const aggregate = {
      database: {
        quickCheck: 'ok',
        targetRows: rows.length,
        cachedBodies: 0,
        bodiesWithTargetLinks: 0,
      },
      anchors: {
        hrefTotal: 0,
        targetLongReferences: 0,
        targetHttpReferences: 0,
        targetHttpsReferences: 0,
        targetUniqueFourFields: 0,
        targetUniqueMidIdx: 0,
        pairSnConflicts: 0,
        uniqueTargetsInVerifiedSourceRows: 0,
      },
      source: {
        withVerifiedIdentity: 0,
        linkCountMin: null,
        linkCountMedian: null,
        linkCountMax: null,
        distinctTargetCountMin: null,
        distinctTargetCountMax: null,
      },
      htmlSemantics: {
        parentTags: {},
        nearestBlockTags: {},
        ancestorListItems: 0,
        ancestorHeadings: 0,
        anchorContainsImage: 0,
        anchorHasText: 0,
        anchorHasImageOnly: 0,
        hrefWithScene: 0,
        hrefWithCt: 0,
        hrefWithAlbumId: 0,
        fragmentWechatRedirect: 0,
        bodiesWithAlbumLiteral: 0,
        bodiesWithRelatedArticleLiteral: 0,
      },
      graph: {
        targetReferencedByOneSource: 0,
        targetReferencedByMultipleSources: 0,
        maxDistinctSourcesForTarget: 0,
        referencesToVerifiedArticleRows: 0,
        selfLinks: 0,
        sourcePairsWithAnyTargetOverlap: 0,
        sourcePairsWithHalfOrMoreTargetOverlap: 0,
        identicalOrderedTargetSequences: 0,
      },
    };
    const keyToSources = new Map();
    const pairToSn = new Map();
    const sourceCounts = [];
    const distinctCounts = [];
    const sourceTargets = [];
    const sourceSequences = [];

    for (const row of rows) {
      if (!row.content_html) continue;
      aggregate.database.cachedBodies++;
      if (/album_info_list|appmsgalbuminfo|album_id/.test(row.content_html))
        aggregate.htmlSemantics.bodiesWithAlbumLiteral++;
      if (/related_article_info|related_article/.test(row.content_html))
        aggregate.htmlSemantics.bodiesWithRelatedArticleLiteral++;
      const $ = cheerio.load(row.content_html);
      const anchors = $('a[href]');
      aggregate.anchors.hrefTotal += anchors.length;
      const sourceIdentity =
        row.verified_source_url && targetArticleKey(row.verified_source_url);
      const targets = new Set();
      const sequence = [];
      let references = 0;

      anchors.each((_, element) => {
        const article = targetArticleKey($(element).attr('href'));
        if (!article) return;
        references++;
        targets.add(article.key);
        sequence.push(article.key);
        if (!keyToSources.has(article.key))
          keyToSources.set(article.key, new Set());
        keyToSources.get(article.key).add(row.id);
        if (!pairToSn.has(article.pair)) pairToSn.set(article.pair, new Set());
        pairToSn.get(article.pair).add(article.key);

        const parent = (element.parent && element.parent.name) || 'unknown';
        increment(aggregate.htmlSemantics.parentTags, parent);
        const block = $(element)
          .closest('p,section,div,li,blockquote,h1,h2,h3,h4,h5,h6')
          .get(0);
        increment(
          aggregate.htmlSemantics.nearestBlockTags,
          (block && block.name) || 'none',
        );
        if ($(element).closest('li').length)
          aggregate.htmlSemantics.ancestorListItems++;
        if ($(element).closest('h1,h2,h3,h4,h5,h6').length)
          aggregate.htmlSemantics.ancestorHeadings++;
        const hasImage = $(element).find('img').length > 0;
        const hasText = $(element).text().trim().length > 0;
        if (hasImage) aggregate.htmlSemantics.anchorContainsImage++;
        if (hasText) aggregate.htmlSemantics.anchorHasText++;
        if (hasImage && !hasText) aggregate.htmlSemantics.anchorHasImageOnly++;
        if (article.url.searchParams.has('scene'))
          aggregate.htmlSemantics.hrefWithScene++;
        if (article.url.protocol === 'http:')
          aggregate.anchors.targetHttpReferences++;
        else aggregate.anchors.targetHttpsReferences++;
        if (article.url.searchParams.has('ct'))
          aggregate.htmlSemantics.hrefWithCt++;
        if (article.url.searchParams.has('album_id'))
          aggregate.htmlSemantics.hrefWithAlbumId++;
        if (article.url.hash === '#wechat_redirect')
          aggregate.htmlSemantics.fragmentWechatRedirect++;
        if (sourceIdentity && sourceIdentity.key === article.key)
          aggregate.graph.selfLinks++;
        else if (allKnownPairs.has(article.pair))
          aggregate.graph.referencesToVerifiedArticleRows++;
      });
      if (!references) continue;
      aggregate.database.bodiesWithTargetLinks++;
      if (sourceIdentity) aggregate.source.withVerifiedIdentity++;
      aggregate.anchors.targetLongReferences += references;
      sourceCounts.push(references);
      distinctCounts.push(targets.size);
      sourceTargets.push(targets);
      sourceSequences.push(sequence);
    }

    sourceCounts.sort((a, b) => a - b);
    distinctCounts.sort((a, b) => a - b);
    aggregate.anchors.targetUniqueFourFields = keyToSources.size;
    aggregate.anchors.targetUniqueMidIdx = pairToSn.size;
    aggregate.anchors.pairSnConflicts = [...pairToSn.values()].filter(
      (keys) => keys.size > 1,
    ).length;
    aggregate.anchors.uniqueTargetsInVerifiedSourceRows = [
      ...pairToSn.keys(),
    ].filter((pair) => allKnownPairs.has(pair)).length;
    aggregate.source.linkCountMin = sourceCounts[0] ?? null;
    aggregate.source.linkCountMedian =
      sourceCounts[Math.floor(sourceCounts.length / 2)] ?? null;
    aggregate.source.linkCountMax = sourceCounts.at(-1) ?? null;
    aggregate.source.distinctTargetCountMin = distinctCounts[0] ?? null;
    aggregate.source.distinctTargetCountMax = distinctCounts.at(-1) ?? null;
    aggregate.graph.targetReferencedByOneSource = [
      ...keyToSources.values(),
    ].filter((sources) => sources.size === 1).length;
    aggregate.graph.targetReferencedByMultipleSources = [
      ...keyToSources.values(),
    ].filter((sources) => sources.size > 1).length;
    aggregate.graph.maxDistinctSourcesForTarget = Math.max(
      0,
      ...[...keyToSources.values()].map((sources) => sources.size),
    );
    for (let i = 0; i < sourceTargets.length; i++) {
      for (let j = i + 1; j < sourceTargets.length; j++) {
        const intersection = [...sourceTargets[i]].filter((key) =>
          sourceTargets[j].has(key),
        ).length;
        if (intersection > 0) aggregate.graph.sourcePairsWithAnyTargetOverlap++;
        if (
          intersection /
            (sourceTargets[i].size + sourceTargets[j].size - intersection) >=
          0.5
        )
          aggregate.graph.sourcePairsWithHalfOrMoreTargetOverlap++;
        if (
          sourceSequences[i].length === sourceSequences[j].length &&
          sourceSequences[i].every(
            (key, index) => key === sourceSequences[j][index],
          )
        )
          aggregate.graph.identicalOrderedTargetSequences++;
      }
    }
    return aggregate;
  } finally {
    db.close();
  }
}

if (require.main === module) {
  const dbPath = process.argv[2];
  if (!dbPath || !path.isAbsolute(dbPath)) {
    process.stderr.write(
      'Usage: node crosslink-graph-offline.cjs <absolute SQLite path>\n',
    );
    process.exitCode = 2;
  } else {
    try {
      process.stdout.write(`${JSON.stringify(summarize(dbPath), null, 2)}\n`);
    } catch (error) {
      process.stderr.write(`offline_audit_failed: ${error.message}\n`);
      process.exitCode = 1;
    }
  }
}
