# Changelog

All notable changes to bg-promises will be documented in this file.

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Fixed
- `npm test` now runs both `auto-injection.test.ts` and `corner-cases.test.ts`
- Manual no longer references removed `promise-block-until-complete` tool
- Manual corrected: 8 tools → 7, curl → native fetch, hardcoded paths → relative
- Manual line count updated to match current source (~2690 lines)

### Removed
- `promise-block-until-complete` documentation from manual (tool was removed from source)

## [1.0.0] - 2026-06-17

### Added
- **Promise system** — `promise-create`, `promise-then`, `promise-status`, `promises-list`, `promise-graph`, `promise-rechain`, `promise-cancel`
- **Chaining** — sequential pipeline execution via `then` parameter and `promise-then`
- **Conditional chains** — `always`, `on-success`, `on-failure` conditions on chained promises
- **Child pre-creation** — eliminates race condition when chaining at creation time
- **Dedup & replace** — `dedup` reuses existing promise, `replace` cancels and restarts
- **Download support** — native `fetch()` with progress tracking and stall detection
- **Tmux integration** — commands run in tmux sessions for live user inspection
- **Progress tracking** — animated block-bar progress in TUI footer
- **Status messages** — last stdout line shown in footer during execution
- **TUI status bar** — compact chain view + expanded widget (F4 toggle)
- **State persistence** — promises survive pi reloads via disk-backed state
- **Orphan cleanup** — stale tmux sessions killed on startup
- **Intent parameter** — LLM specifies what to do after promise completes
- **Cancel cascade** — cancelling a parent cascades to pre-created children
- **Post-hoc chaining** — `promise-then` works on completed promises

### Fixed
- Race condition eliminated via child pre-creation at `promise-create` time
- TUI crash from un-truncated long render lines
- Orphan tmux sessions from previous pi loads
- State file persistence scoped per-session to avoid cross-instance conflicts
- Notification suppression for explicitly awaited promises

### Changed
- Replaced `curl` dependency with native `fetch()` for downloads
- Notification delivery redesigned so LLM acts on results instead of disengaging
- Prompt guidelines enforce never-block philosophy (`promise-block-until-complete` removed)

## [0.1.0] - 2026-05-XX

### Added
- Initial release: `promise-create`, `promise-status`, `promises-list`, `promise-cancel`
- Download support with progress tracking
- Basic chaining via `then` parameter at creation
