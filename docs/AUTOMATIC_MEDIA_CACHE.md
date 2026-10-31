# Automatic media cache and large article bodies

The automatic media lane separates acquiring an already queued image from
embedding it into the stored article body. If embedding reaches the existing
8,000,000-byte body limit, `MEDIA_BODY_LIMIT` continues to report the writeback
failure. The worker may finish caching only the image URLs already associated
with the unchanged, verified saved article. It does not enlarge discovery scope,
increase the body limit, or mark the article fully repaired.

Cache acquisition retains the existing one-request-per-tick limit, one-second
start gap, persisted 120-request hourly window, four attempts per resource and
retry backoff. Download settings, source safety stops, the 128MB cache ceiling,
14MB pre-request reservation and 4GiB disk reserve remain enforced. Restart
reuses validated cached bytes without downloading them again. Closing a worker
prevents subsequent dispatch and body writes; an already successful response may
still be cached for the next worker. A changed article snapshot is rechecked
before further acquisition, and identity failures remain stopped.

Markdown/Obsidian export already reads verified cache bytes into independent
local attachments with relative references. This avoids inflating the database
body and preserves the existing attachment limits and manual-edit protection.
Cache completion alone does not certify body writeback or export completion.
Missing or unconfirmed image slots without a trustworthy source URL stay
unconfirmed; the worker neither invents URLs nor removes those markers.
