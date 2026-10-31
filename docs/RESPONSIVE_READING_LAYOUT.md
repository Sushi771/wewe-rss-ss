# Responsive reading layout

This frontend change starts at `f8fbb3c740417fece3d018e919523b7605a3f1dc`.
It changes presentation in the shared WeChat and Xiaohongshu reading workspace;
it does not change collection requests, archive schemas, task ownership or export semantics.

The previous route limited all pages to a centered 1280px box. A 768px viewport
breakpoint also opened a 260px source column even when the remaining reading
column could not fit its controls. The WeChat navigation item disappeared below
640px. Date controls and repeated row status text used additional vertical space.

The route now uses the available width. CSS container queries keep the 260px
source column at workspace widths of at least 1100px. Below that width the
existing source selector and expandable management/group region remain available.
The active group stays visible when management is collapsed. Article rows use a
compact title/metadata grid below a reading-column width of 900px and aligned
metadata above it. Long titles and exceptional states grow naturally. Cached
body status stays accessible to assistive technology and in the reading action's
label; missing-body warnings and retry controls remain visible.

The existing date component uses a native disclosure. Its summary always shows
the selected date range and validation errors, even while collapsed. Calendar
controls remain mounted, so changing width cannot reset a date or close a reader.
Further numeric conditions can use an adjacent disclosure in the same content
area, with their active-condition summary visible; no data fields are introduced
by this change. Keep new controls in normal flow and preserve the existing
selection-clearing rules when the actual query scope changes.

`content-article-row` is positioned relative so visually hidden status text stays
inside the row's own scroll clipping. Without this, absolute hidden text could
extend the reading pane and produce an extra scrollbar.

## Verification

Build before running the compiled product fixture:

```powershell
pnpm --filter web lint
pnpm --filter web build
node scripts/responsive-layout-browser.test.cjs
node --test scripts/article-date-shortcuts-browser.test.cjs scripts/feed-sidebar-layout.test.cjs scripts/subscription-dialog-layout.test.cjs
node --test scripts/feed-refresh-state-ui.test.cjs scripts/feed-reading-ui.test.cjs scripts/feed-export-date-ui.test.cjs scripts/article-date-shortcuts.test.cjs scripts/article-body-state.test.cjs scripts/feed-browse-state.test.cjs
```

The responsive fixture serves the actual compiled frontend with synthetic GET
responses, a fresh headless browser profile and upstream hostname resolution
disabled. It checks both sources at 390/640/790/1024/1440/1660px, heights 540/900,
and scale 1/1.25. Scale 1.25 is modeled as the equivalent CSS viewport and DPR;
this is not a check of a user's installed Edge zoom preference or side-panel UI.
It records geometry and synthetic screenshots and verifies pointer hit targets,
date summary, selection across two loaded batches, resize while reading, and
More/export dialogs. It never starts the backend or copies a database.

The focused regression tests cover filter identity, export scopes, cancellation,
and update progress. Changing an actual source or filter retains its established
scope/selection rules; viewport changes alone do not clear selection or reading.

On the synthetic 790×900 viewport at scale 1, the WeChat list starts at y=294
with 606px available; the Xiaohongshu list starts at y=331 with 569px available.
Both use 64px normal rows. On a 1660px workspace, the source column remains
260px and normal rows are 56px. These measurements describe synthetic fixtures,
not a claim about the original user's subscriptions or current task messages.

The two user Library screenshot references could not be materialized on Windows:
the current official helper downloads bytes but then calls unsupported
`os.setxattr`. No unverified downloaded file is used as evidence. The original
failure description and source analysis ground this change; synthetic screenshots
verify the result. Production deployment and real Edge side-panel acceptance are
separate steps and have not been performed here.
