# Spec 08 — Upstream Sync & PR Contribution Plan

## Overview

| Item | Detail |
|---|---|
| **Upstream repo** | `vieiraae/obsidian-sidekick` |
| **Fork repo** | `JinLee794/obsidian-sidekick` |
| **Fork point** | `3ee3baf` — upstream tag `1.2.1` |
| **Upstream HEAD** | `fd3e3c1` (5 commits ahead of fork point) |
| **Fork HEAD** | `66a7292` (21 commits ahead of fork point) |

---

## Part 1 — Pull upstream changes into the fork

### What upstream added (5 commits since `1.2.1`)

| Commit | Summary |
|---|---|
| `49affa5` | Refactor: simplify disconnect logic, button click handling |
| `2e0348e` | **Elicitation modal** (structured dynamic forms), blob attachments in chat, `onListModels` callback for BYOK, SDK upgrade to 0.2.1, session event refactor (`handleSessionEvent` dispatcher + `earlyEventBuffer`), `agent.select` RPC call |
| `fd5962a` | Revert obsidian dep to 1.12.3 |
| `038d6a3` | Version bump to 1.2.2 |
| `fd3e3c1` | Simplify reasoning effort assignment in configToolbar |

### Upstream-only new files

- `src/modals/elicitationModal.ts` — new modal for structured input
- `tsconfig.json` — config changes (module resolution adjustments)

### Files modified in both fork and upstream (17 files)

These auto-merged cleanly (10):
- `src/bots/telegramBot.ts`
- `src/modals/index.ts`
- `src/settings.ts`
- `src/types.ts`
- `src/view/configToolbar.ts`
- `src/view/inputArea.ts`
- `src/view/sessionConfig.ts`
- `src/view/sessionSidebar.ts`
- `src/view/triggersPanel.ts`
- `styles.css`

These have merge conflicts (6 files, 18 conflict regions total):
| File | Conflicts | Likely cause |
|---|---|---|
| `manifest.json` | 1 | Version string divergence |
| `package.json` | 2 | Version + SDK version |
| `versions.json` | 1 | Version map entries |
| `src/copilot.ts` | 3 | Fork added CLI discovery/diagnostics; upstream changed session creation |
| `src/main.ts` | 5 | Fork heavily extended onload; upstream added model listing |
| `src/sidekickView.ts` | 6 | Both sides refactored session/event handling extensively |

### Recommended merge strategy

1. **Create branch** `sync/upstream-1.2.2` from `main`.
2. **Merge** `upstream/main` into it (`git merge upstream/main`).
3. **Resolve conflicts** file by file:
   - `manifest.json` / `versions.json` — keep fork version scheme (`x.y.z-jinle`), add upstream's `minAppVersion` if changed.
   - `package.json` — take upstream SDK version (`0.2.1`), keep fork-only deps (vitest, etc.), keep fork version string.
   - `src/copilot.ts` — keep fork CLI discovery + diagnostics; integrate upstream `onListModels` and session creation changes.
   - `src/main.ts` — keep fork extensions; integrate upstream model-fetching logic.
   - `src/sidekickView.ts` — **hardest merge**. Upstream refactored `registerSessionEvents` → `handleSessionEvent` dispatcher + `earlyEventBuffer`. Fork decomposed the view into separate panel modules. Need to reconcile the event architecture with the decomposed structure.
4. **Build** (`npm run build`) and **test** (`npm test`) to verify.
5. **Smoke-test** in Obsidian via `npm run deploy:local` + `obsidian plugin:reload id=sidekick`.

### Key integration considerations

- **Elicitation modal**: New upstream feature — should just work since it's a new file + import. Wire it into the fork's view decomposition.
- **Event dispatcher refactor**: Upstream moved from `session.on(...)` per-event to a central `handleSessionEvent` switch. The fork's `bgEvents.ts` and `chatSession.ts` also handle events. Reconcile by adopting upstream's dispatcher pattern in the fork's decomposed modules.
- **SDK 0.2.1**: Upstream bumped from 0.2.0 → 0.2.1. The fork is on 0.2.0. Take the upgrade.
- **Blob attachments**: Upstream added image-paste-as-blob in `inputArea.ts`. Fork also modified `inputArea.ts`. Changes are likely in different regions (fork added tool-approval toggle); should merge cleanly after conflict resolution.
- **`agent.select` RPC**: Upstream explicitly calls `session.rpc.agent.select()` after session creation. Fork should pick this up.

---

## Part 2 — Submit fork changes as PR to upstream

### Fork-only features (candidate PR scope)

