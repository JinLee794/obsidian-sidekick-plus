# Changelog

All notable changes to the Sidekick plugin are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).
## [1.2.9-jinle] - 2026-05-10

### Added

- **Tool approval toggle in chat input**: Added a quick-toggle button at the bottom of the chat input area to switch between "Auto-approve tools" and "Ask before tools" modes without navigating to settings.
## [1.2.7-jinle] - 2026-05-09

### Fixed

- **Windows compatibility for CLI auth flows**: Standardized subprocess environment setup so `gh`, `az`, and agency tooling resolve correctly on Windows. Fixed PATH delimiter handling (`;` on Windows vs `:` on macOS/Linux), home-directory lookup (`USERPROFILE` fallback), and Windows executable resolution with `.exe` suffix.
- **Cross-platform process spawning**: Updated CLI execution paths to use Windows-safe spawn options for auth and probing operations, reducing failures when running in Electron on Windows.
- **Absolute path construction on Windows**: Replaced several string-concatenated filesystem paths with `path.join`-based joins for plugin directory, attachment paths, and working-directory resolution.

### Added

- **`platformEnv` helper module** (`src/platformEnv.ts`): Centralized OS-aware PATH, executable suffix, home-directory, and spawn-env logic used across Copilot, MCP probing, and tools auth refresh flows.

## [1.2.6-jinle] - 2026-04-05

### Changed

- **Delegate orchestration to SDK**: Removed manual MCP tool catalog and skill catalog injection from the system message. The Copilot SDK now discovers tools and skills automatically from `mcpServers` and `skillDirectories` config — no duplicate catalog needed.
- **SDK-native agent routing**: Removed the blocking `triageRequest()` LLM call that ran before every first message. Agent routing is now handled by the SDK via `customAgents[]` with `infer: true`. The "Automatic agent routing" setting controls the `infer` flag.
- **Session resume on config changes**: `ensureSession()` now calls `resumeSession()` with updated config instead of tearing down and recreating the session. Falls back to `createSession()` only if resume fails. Preserves conversation context across config changes (model switch, tool toggle, etc.).
- **Shared background event handler** (`bgEvents.ts`): Extracted the ~80-line background session event wiring (previously copy-pasted in `sidekickView.ts` and `sessionSidebar.ts`) into a single reusable `registerBackgroundEvents()` utility with a `BgEventCallbacks` interface for host-specific side-effects.
- **Shared session config utilities**: Extracted `buildExcludedTools()` and `buildSystemParts()` as pure functions in `sessionConfig.ts`. Both `buildSessionConfig` (chat) and `buildSearchSessionConfig` (search) now call these instead of duplicating logic. Search mode now also respects agent-level `excludeTools`.
- **Simplified MCP tool discovery**: Replaced the polling retry loop in `scheduleSdkToolDiscovery` (3 attempts × 5s) with a single delayed call. Tool discovery is now primarily event-driven via `handleMcpSessionEvent` on server connect.
- **Lightweight skill/tool awareness hint**: System message includes a one-line nudge ("Skills and MCP tools are registered for this session") instead of the former full catalog dump.
- **Prompt template cleanup**: Removed the hacky `"Do not invoke any skills for this request"` text injection when using `/prompt` templates. The `skipSkills` config flag handles this at the SDK level.

### Added

- **Test infrastructure**: Added vitest with 64 tests across 5 files covering all refactored code — `buildExcludedTools`, `buildSystemParts`, `registerBackgroundEvents`, session resume logic, triage removal, and source-level regression checks.
- **Architecture diagram** (`docs/orchestration-diagram.html`): Interactive HTML visualization of the full agent orchestration pipeline — config loading, message flow, system message assembly, SDK events, data shapes, and a debug checklist.

## [1.2.5-jinle] - 2026-04-04

### Fixed

- **Memory leak prevention**: Introduced scoped components for rendered messages to prevent orphaned child components across session transitions and clears. Added explicit cleanup methods called on session clear and switch.

### Changed

- **MCP probe refactor** (`mcpProbe.ts`): Cleaner agency CLI integration with improved binary resolution logic.
- **Search panel** (`searchPanel.ts`): Handles additional metadata fields and improves file resolution robustness.
- **Session sidebar** (`sessionSidebar.ts`): Minor improvements to tab management and display.
- **Settings**: Added agency CLI integration toggle to plugin settings.
- **Styles**: Improved tab management and overflow handling in the chat UI.

