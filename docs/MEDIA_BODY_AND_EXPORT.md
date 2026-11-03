# Large saved bodies and offline image export

The automatic media writeback ceiling remains 8,000,000 bytes. This limits database HTML growth, not the size of a Markdown/Obsidian export. A body that would cross this ceiling is retained unchanged and is not retried by increasing the limit.

A saved body larger than the writeback ceiling is no longer automatically counted as failed media. The bounded scanner inspects one oversized body at a time, up to the existing 32,000,000-byte saved-media inspection ceiling. It verifies inline image containers and unsupported media markers before removing a stale limit failure. A saved status alone is insufficient evidence. Larger or unprovable bodies stay explicitly limited/unconfirmed; oversized HTML is never passed to the automatic writer.

Existing Markdown conversion already writes valid embedded images to separate local attachment files. It needs no automatic writeback or source request to export a large fully embedded article. Local cached-article export now also checks the existing automatic-media cache before its existing image acquisition fallback. Cache URLs, keys, decoded bytes and SHA256 are validated; directory aliases and unsafe files remain rejected. Reading cache data changes no queue, source budget or safety state.

Verified cache bytes become ordinary relative image attachments through the existing publisher. This avoids inflating the database HTML again. Uncached sources follow the existing export policy and produce missing/unconfirmed receipts when unavailable; unknown slots or unsupported media are not certified complete. A corrupted cache is not repaired by silently fetching over it. Existing per-export image limits, stable paths, repeat-save receipts and manual-edit protections remain effective.

Offline acceptance checks actual PNG attachment bytes and relative Markdown links, fully embedded bodies over the automatic threshold, projected writeback rejection with successful cached-image export, unknown and corrupted media, repeat-save manual edits, and persisted scan status. All fixtures are synthetic and use no real upstream request.
