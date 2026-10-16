# Cached export media status

Cached local and ZIP exports distinguish missing body cache, unconfirmed body media, and failed known image sources. A historical body retry failure does not invalidate an existing usable body. Images outside the selected article body do not affect body media status. Source-less or rejected image sources remain unconfirmed; they do not establish a missing-image count or an HTTP status.

Cached local and ZIP adapters explicitly opt into retaining usable body text and successfully obtained images when an allowed image source fails. Strict single-download callers preserve their existing failure and HTTP provenance behavior and do not publish partial success bundles. `mediaComplete=false` remains compatible with existing callers. Additive `mediaStatus` values are `complete`, `missing`, and `unconfirmed`. `missingImageCount` counts distinct allowed source strings that failed during this export, rather than DOM slots or inferred images. Unknown slots can coexist with failed known sources; Markdown retains both warnings in that case. File-system failures and configured image limits still fail the save.

Repeated references to the same source share one download result per export, including failures. Byte limits count each physical image file once. A later explicit save can retry missing sources while reusing receipt-verified files. A previously complete mapped receipt is checked for newly cached image sources before skipping. Supplementary images use the existing companion-note repair path and preserve edited original notes. A complete legacy receipt without source mappings cannot establish current remote-image coverage, including a receipt originally listing zero images: it returns unconfirmed before HTTP and preserves both the note and receipt. Verifiable inline bytes and genuinely incomplete zero-image legacy receipts retain the existing safe repair path. Other conservative legacy repair restrictions remain.

ZIP results keep the existing `incomplete` relative path list and add `incompleteDetails`. Its reason values distinguish `body-not-cached`, `missing`, `unconfirmed`, and `export-failed`. README presents readable reasons. Missing cache does not initiate an original-page request. Browser Markdown exposes source-validation status, but its existing proxy references still require the server; it does not verify remote image bytes or constitute an offline image archive.

Offline verification uses synthetic articles, small temporary image files, and mocked requests:

```sh
pnpm --filter server exec jest --runInBand article-export-status article-export-images-pending article-incremental-export article-local-layout article-export-scope article-local-save article-source-layout article-date-filter article-download-cache
pnpm --filter server exec tsc --noEmit --incremental false
```

No schema migration, collection, bulk export, deployment, or restart is included.