## [1.2.4-jinle] - 2026-04-02

### Added

- **Agency CLI integration**: Auto-discovers all MCP services available through the [agency CLI](https://aka.ms/agency) (mail, calendar, teams, planner, sharepoint, word, m365-copilot, m365-user, ado, enghub, icm, kusto, and more) and makes them available as toggleable MCP servers with full tool discovery.
- **Dedicated Agency tab**: Agency services now have their own tab in the sidebar (building-2 icon) separate from MCP Tools, with settings gear, refresh, and per-service toggles.
- **Dedicated Agents tab**: Agent tool mappings moved to their own tab (bot icon) for a cleaner UI. Tab bar now has 6 tabs: Chat, Triggers, Search, Tools, Agency, Agents.
- **Agency config modal**: Settings gear opens a guided modal to pick which agency services to show and which to auto-enable on startup. Saves to `sidekick/tools/agency.md`.
- **`agency.md` configuration file**: YAML frontmatter controls service whitelist (`services`) and auto-enable list (`enabled`). Supports the same frontmatter parser as agents and prompts.
- **Agent365 proxy rewrite**: MCP servers using agent365 URLs in `mcp.json` are transparently proxied through agency CLI with EntraID auth injection when agency is installed.

### Fixed

- **Agency servers now auto-enable on startup**: The `agency.md` `enabled` list is respected across all code paths — initial load, config reload, agent selection, and agent deselection. Previously, `applyAgentToolsAndSkills` would overwrite agency toggle state.
- **ENOENT spawn errors**: Agency binary path is now resolved via filesystem scan (`fs.accessSync`) instead of `which`, which doesn't work reliably in Electron.
- **Tool discovery responsiveness**: All panel renders are now unconditional (no `activeTab` gating), so tool discovery results appear immediately regardless of which tab is visible. Probing starts at plugin startup, not on first tab view.

## [1.2.3-jinle] - 2026-04-02

### Fixed

- **Subagent failure loop**: when a subagent (e.g. M365) cannot access its required tools, the orchestrator now reports the failure to the user instead of re-invoking the same subagent repeatedly or spawning additional subagents to retry.

## [1.2.2-jinle] - 2026-04-01

### Added

- **Encrypted secure storage** (`secureStorage.ts`): AES-256-GCM encryption at rest for all secrets stored in Obsidian's localStorage. Key derived via PBKDF2 from machine hostname, OS username, and vault path — copying app-data to another machine is useless. Legacy unencrypted values are transparently re-encrypted on next save.
- **Environment variable references** for secret fields: enter `$GITHUB_TOKEN` or `${OPENAI_API_KEY}` instead of a literal token — resolved from `process.env` at runtime, never persisted to disk. Recommended for shared or synced vaults (OneDrive, iCloud, etc.).
- **Updated settings UI**: all token/key fields now show `$ENV_VAR` placeholder hints and "Encrypted locally" descriptions.

### Changed

- MCP password-flagged input variables now use the same encrypted storage layer instead of raw localStorage.
- Provider API key and bearer token resolved through `resolveEnvRef()` at every consumption point (`sessionConfig.ts`, `settings.ts` model test, `main.ts` Copilot init).
- Telegram bot token resolved through `resolveEnvRef()` before connect.

## [Unreleased - Jin Lee]

### Added

- **Rich handoff support** for agents — matching the VS Code Copilot custom agent spec. Each handoff defines a `label`, target `agent`, optional `prompt` (with YAML block scalar support), `send` (auto-submit), and `model` override. Handoff buttons render as interactive suggestions after an agent's chat response completes.
- **Agent editor modal** (`agentEditorModal.ts`): Visual form-based editor for `.agent.md` files with intelligent suggestions — model dropdown populated from GitHub Copilot, toggleable tool/skill chips, structured handoff card editor with agent autocomplete, and live markdown generation on save.
- **Agent editor access points**: Pencil icon in chat toolbar, "+" button in Tools tab agent section, pencil-on-hover for each agent in Tools tab, and contextual "Edit agent" button when viewing a `.agent.md` file in the editor.
- **`HandoffConfig` type** (`types.ts`): Structured interface for handoff definitions with `label`, `agent`, `prompt`, `send`, and `model` fields.
- **`parseHandoffsBlock()`** in `configLoader.ts`: Dedicated YAML parser for structured handoff blocks supporting both simple string lists and rich object syntax with block scalars.

### Changed

- **Agent sub-agent roster** now filtered by `handoffs` when defined — agents can restrict which other agents they delegate to. Handoff prompts are injected into the delegation context.
- **Tools panel agent list** restructured as clean card layout — name + edit button on top row, description truncated on its own line below, tool tags wrapped underneath. All containers clip overflow properly.
- **Vault index** (`vaultIndex.ts`): Local metadata-based scoring using Obsidian's metadataCache — filename, aliases, tags, headings, links, backlinks, and recency — with no LLM calls
- **Context builder** (`contextBuilder.ts`): Multi-phase context assembly with metadata scoring, graph boost, de-duplication, token budget allocation, and excerpt extraction; specialised methods for chat queries, trigger firing, and ghost-text completions
- **Trigger modal** (`triggerModal.ts`): Guided UI for creating triggers with 10 cron presets, prompt quality validation, glob/cron mode, and icon/agent/model pickers
- **Content diffing in trigger scheduler**: Hash-based change detection with snapshots (200 max, 30-min TTL), glob-to-regex caching, and ReDoS-safe pattern conversion
- **Deploy script** (`deploy-local.sh`): Automated local build, vault path resolution, artifact copy, and optional CLI-based plugin reload
- **Specification docs** (`_specs/`): Six-phase context intelligence roadmap (P1–P6) with dependency graph and design principles
- **Architecture documentation** (`docs/architecture.md`): Module dependency map, entry-point pathways, and sequence diagrams for chat, session, and trigger flows

### Changed

- **Trigger scheduler** now carries `TriggerFireContext` (changed file path + content) and uses 60-second polling with 5-field cron parsing
- **Settings** expanded with `contextMode`, `searchAgent`, `searchMode`, `agentTriage`, `triggerLastFired`, and `reasoningEffort` options
- **Types** extended with `TriggerConfig` interface (cron/glob, agent/model override, icon, enabled state)
- **Sidekick view** integrates vault index, context builder, and trigger scheduler; adds `sessionContextPaths`, context suggestion system, and selection polling
- **Ghost-text** enhanced with context-aware completions using linked-file summaries, 400 ms debounce, minimum line-length checks, and CodeMirror 6 decorations
- **Main plugin** wires up Copilot service, ghost-text extensions, and editor/file context menus during `onload`
- **Copilot service** adds `resolveGhToken()` for GitHub CLI token extraction with platform-specific binary resolution and environment sanitisation
- **README** updated with expanded documentation

## [1.2.1] - 2026-03-13

### Fixed

- Linting issues

### Changed

- Updated README with table of contents, CLI tools, and enhanced bot configuration details

## [1.2.0] - 2026-03-13

### Added

- Telegram bot integration with configuration and message handling

### Changed

- Refactored code for improved modularity
- Updated warning message text for consistency in settings

## [1.1.0] - 2026-03-12

### Added

- Settings tab UI enhancements

### Changed

- Reorganized README sections for clarity and removed redundant preview content

## [1.0.1] - 2026-03-10

### Fixed

- Linting issues and updated dependencies

## [1.0.0] - 2026-03-10

### Added

- EditModal for advanced text editing with AI and shared task definitions
- ESLint configuration with custom rules for UI text formatting

### Fixed

- Placeholder text for consistency and clarity across modals and settings
- Regex for directory traversal validation in file paths
- Manifest description for clarity

### Changed

- UI text to use sentence case for consistency across notices
- Streamlined debug logging and improved type handling
- Stricter TypeScript configuration for better error handling

## [0.6.0] - 2026-03-03

### Changed

- Plugin guidelines fixes
- Updated manifest with detailed description and author information

## [0.5.0] - 2026-03-03

### Added

- Ghost-text autocomplete feature with gutter indicator
- BYOK (Bring Your Own Key) support with enhanced provider configuration
- Apache License 2.0
- Remote connection support for CopilotService

### Changed

- Updated README to clarify desktop requirements
- Improved installation instructions and CLI verification steps

## [0.1.0] - 2026-02-27

### Added

- Initial release
- Sidekick chat view with folder picker and message metadata display
- Collapsible tool call blocks in chat view
- Tool approval modal and settings for tool invocation permissions
- Folder tree modal and attachment handling with absolute paths
- Editor context menu actions for text manipulation
- Active note tracking and display
- Session sidebar with session management
- Prompt management with loading, selection, and dropdown UI
- Trigger management system with cron and file change support
- Error handling for stale session in message sending
