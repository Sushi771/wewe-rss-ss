# Subscription submission and cache recovery

The Wechat2RSS batch submits valid links serially, with a minimum five-second spacing. An accepted response is persisted before a local publisher record is created. The response's numeric feed identity is checked; an unknown publisher name remains pending instead of being guessed.

Acceptance releases the next queued link. Article identity checks, body/image archival and publisher metadata run separately through the existing continuation. A failed cache read or an isolated legacy article must not prevent the remaining authorized links from being submitted. The progress display separates upstream acceptance from completed content synchronization.

Every new submission keeps the existing account preflight, verified SQLite backup and one-shot receipt guard. An unavailable account, rejected submission or uncertain result without an accepted receipt pauses unsent work. Status reads cannot resubmit. Explicitly stopped batches remain stopped; resuming an active paused batch checks accepted cache work and sends only its remaining queued inputs.

Existing cache reads do not require an available collection account. Cache authorization and article identity still apply. Unverified legacy collisions remain isolated, with old text and images preserved; other verified articles can be imported. This is partial coverage, not a claim that every article is complete.

The original feed-list refresh applies a successful publisher list before refreshing secondary article views. A secondary article-query failure no longer discards that list. A failed publisher-list query remains visible as an error.

Offline regressions cover six saved inputs with one accepted cache failure, restart, serial submission, uncertain acceptance, account restriction, explicit stop, legacy identity isolation and secondary view failure. Real upstream acceptance, real article completeness and a user's single-article choice remain separate acceptance checks.