The fork adds **significant** functionality across ~60 new/modified files. These should be grouped into **separate, focused PRs** rather than one massive PR.

#### PR 1 — View decomposition & memory leak fixes
**Files**: `src/view/` (actionBars, activeNote, agentMention, bgEvents, builtinCommands, chatSession, contextTracker, promptSlash, types), `src/sidekickView.ts` refactor
**Value**: Breaks the monolithic `sidekickView.ts` into focused modules with proper cleanup. Fixes listener leaks on session reconnect.

#### PR 2 — MCP tooling (probe, editor, tools panel)
**Files**: `src/mcpProbe.ts`, `src/modals/mcpEditorModal.ts`, `src/view/toolsPanel.ts`
**Value**: MCP server management UI — add/edit servers, probe connections, discover tools, per-server diagnostics.

#### PR 3 — Windows CLI discovery & diagnostics
**Files**: `src/platformEnv.ts`, `src/copilot.ts` (cleanEnv, resolveCommandViaPowerShell, diagnoseSetup), `src/settings.ts` (diagnostics button)
**Value**: Fixes Windows PATH issues, adds PowerShell-based binary discovery, adds Settings diagnostics panel.
**Tests**: `tests/cli-init.test.ts` (39 tests)

#### PR 4 — Agent editor & agency config
**Files**: `src/modals/agentEditorModal.ts`, `src/modals/agencyConfigModal.ts`, `src/view/sessionConfig.ts` (agent mention routing)
**Value**: GUI for creating/editing agents and agency configurations.

#### PR 5 — Prompts, skills, and search panels
**Files**: `src/view/promptsPanel.ts`, `src/view/skillsPanel.ts`, `src/view/searchPanel.ts`
**Value**: Dedicated panels for prompt management, skills browsing, and advanced search.

#### PR 6 — Triggers, context builder, vault indexing
**Files**: `src/triggerModal.ts`, `src/triggerScheduler.ts`, `src/contextBuilder.ts`, `src/vaultIndex.ts`, `src/view/triggersPanel.ts`
**Value**: Enhanced trigger management with slash-prompt autocomplete, content diffing, and vault-aware context building.

#### PR 7 — Secure storage & config loader
**Files**: `src/secureStorage.ts`, `src/configLoader.ts`
**Value**: Encrypted storage for secrets, env-var resolution for shared vaults.

#### PR 8 — Ghost text improvements & editor menu
**Files**: `src/editor/ghostText.ts`, `src/editor/editorMenu.ts`
**Value**: Smart truncation, improved autocomplete UX.

#### PR 9 — Test infrastructure
**Files**: `vitest.config.ts`, `tests/__mocks__/`, `tests/fix*.test.ts`, `tests/shared-config-utils.test.ts`
**Value**: Vitest setup, mocks for obsidian + copilot-sdk, regression tests.

### PR preparation checklist

Before submitting any PR:

- [ ] Rebase fork changes onto latest `upstream/main` (after Part 1 sync)
- [ ] Ensure each PR branch builds cleanly (`npm run build`)
- [ ] Ensure tests pass (`npm test`)
- [ ] Remove fork-specific version suffixes (`-jinle`) from PR branches
- [ ] Remove fork-specific files from PRs: `deploy-local.*`, `AGENTS.md`, `_specs/`, `docs/`, `.github/skills/`
- [ ] Write clear PR description linking the relevant spec if applicable
- [ ] Keep PRs independent — each should be mergeable on its own

### PR ordering recommendation

Start with foundational changes that other PRs depend on:

1. **PR 9** (test infrastructure) — no deps, enables CI for subsequent PRs
2. **PR 3** (Windows CLI) — standalone, high-value bug fix
3. **PR 7** (secure storage) — standalone utility
4. **PR 1** (view decomposition) — prerequisite for PRs 2, 4, 5
5. **PR 6** (triggers/context) — depends on some view decomposition
6. **PR 2** (MCP tooling) — depends on view decomposition
7. **PR 4** (agent editor) — depends on view decomposition
8. **PR 5** (panels) — depends on view decomposition
9. **PR 8** (ghost text) — standalone, low priority

---

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| `sidekickView.ts` merge is complex (6 conflicts, both sides refactored events) | Merge upstream first, then verify all fork panels still wire up correctly |
| Upstream may reject large PRs | Split into focused PRs (see above), start with bug fixes |
| SDK version skew | Sync to upstream's 0.2.1 before submitting PRs |
| Fork-specific conventions (deploy scripts, AGENTS.md) leaking into PRs | Explicit exclusion checklist above |
| Upstream may have diverged further by PR time | `git fetch upstream` before each PR push |
