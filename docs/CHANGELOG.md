# Changelog

All notable changes to the WeWe-RSS project will be documented in this file.

## [2026-03-30] - UED/UI Optimization (Quartz Refactor)

### Added
- Created `UserIcon.tsx` component for the navigation bar.
- Added `docs/CHANGELOG.md` for project history.

### Changed
- **Typography**: Increased sidebar item font size to **16px** and headers to **14px** for enhanced legibility.
- **Navigation**: Moved "Account Management" to a dedicated **user icon button** in the top-right toolbar, separating configuration from content navigation.
- **Article List**: Redesigned the table layout to group "**公众号 · 发布时间**" into a unified metadata column, improving visual flow and reducing "spreadsheet-like" clutter while preserving table headers.
- **Layout**: Refined alignment between the article list and the main toolbar (removed container padding offsets).

### Fixed
- Vertical alignment of toolbar elements and article header title.
- Disparity between the development and production UI (port 5173 vs 4000).
