# DOM candidate reading after user-assisted frame confirmation

2026-10-06. User-assisted read-only observation confirmed: article content is in the first-level readable `iframe.mp_i_frame.fontLevel2`, with empty iframe id and `srcdoc`; `#js_content`, `#activity-name`, and `#js_name` exist inside the frame and not in the main document. No reload, click, network request, secret or application-state read was performed by this reviewer. The installed MAIN probe separately found no `__vue__` on the selected reader root. That invalidates this root's current projection locator, not all page business data.

## Implemented interface

Later source update: page-supplied og:url/msg_link now use bounded static extraction and strict URL/identity agreement, including numeric mid/idx and internally consistent timestamps. An internal per-article owner-confirmed adapter and one-shot broker mode are described in [CONFIRMED_DOM_ARTICLE_ADAPTER.md](CONFIRMED_DOM_ARTICLE_ADAPTER.md). Empty image-node counts and a page-level loading message are not universal completeness rules. No production activation, installation or live capture followed this source update.

`captureOfficialArticle({ candidateOnly: true })` reuses the existing bounded srcdoc/body/static-scalar sanitizer. Selection is the unique `iframe.mp_i_frame[srcdoc]`; no id or Vue dependency. This serialized ISOLATED-world function has no imported runtime dependency.

Candidate mode returns local untrusted sanitized `html`, presence flags and image descriptors `{index, kind, loaded}`. It omits absent title/source/canonical metadata rather than manufacturing it. Static scalar whitelist remains biz/mid/idx/sn/ct/create_time; conflicting assignments stop. Body images use `wewe-image:<index>` placeholders. It neither copies inline bytes nor fetches remote/Blob bytes. Original page scripts, handlers and body URL attributes are excluded. The page-supplied `og:url` value is retained after HTML escaping; its presence does not validate its host, query or article mapping. It must pass the existing independent URL and identity checks before any downstream use. Origin/path, frame/body uniqueness, challenge/unsupported media, 15M-character srcdoc, 60-image and 5MB sanitized-body limits remain enforced.

The return explicitly marks articleIdentity unverified, reviewBinding unavailable, upstreamCompleteness unproved and imageBytes unverified. Presence flags do not establish valid identity/time/canonical mapping. Local HTML is private article data: do not display/dump it or log the result. This candidate is not a ProviderArticle or an accepted save payload.

Default `captureOfficialArticle()` retains existing transport behavior and required identity fields. No caller is changed to invoke candidate mode automatically. `task-client.mjs` still requires its independent projection before collection/completion. `probe.mjs` and popup remain unchanged. Their old Vue gate is not a prerequisite of the new candidate API, but remains a blocker for task transport. This is an offline-testable reading implementation, not a new installed diagnostic or a completed download feature.

## One consolidated evidence gap list

Before an unknown article can enter the current Provider/saveVerifiedArticle path, the remaining real evidence must establish:

1. Genuine biz/mid/idx (and sn where present), conflicting-field checks, publisher identity and a genuine article publish timestamp in this exact frame's static source. Displayed date or title alone is insufficient.
2. A page-supplied canonical URL and its association to the requested article, especially an opaque short URL. No synthesized canonical or cached-body match can supply this mapping.
3. Genuine current article/directory association (book/review/original identifiers or an independently verified candidate). Old public catalog rendering uses click closures, not identity DOM attributes; no alternate current locator has been proved. Do not traverse arbitrary application state.
4. What establishes the returned article's complete upstream body; three existing nodes/nonempty DOM/body fingerprints establish no such proof. Detect truncated/challenge/unsupported content conservatively.
5. Actual original image bytes, signatures, all referenced-image coverage and successful existing local save/export. Loaded images only establish display state; candidate mode verifies no bytes.

These are requirements to collect together under any later explicitly authorized bounded verification, not instructions for this reviewer to perform another live probe. Parent already obtained the DOM structural answer; do not ask the user to repeat it.

## Offline evidence and file ownership

28/28 extension tests passed, including no-Vue/empty-id/class/srcdoc reading, no network or Blob access, missing identity/canonical preserved, unloaded CDN descriptors, challenge/conflicting scalar/frame/body ambiguity/size refusal, plus all previous transport and popup tests. Synthetic fixtures contain no real article content and are not real-site acceptance.

Changes are limited to `extensions/wewe-official-task/capture.mjs`, its `dom-harness.test.mjs`, README, and this document. No server/module/main, permissions, installed package or production write. Nine packaged root runtime files are unchanged in count; no new runtime file was introduced. The already reviewed 0.1.2 ZIP stays byte-for-byte unchanged; no new ZIP/version or installation is offered for this internal candidate API.

Saved public bundle evidence: `19.42e251bc.js` SHA256 `85bea05005a543894c346a39cae5a234b9d77de322316b3a80e87de809af3a3e`. Zero-based text-character offsets: 460123 iframe srcdoc decoder 0x29c resolves to mpRawData; 452020 content modifier appends display helpers and closing HTML; 462504 catalog render passes review objects through click closures. Only literal string-table arithmetic was decoded, not bundle execution. This old bundle supports the candidate source design, not the current article's identity or completeness.
