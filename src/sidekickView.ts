import {
	ItemView,
	WorkspaceLeaf,
	Notice,
	normalizePath,
	setIcon,
	Component,
	TFile,
	Menu,
	Modal,
} from 'obsidian';
import type SidekickPlugin from './main';
import type {
	CopilotSession,
	SessionConfig,
	SessionMetadata,
	ModelInfo,
	MessageOptions,
	PermissionRequest,
	PermissionRequestResult,
	ReasoningEffort,
} from './copilot';
import type {AgentConfig, SkillInfo, McpServerEntry, McpInputVariable, McpToolInfo, PromptConfig, TriggerConfig, ChatMessage, ChatAttachment, SelectionInfo, ContextSuggestion, AgencyConfig} from './types';
import {loadAgents, loadSkills, loadMcpServers, loadAgencyConfig, loadPrompts, loadTriggers, loadInstructions} from './configLoader';
import type {InputResolver} from './configLoader';
import {getAgentsFolder, getSkillsFolder, getToolsFolder, getPromptsFolder, getTriggersFolder, getMcpInputValue, setMcpInputValue, McpInputPromptModal} from './settings';
import {TriggerScheduler} from './triggerScheduler';
import {VaultIndex} from './vaultIndex';
import {ContextBuilder} from './contextBuilder';
import {registerBackgroundEvents as registerBgEvents} from './view/bgEvents';
import {ToolApprovalModal} from './modals/toolApprovalModal';
import {FolderTreeModal} from './modals/folderTreeModal';
import {debugTrace, setDebugEnabled} from './debug';
import type {BackgroundSession} from './view/types';
import {buildProviderConfig} from './view/sessionConfig';
import {probeMcpServer, enrichServersWithAzureAuth, discoverAgencyServers, isAgencyService, primeAgencyCache} from './mcpProbe';

export const SIDEKICK_VIEW_TYPE = 'sidekick-view';

// ── Sidekick view ───────────────────────────────────────────────

export class SidekickView extends ItemView {
	plugin: SidekickPlugin;

	// ── State ────────────────────────────────────────────────────
	messages: ChatMessage[] = [];
	currentSession: CopilotSession | null = null;
	agents: AgentConfig[] = [];
	models: ModelInfo[] = [];
	skills: SkillInfo[] = [];
	mcpServers: McpServerEntry[] = [];
	/** Runtime MCP server status tracked from session.info/warning events. */
	mcpServerStatus = new Map<string, {status: 'pending' | 'connected' | 'error'; message?: string; tools?: McpToolInfo[]; httpStatus?: number}>();
	prompts: PromptConfig[] = [];
	triggers: TriggerConfig[] = [];
	/** Concatenated content from *.instructions.md files, prepended to every session. */
	globalInstructions = '';
	triggerScheduler: TriggerScheduler | null = null;
	vaultIndex: VaultIndex | null = null;
	contextBuilder: ContextBuilder | null = null;
	sessionContextPaths = new Set<string>();
	activePrompt: PromptConfig | null = null;

	selectedAgent = '';
	selectedModel = '';
	enabledSkills: Set<string> = new Set();
	enabledMcpServers: Set<string> = new Set();
	agencyConfig: AgencyConfig = {};
	attachments: ChatAttachment[] = [];
	suggestions: ContextSuggestion[] = [];
	activeNotePath: string | null = null;
	/** Live editor selection for the active note (null when no text is selected). */
	activeSelection: {filePath: string; fileName: string; text: string; startLine: number; startChar: number; endLine: number; endChar: number} | null = null;
	selectionPollTimer: ReturnType<typeof setInterval> | null = null;
	/** Whether the MarkdownView editor was focused on the previous poll tick. */
	editorHadFocus = false;
	/** Current cursor position in the active note (when no text is selected). */
	cursorPosition: {filePath: string; fileName: string; line: number; ch: number} | null = null;
	scopePaths: string[] = [];
	workingDir = '';  // vault-relative path, '' means vault root
	triageAgentForSession: string | null = null;

	isStreaming = false;
	configDirty = true;
	streamingContent = '';
	renderScheduled = false;
	showDebugInfo = false;
	lastFullRenderLen = 0;
	fullRenderTimer: ReturnType<typeof setTimeout> | null = null;

	// ── Turn-level metadata ────────────────────────────────────
	turnStartTime = 0;
	turnToolsUsed: string[] = [];
	turnSkillsUsed: string[] = [];
	turnUsage: {inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; model?: string} | null = null;
	/** Input tokens from the last assistant.usage event only (excludes subagent accumulation). */
	lastUsageInputTokens = 0;
	activeToolCalls = new Map<string, {toolName: string; detailsEl: HTMLDetailsElement}>();
	activeSubagentBlocks = new Map<string, HTMLElement>();
	/** Per-message Component instances for scoped MarkdownRenderer lifecycle. */
	messageComponents = new Map<string, Component>();

	// ── Session-level context usage tracking ───────────────────
	/** Latest input token count from the most recent turn — reflects current context window usage. */
	sessionInputTokens = 0;
	/** Whether the context hint has already been shown for the current session. */
	contextHintShown = false;

	// ── Tools panel state ──────────────────────────────────────
	/** Timer ID for SDK tool discovery retries. */
	sdkToolDiscoveryTimer: ReturnType<typeof setTimeout> | null = null;

	// ── Session sidebar state ──────────────────────────────────
	activeSessions = new Map<string, BackgroundSession>();
	sessionList: import('./copilot').SessionMetadata[] = [];
	sessionNames: Record<string, string> = {};
	currentSessionId: string | null = null;
	sidebarExpanded = false;
	sessionFilter = '';
	sessionTypeFilter = new Set<'chat' | 'inline' | 'trigger' | 'search' | 'other'>(['chat', 'trigger']);
	sessionSort: 'modified' | 'created' | 'name' = 'modified';

	// ── Tab state ────────────────────────────────────────────────
	activeTab: 'chat' | 'triggers' | 'prompts' | 'skills' | 'tools' | 'agency' | 'agents' = 'chat';

	// ── Triggers panel state ─────────────────────────────────────
	triggerHistoryFilter = '';
	triggerHistoryAgentFilter = '';
	triggerHistorySort: 'date' | 'name' = 'date';
	triggerConfigSort: 'name' | 'modified' = 'name';

	// ── Search panel state ───────────────────────────────────────
	searchAgent = '';
	searchModel = '';
	searchWorkingDir = '';
	searchEnabledSkills: Set<string> = new Set();
	searchEnabledMcpServers: Set<string> = new Set();
	searchAgentSelect!: HTMLSelectElement;
	searchModelSelect!: HTMLSelectElement;
	searchSkillsBtnEl!: HTMLButtonElement;
	searchToolsBtnEl!: HTMLButtonElement;
	searchCwdBtnEl!: HTMLButtonElement;
	searchInputEl!: HTMLTextAreaElement;
	searchBtnEl!: HTMLButtonElement;
	searchResultsEl!: HTMLElement;
	searchSession: CopilotSession | null = null;
	isSearching = false;
	searchModeToggleEl!: HTMLButtonElement;
	searchAdvancedToolbarEl!: HTMLElement;
	basicSearchSession: CopilotSession | null = null;

	// ── Search result cache ────────────────────────────────────
	searchCache = new Map<string, {content: string; cachedAt: number; scopePaths: string[]; mode: 'basic' | 'advanced'; agent?: string}>();
	static readonly SEARCH_CACHE_TTL = 5 * 60 * 1000;
	static readonly SEARCH_CACHE_MAX = 50;

	// ── DOM refs ─────────────────────────────────────────────────
	mainEl!: HTMLElement;
	tabBarEl!: HTMLElement;
	tabSubBarEl!: HTMLElement;
	tabSubScrollEl!: HTMLElement;
	tabGroups: ReadonlyArray<{
		id: 'workspace' | 'library' | 'connections';
		icon: string;
		label: string;
		tabs: ReadonlyArray<{id: 'chat' | 'triggers' | 'prompts' | 'skills' | 'tools' | 'agency' | 'agents'; icon: string; label: string}>;
	}> | null = null;
	chatPanelEl!: HTMLElement;
	triggersPanelEl!: HTMLElement;
	toolsPanelEl!: HTMLElement;
	toolsMcpListEl!: HTMLElement;
	toolsOilListEl!: HTMLElement;
	agencyPanelEl!: HTMLElement;
	toolsAgencyListEl!: HTMLElement;
	agentsPanelEl!: HTMLElement;
	toolsAgentListEl!: HTMLElement;
	promptsPanelEl!: HTMLElement;
	promptsListEl!: HTMLElement;
	skillsPanelEl!: HTMLElement;
	skillsListEl!: HTMLElement;
	triggerHistoryListEl!: HTMLElement;
	triggerConfigListEl!: HTMLElement;
	chatContainer!: HTMLElement;
	streamingBodyEl: HTMLElement | null = null;
	toolCallsContainer: HTMLElement | null = null;
	inputEl!: HTMLTextAreaElement;
	attachmentsBar!: HTMLElement;
	activeNoteBar!: HTMLElement;
	triggerTestBar!: HTMLElement;
	agentEditBar!: HTMLElement;
	scopeBar!: HTMLElement;
	sendBtn!: HTMLButtonElement;
	toolApprovalBtn!: HTMLButtonElement;
	agentSelect!: HTMLSelectElement;
	modelSelect!: HTMLSelectElement;
	modelIconEl!: HTMLSpanElement;
	skillsBtnEl!: HTMLButtonElement;
	toolsBtnEl!: HTMLButtonElement;
	cwdBtnEl!: HTMLButtonElement;
	debugBtnEl!: HTMLElement;
	streamingComponent: Component | null = null;
	streamingWrapperEl: HTMLElement | null = null;

	// ── Config file watcher ──────────────────────────────────────
	configRefreshTimer: ReturnType<typeof setTimeout> | null = null;
	configLoading = false;
	configLoadedAt = 0;

	// ── Prompt dropdown DOM refs ─────────────────────────────────
	promptDropdown: HTMLElement | null = null;
	promptDropdownIndex = -1;

	// ── Agent mention dropdown DOM refs ─────────────────────────
	agentDropdown: HTMLElement | null = null;
	agentDropdownIndex = -1;
	/** Position in the input where the `@` mention starts. */
	agentMentionStart = -1;

	// ── Built-in slash commands ─────────────────────────────────
	// Definitions live in src/view/builtinCommands.ts (BUILTIN_COMMAND_DESCRIPTORS
	// + buildBuiltinCommands). Pulled into each SessionConfig via this.getBuiltinCommands()
	// so the SDK is aware of them and any agent that calls them triggers the
	// same handler used by the Obsidian input fast path.

	// ── Session sidebar DOM refs ─────────────────────────────────
	sidebarEl!: HTMLElement;
	sidebarListEl!: HTMLElement;
	sidebarSearchEl!: HTMLInputElement;
	sidebarFilterEl!: HTMLButtonElement;
	sidebarSortEl!: HTMLButtonElement;
	sidebarRefreshEl!: HTMLButtonElement;
	sidebarDeleteEl!: HTMLButtonElement;
	sidebarToggleEl!: HTMLButtonElement;

	eventUnsubscribers: (() => void)[] = [];

	constructor(leaf: WorkspaceLeaf, plugin: SidekickPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return SIDEKICK_VIEW_TYPE;
	}
	getDisplayText(): string {
		return 'Sidekick';
	}
	getIcon(): string {
		return this.plugin.activeIconName || 'brain';
	}

	// ── Lifecycle ────────────────────────────────────────────────

	async onOpen(): Promise<void> {
		// Header actions
		this.addAction('plus', 'New conversation', () => void this.newConversation());

		this.buildUI();

		// Load persisted state before rendering lists
		this.sessionNames = this.plugin.settings.sessionNames ?? {};

		// Fire config loading in the background — updateConfigUI() runs when done.
		// Do not await: the view renders immediately and populates as data arrives.
		void this.loadAllConfigs();
		void this.loadSessions();

		// Initialize trigger scheduler
		this.initTriggerScheduler();

		// Initialize vault index
		this.vaultIndex = new VaultIndex(this.app);

		// Initialize context builder
		this.contextBuilder = new ContextBuilder(this.app, this.vaultIndex);

		// Watch sidekick folder for config changes and auto-refresh
		this.registerConfigFileWatcher();

		// Track active note and editor selection
		this.updateActiveNote();
		this.registerEvent(
			this.app.workspace.on('file-open', () => this.updateActiveNote())
		);
		this.startSelectionPolling();
	}

	async onClose(): Promise<void> {
		if (this.selectionPollTimer) { clearInterval(this.selectionPollTimer); this.selectionPollTimer = null; }
		if (this.configRefreshTimer) clearTimeout(this.configRefreshTimer);
		this.closePromptDropdown();
		this.closeAgentDropdown();
		this.triggerScheduler?.stop();
		if (this.basicSearchSession) {
			try { await this.basicSearchSession.disconnect(); } catch { /* ignore */ }
			this.basicSearchSession = null;
		}
		await this.disconnectAllSessions();
	}

	// ── UI construction ──────────────────────────────────────────

	buildUI(): void {
		const root = this.containerEl.children[1] as HTMLElement;
		root.empty();
		root.addClass('sidekick-root');

		// Main area (tab bar + panels)
		this.mainEl = root.createDiv({cls: 'sidekick-main'});

		// Tab bar
		this.buildTabBar(this.mainEl);

		// ── Chat panel ───────────────────────────────────────
		this.chatPanelEl = this.mainEl.createDiv({cls: 'sidekick-tab-panel sidekick-tab-panel-chat'});

		// Chat content wrapper (chat + bottom)
		const chatContent = this.chatPanelEl.createDiv({cls: 'sidekick-chat-content'});

		// Chat history (scrollable)
		this.chatContainer = chatContent.createDiv({cls: 'sidekick-chat sidekick-hide-debug'});
		this.renderWelcome();

		// Bottom panel
		const bottom = chatContent.createDiv({cls: 'sidekick-bottom'});

		// Input area
		this.buildInputArea(bottom);

		// Config toolbar (agents, models, skills, tools, action buttons)
		this.buildConfigToolbar(bottom);

		// Session sidebar inside chat panel
		this.buildSessionSidebar(this.chatPanelEl);

		// ── Triggers panel ────────────────────────────────────
		this.triggersPanelEl = this.mainEl.createDiv({cls: 'sidekick-tab-panel sidekick-tab-panel-triggers is-hidden'});
		this.buildTriggersPanel(this.triggersPanelEl);

		// ── Search panel ─────────────────────────────────────
		this.searchPanelEl = this.mainEl.createDiv({cls: 'sidekick-tab-panel sidekick-tab-panel-search is-hidden'});
		this.buildSearchPanel(this.searchPanelEl);

		// ── Prompts panel ────────────────────────────────────
		this.promptsPanelEl = this.mainEl.createDiv({cls: 'sidekick-tab-panel sidekick-tab-panel-prompts is-hidden'});
		this.buildPromptsPanel(this.promptsPanelEl);

		// ── Skills panel ─────────────────────────────────────
		this.skillsPanelEl = this.mainEl.createDiv({cls: 'sidekick-tab-panel sidekick-tab-panel-skills is-hidden'});
		this.buildSkillsPanel(this.skillsPanelEl);

		// ── Tools panel (MCP servers only) ───────────────────
		this.toolsPanelEl = this.mainEl.createDiv({cls: 'sidekick-tab-panel sidekick-tab-panel-tools is-hidden'});
		this.buildOilPanel(this.toolsPanelEl);
		this.buildToolsPanel(this.toolsPanelEl);

		// ── Agency panel ─────────────────────────────────────
		this.agencyPanelEl = this.mainEl.createDiv({cls: 'sidekick-tab-panel sidekick-tab-panel-agency is-hidden'});
		this.buildAgencyPanel(this.agencyPanelEl);

		// ── Agents panel ─────────────────────────────────────
		this.agentsPanelEl = this.mainEl.createDiv({cls: 'sidekick-tab-panel sidekick-tab-panel-agents is-hidden'});
		this.buildAgentsPanel(this.agentsPanelEl);
	}

	buildTabBar(parent: HTMLElement): void {
		this.tabBarEl = parent.createDiv({cls: 'sidekick-tab-bar'});

		// ── Tab definitions, grouped by category ─────────────
		type TabId = 'chat' | 'triggers' | 'prompts' | 'skills' | 'tools' | 'agency' | 'agents';
		type TabDef = {id: TabId; icon: string; label: string};
		type GroupDef = {id: 'workspace' | 'library' | 'connections'; icon: string; label: string; tabs: TabDef[]};

		const groups: GroupDef[] = [
			{
				id: 'workspace',
				icon: 'layout-dashboard',
				label: 'Workspace',
				tabs: [
					{id: 'chat', icon: 'message-square', label: 'Chat'},
					{id: 'triggers', icon: 'zap', label: 'Triggers'},
				],
			},
			{
				id: 'library',
				icon: 'library',
				label: 'Library',
				tabs: [
					{id: 'agents', icon: 'bot', label: 'Agents'},
					{id: 'skills', icon: 'sparkles', label: 'Skills'},
					{id: 'prompts', icon: 'file-text', label: 'Prompts'},
				],
			},
			{
				id: 'connections',
				icon: 'plug',
				label: 'Connections',
				tabs: [
					{id: 'tools', icon: 'plug', label: 'Tools'},
					{id: 'agency', icon: 'building-2', label: 'Agency'},
				],
			},
		];

		// Cache for switchTab to read
		this.tabGroups = groups;

		const findGroup = (tabId: TabId): GroupDef =>
			groups.find(g => g.tabs.some(t => t.id === tabId)) ?? groups[0]!;

		// ── Top row: group selector ──────────────────────────
		const groupRow = this.tabBarEl.createDiv({cls: 'sidekick-tab-groups'});
		for (const group of groups) {
			const groupBtn = groupRow.createDiv({cls: 'sidekick-tab-group'});
			groupBtn.dataset.group = group.id;
			const iconEl = groupBtn.createSpan({cls: 'sidekick-tab-icon'});
			setIcon(iconEl, group.icon);
			groupBtn.createSpan({cls: 'sidekick-tab-label', text: group.label});
			groupBtn.addEventListener('click', () => {
				// Switch to first visible tab in the group
				const firstAvailable = group.tabs.find(t => !(t.id === 'agency' && !this.plugin.settings.agencyEnabled));
				if (firstAvailable) this.switchTab(firstAvailable.id);
			});
		}

		// ── Bottom row: sub-tabs for the active group ────────
		this.tabSubBarEl = this.tabBarEl.createDiv({cls: 'sidekick-tab-subbar'});
		const tabsScroll = this.tabSubBarEl.createDiv({cls: 'sidekick-tabs-scroll'});
		this.tabSubScrollEl = tabsScroll;

		// Overflow button — kept in layout via visibility for ResizeObserver stability
		const overflowBtn = this.tabSubBarEl.createDiv({cls: 'sidekick-tab-overflow sidekick-tab-overflow-hidden'});
		setIcon(overflowBtn, 'more-horizontal');
		overflowBtn.setAttribute('title', 'More tabs');
		overflowBtn.addEventListener('click', (e: MouseEvent) => {
			const menu = new Menu();
			const activeGroup = findGroup(this.activeTab);
			for (const tab of activeGroup.tabs) {
				if (tab.id === 'agency' && !this.plugin.settings.agencyEnabled) continue;
				menu.addItem(item => item
					.setTitle(tab.label)
					.setIcon(tab.icon)
					.setChecked(this.activeTab === tab.id)
					.onClick(() => this.switchTab(tab.id)));
			}
			menu.showAtMouseEvent(e);
		});

		// Initial render of sub-tabs for current active tab's group
		this.renderSubTabs();

		// Highlight active group + tab
		this.updateTabBarActiveState();

		// ResizeObserver — track overflow on the sub-bar
		const observer = new ResizeObserver(() => {
			const hasOverflow = tabsScroll.scrollWidth > tabsScroll.clientWidth + 2;
			overflowBtn.toggleClass('sidekick-tab-overflow-hidden', !hasOverflow);
		});
		observer.observe(parent);
		this.register(() => observer.disconnect());
	}

	/** Re-render the sub-tab row for the currently active tab's group. */
	renderSubTabs(): void {
		if (!this.tabSubScrollEl || !this.tabGroups) return;
		this.tabSubScrollEl.empty();
		const activeGroup = this.tabGroups.find(g => g.tabs.some(t => t.id === this.activeTab)) ?? this.tabGroups[0];
		if (!activeGroup) return;
		for (const tab of activeGroup.tabs) {
			const btn = this.tabSubScrollEl.createDiv({cls: 'sidekick-tab' + (tab.id === this.activeTab ? ' is-active' : '')});
			btn.dataset.tab = tab.id;
			if (tab.id === 'agency' && !this.plugin.settings.agencyEnabled) {
				btn.addClass('is-hidden');
			}
			const iconEl = btn.createSpan({cls: 'sidekick-tab-icon'});
			setIcon(iconEl, tab.icon);
			btn.createSpan({cls: 'sidekick-tab-label', text: tab.label});
			btn.addEventListener('click', () => this.switchTab(tab.id));
		}
	}

	/** Update active state on group row and sub-tab row based on this.activeTab. */
	updateTabBarActiveState(): void {
		if (!this.tabGroups) return;
		const activeGroup = this.tabGroups.find(g => g.tabs.some(t => t.id === this.activeTab));
		this.tabBarEl.querySelectorAll('.sidekick-tab-group').forEach(el => {
			el.toggleClass('is-active', (el as HTMLElement).dataset.group === activeGroup?.id);
		});
		this.tabBarEl.querySelectorAll('.sidekick-tab').forEach(el => {
			el.toggleClass('is-active', (el as HTMLElement).dataset.tab === this.activeTab);
		});
	}

	switchTab(tab: 'chat' | 'triggers' | 'prompts' | 'skills' | 'tools' | 'agency' | 'agents'): void {
		const groupChanged = this.tabGroups
			? this.tabGroups.find(g => g.tabs.some(t => t.id === this.activeTab))?.id
				!== this.tabGroups.find(g => g.tabs.some(t => t.id === tab))?.id
			: false;
		if (tab === this.activeTab) return;
		this.activeTab = tab;

		// If we crossed group boundaries, rebuild the sub-tab row; otherwise just toggle active state.
		if (groupChanged) {
			this.renderSubTabs();
		}
		this.updateTabBarActiveState();

		// Show/hide panels
		this.chatPanelEl.toggleClass('is-hidden', tab !== 'chat');
		this.triggersPanelEl.toggleClass('is-hidden', tab !== 'triggers');
		this.promptsPanelEl.toggleClass('is-hidden', tab !== 'prompts');
		this.skillsPanelEl.toggleClass('is-hidden', tab !== 'skills');
		this.toolsPanelEl.toggleClass('is-hidden', tab !== 'tools');
		this.agencyPanelEl.toggleClass('is-hidden', tab !== 'agency');
		this.agentsPanelEl.toggleClass('is-hidden', tab !== 'agents');

		// Refresh panel content when switching to it
		if (tab === 'prompts') {
			this.renderPromptsList();
		}
		if (tab === 'skills') {
			this.renderSkillsPanelList();
		}
		if (tab === 'tools' || tab === 'agency') {
			if (tab === 'tools') {
				this.renderOilPanel();
				this.renderMcpServersList();
			}
			if (tab === 'agency') this.renderAgencyServersList();
			// Probe servers that haven't been discovered yet (skip errors — they need auth or manual refresh)
			const anyUnprobed = this.mcpServers.some(s => {
				if (!this.enabledMcpServers.has(s.name)) return false;
				const status = this.mcpServerStatus.get(s.name);
				if (!status) return true;
				if (status.status === 'error' || status.status === 'pending') return false;
				return !status.tools?.length;
			});
			if (anyUnprobed) {
				this.scheduleMcpToolDiscovery();
			}
		}
		if (tab === 'agents') {
			this.renderAgentToolMappings();
		}
	}

	renderWelcome(): void {
		const welcome = this.chatContainer.createDiv({cls: 'sidekick-welcome'});
		const icon = welcome.createDiv({cls: 'sidekick-welcome-icon'});
		setIcon(icon, this.plugin.activeIconName || 'brain');
		welcome.createEl('h3', {text: 'Sidekick'});
		welcome.createEl('p', {
			text: 'Your AI-powered second brain. Select an agent, choose a model, configure tools and get the job done!',
			cls: 'sidekick-welcome-desc',
		});
	}

	/** Re-render the welcome icon if the welcome screen is currently visible. */
	refreshIcon(): void {
		const iconEl = this.chatContainer?.querySelector('.sidekick-welcome-icon');
		if (iconEl instanceof HTMLElement) {
			iconEl.empty();
			setIcon(iconEl, this.plugin.activeIconName || 'brain');
		}
	}

	buildInputArea(parent: HTMLElement): void {
		const inputArea = parent.createDiv({cls: 'sidekick-input-area'});

		// Attach buttons row above textarea
		const inputActions = inputArea.createDiv({cls: 'sidekick-input-actions'});

		const scopeBtn = inputActions.createEl('button', {cls: 'clickable-icon sidekick-icon-btn', attr: {title: 'Select vault scope'}});
		setIcon(scopeBtn, 'folder');
		scopeBtn.addEventListener('click', () => this.openScopeModal());

		const attachBtn = inputActions.createEl('button', {cls: 'clickable-icon sidekick-icon-btn', attr: {title: 'Attach file'}});
		setIcon(attachBtn, 'paperclip');
		attachBtn.addEventListener('click', () => this.handleAttachFile());

		const clipBtn = inputActions.createEl('button', {cls: 'clickable-icon sidekick-icon-btn', attr: {title: 'Paste clipboard'}});
		setIcon(clipBtn, 'clipboard-paste');
		clipBtn.addEventListener('click', () => void this.handleClipboard());

		// Attachments, active note & scope (shown inline after action buttons)
		this.attachmentsBar = inputActions.createDiv({cls: 'sidekick-attachments-bar'});
		this.activeNoteBar = inputActions.createDiv({cls: 'sidekick-active-note-bar'});
		this.triggerTestBar = inputActions.createDiv({cls: 'sidekick-trigger-test-bar is-hidden'});
		this.agentEditBar = inputActions.createDiv({cls: 'sidekick-agent-edit-bar is-hidden'});
		this.scopeBar = inputActions.createDiv({cls: 'sidekick-scope-bar'});

		// Row for textarea + send button
		const inputRow = inputArea.createDiv({cls: 'sidekick-input-row'});

		this.inputEl = inputRow.createEl('textarea', {
			cls: 'sidekick-input',
			attr: {placeholder: 'Ask something… Use / for commands, @ for agents', rows: '1'},
		});

		// Auto-resize
		this.inputEl.addEventListener('input', () => {
			this.inputEl.setCssProps({'--input-height': 'auto'});
			this.inputEl.setCssProps({'--input-height': Math.min(this.inputEl.scrollHeight, 200) + 'px'});
			this.handlePromptTrigger();
			this.handleAgentMentionTrigger();
		});

		// Ctrl+Enter or Enter (without Shift) to send
		// Register on window in capture phase — earliest interception before Obsidian's hotkey system
		const keyHandler = (e: KeyboardEvent) => {
			if (document.activeElement !== this.inputEl) return;

			// Handle prompt dropdown navigation
			if (this.promptDropdown) {
				if (e.key === 'ArrowDown') {
					e.preventDefault();
					e.stopPropagation();
					this.navigatePromptDropdown(1);
					return;
				}
				if (e.key === 'ArrowUp') {
					e.preventDefault();
					e.stopPropagation();
					this.navigatePromptDropdown(-1);
					return;
				}
				if (e.key === 'Enter' || e.key === 'Tab') {
					e.preventDefault();
					e.stopPropagation();
					e.stopImmediatePropagation();
					this.selectPromptFromDropdown();
					return;
				}
				if (e.key === 'Escape') {
					e.preventDefault();
					this.closePromptDropdown();
					return;
				}
			}

			// Handle agent mention dropdown navigation
			if (this.agentDropdown) {
				if (e.key === 'ArrowDown') {
					e.preventDefault();
					e.stopPropagation();
					this.navigateAgentDropdown(1);
					return;
				}
				if (e.key === 'ArrowUp') {
					e.preventDefault();
					e.stopPropagation();
					this.navigateAgentDropdown(-1);
					return;
				}
				if (e.key === 'Enter' || e.key === 'Tab') {
					e.preventDefault();
					e.stopPropagation();
					e.stopImmediatePropagation();
					this.selectAgentFromDropdown();
					return;
				}
				if (e.key === 'Escape') {
					e.preventDefault();
					this.closeAgentDropdown();
					return;
				}
			}

			if (e.key === 'Enter' && !e.shiftKey) {
				e.preventDefault();
				e.stopPropagation();
				e.stopImmediatePropagation();
				void this.handleSend();
				return;
			}

			const isAttachShortcut = (e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'a';
			if (isAttachShortcut) {
				e.preventDefault();
				e.stopPropagation();
				e.stopImmediatePropagation();
				this.toggleCurrentSuggestion();
			}
		};
		window.addEventListener('keydown', keyHandler, true);
		this.register(() => window.removeEventListener('keydown', keyHandler, true));

		// Paste handler for images
		this.inputEl.addEventListener('paste', (e: ClipboardEvent) => {
			const items = e.clipboardData?.items;
			if (!items) return;
			for (let i = 0; i < items.length; i++) {
				const item = items[i];
				if (item && item.type.startsWith('image/')) {
					e.preventDefault();
					const blob = item.getAsFile();
					if (blob) void this.handleImagePaste(blob);
					return;
				}
			}
		});

		// Drag-and-drop external files onto the input area
		let dragCounter = 0;
		inputArea.addEventListener('dragenter', (e: DragEvent) => {
			e.preventDefault();
			dragCounter++;
			inputArea.addClass('sidekick-drag-over');
		});
		inputArea.addEventListener('dragover', (e: DragEvent) => {
			e.preventDefault();
			if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
		});
		inputArea.addEventListener('dragleave', () => {
			dragCounter--;
			if (dragCounter <= 0) {
				dragCounter = 0;
				inputArea.removeClass('sidekick-drag-over');
			}
		});
		inputArea.addEventListener('drop', (e: DragEvent) => {
			e.preventDefault();
			dragCounter = 0;
			inputArea.removeClass('sidekick-drag-over');
			this.handleFileDrop(e);
		});

		// Edit button (opens Edit modal with chat input text)
		const editBtn = inputRow.createEl('button', {cls: 'clickable-icon sidekick-icon-btn', attr: {title: 'Edit text'}});
		setIcon(editBtn, 'pencil-line');
		editBtn.addEventListener('click', () => this.openEditFromChat());

		// Send / Stop button
		this.sendBtn = inputRow.createEl('button', {
			cls: 'clickable-icon sidekick-send-btn',
			attr: {title: 'Send message'},
		});
		setIcon(this.sendBtn, 'arrow-up');
		this.sendBtn.addEventListener('click', () => {
			if (this.isStreaming) {
				void this.handleAbort();
			} else {
				void this.handleSend();
			}
		});
	}

	buildConfigToolbar(parent: HTMLElement): void {
		const toolbar = parent.createDiv({cls: 'sidekick-toolbar'});

		// New conversation button
		const newChatBtn = toolbar.createEl('button', {cls: 'clickable-icon sidekick-icon-btn', attr: {title: 'New conversation'}});
		setIcon(newChatBtn, 'plus');
		newChatBtn.addEventListener('click', () => void this.newConversation());

		// Agent dropdown
		const agentGroup = toolbar.createDiv({cls: 'sidekick-toolbar-group'});
		const agentIcon = agentGroup.createSpan({cls: 'sidekick-toolbar-icon'});
		setIcon(agentIcon, 'bot');
		this.agentSelect = agentGroup.createEl('select', {cls: 'sidekick-select'});
		this.agentSelect.addEventListener('change', () => {
			this.selectAgent(this.agentSelect.value);
		});

		// Model dropdown
		const modelGroup = toolbar.createDiv({cls: 'sidekick-toolbar-group'});
		this.modelIconEl = modelGroup.createSpan({cls: 'sidekick-toolbar-icon clickable-icon'});
		setIcon(this.modelIconEl, 'cpu');
		this.modelIconEl.addEventListener('click', (e) => { e.stopPropagation(); this.openReasoningMenu(e); });
		this.modelSelect = modelGroup.createEl('select', {cls: 'sidekick-select sidekick-model-select'});
		this.modelSelect.addEventListener('change', () => {
			this.selectedModel = this.modelSelect.value;
			this.configDirty = true;
			this.updateReasoningBadge();
		});
		this.modelSelect.addEventListener('mousedown', () => {
			if (this.models.length === 0) void this.refreshModels();
		});

		// Skills button
		this.skillsBtnEl = toolbar.createEl('button', {cls: 'clickable-icon sidekick-icon-btn', attr: {title: 'Skills'}});
		setIcon(this.skillsBtnEl, 'wand-2');
		this.skillsBtnEl.addEventListener('click', (e) => this.openSkillsMenu(e));

		// Tools button
		this.toolsBtnEl = toolbar.createEl('button', {cls: 'clickable-icon sidekick-icon-btn', attr: {title: 'Tools'}});
		setIcon(this.toolsBtnEl, 'plug');
		this.toolsBtnEl.addEventListener('click', (e) => this.openToolsMenu(e));

		// Working directory button
		this.cwdBtnEl = toolbar.createEl('button', {cls: 'clickable-icon sidekick-icon-btn', attr: {title: 'Working directory'}});
		setIcon(this.cwdBtnEl, 'hard-drive-download');
		this.cwdBtnEl.addEventListener('click', () => this.openCwdPicker());
		this.updateCwdButton();

		// Spacer to push debug toggle to the right
		toolbar.createDiv({cls: 'sidekick-toolbar-spacer'});

		// Debug toggle
		this.debugBtnEl = toolbar.createDiv({cls: 'sidekick-debug-toggle', attr: {title: 'Show tool & token details'}});
		const debugIcon = this.debugBtnEl.createSpan({cls: 'sidekick-debug-icon'});
		setIcon(debugIcon, 'bug');
		const debugCheck = this.debugBtnEl.createEl('input', {type: 'checkbox', cls: 'sidekick-debug-checkbox'});
		debugCheck.checked = this.showDebugInfo;
		debugCheck.addEventListener('change', () => {
			this.showDebugInfo = debugCheck.checked;
			setDebugEnabled(this.showDebugInfo);
			this.chatContainer.toggleClass('sidekick-hide-debug', !this.showDebugInfo);
		});
		this.debugBtnEl.addEventListener('click', (e) => {
			if (e.target !== debugCheck) {
				debugCheck.checked = !debugCheck.checked;
				debugCheck.dispatchEvent(new Event('change'));
			}
		});
	}

	// ── Config loading ───────────────────────────────────────────

	async loadAllConfigs(options?: {silent?: boolean}): Promise<void> {
		if (this.configLoading) return;
		this.configLoading = true;
		let isReload = false;
		try {
			// Build input resolver that reads stored values or prompts for missing ones
			const inputResolver: InputResolver = async (input: McpInputVariable) => {
				const isPassword = input.password === true;
				let value = getMcpInputValue(this.app, this.plugin, input.id, isPassword);
				if (value === undefined) {
					// Prompt user for the missing value
					value = await new Promise<string | undefined>(resolve => {
						const modal = new McpInputPromptModal(this.app, input, (v) => {
							if (v !== undefined) {
								void setMcpInputValue(this.app, this.plugin, input.id, v, isPassword);
							}
							resolve(v);
						});
						modal.open();
					});
				}
				return value;
			};

			// Kick off agency cache priming in parallel with file I/O (async, non-blocking)
			const agencyPrime = this.plugin.settings.agencyEnabled ? primeAgencyCache() : Promise.resolve();

			// Parallel-load all config files (independent I/O)
			const [agents, skills, mcpServers, agencyConfig, prompts, triggers, globalInstructions] = await Promise.all([
				loadAgents(this.app, getAgentsFolder(this.plugin.settings)),
				loadSkills(this.app, getSkillsFolder(this.plugin.settings)),
				loadMcpServers(this.app, getToolsFolder(this.plugin.settings), inputResolver),
				loadAgencyConfig(this.app, getToolsFolder(this.plugin.settings)),
				loadPrompts(this.app, getPromptsFolder(this.plugin.settings)),
				loadTriggers(this.app, getTriggersFolder(this.plugin.settings)),
				loadInstructions(this.app, this.plugin.settings.sidekickFolder),
			] as const);
			// Await priming completion (likely already done — file I/O takes longer than the subprocess check)
			await agencyPrime;
			const previousServerNames = new Set(this.mcpServers.map(s => s.name));
			const previousSkillNames = new Set(this.skills.map(s => s.name));

			this.agents = agents;
			this.skills = skills;
			this.agencyConfig = agencyConfig;

			// Merge auto-discovered agency services with mcp.json entries.
			// Skip entirely when agency is disabled in settings.
			if (this.plugin.settings.agencyEnabled) {
				const configuredNames = new Set(mcpServers.map(s => s.name));
				const serviceWhitelist = agencyConfig.services ? new Set(agencyConfig.services) : null;
				const agencyServers = discoverAgencyServers().filter(s => {
					if (configuredNames.has(s.name)) return false;
					if (serviceWhitelist) {
						const svcName = s.config['_agencyService'] as string;
						return serviceWhitelist.has(svcName);
					}
					return true;
				});
				this.mcpServers = [...mcpServers, ...agencyServers];
			} else {
				this.mcpServers = mcpServers;
			}

			// Inject built-in OIL server (deduplicate if user has it in mcp.json)
			if (!this.mcpServers.some(s => s.name === OIL_SERVER_NAME)) {
				const vaultPath = this.getVaultBasePath();
				this.mcpServers.unshift(buildOilServerEntry(vaultPath));
			}
			this.prompts = prompts;
			this.triggers = triggers;
			this.globalInstructions = globalInstructions;
			this.triggerScheduler?.setTriggers(this.triggers);
			this.renderTriggerConfigList();
			this.renderTriggerHistory();
			this.renderTriggerTestBar();
			this.renderAgentEditBar();

			// Preserve user toggle state across config reloads.
			// First load: enable everything. Subsequent loads: keep existing
			// enabled/disabled state, only adding newly-discovered entries.
			// Agency services always re-sync from agency.md on every load.
			const isReloadCheck = previousServerNames.size > 0;
			isReload = isReloadCheck;

			// Build agency defaults from agency.md (used in both paths)
			const agencyDefaults = this.agencyConfig.enabled
				? new Set(this.agencyConfig.enabled.map(s => `agency-${s}`))
				: new Set<string>();

			if (isReloadCheck) {
				const newServerNames = new Set(this.mcpServers.map(s => s.name));
				for (const name of [...this.enabledMcpServers]) {
					if (!newServerNames.has(name)) this.enabledMcpServers.delete(name);
				}
				for (const name of newServerNames) {
					if (!previousServerNames.has(name)) {
						// New non-agency servers auto-enable; new agency servers use defaults
						const srv = this.mcpServers.find(s => s.name === name);
						if (!srv || !isAgencyService(srv)) {
							this.enabledMcpServers.add(name);
						} else if (agencyDefaults.has(name)) {
							this.enabledMcpServers.add(name);
						}
					}
				}
				// Re-sync existing agency services from agency.md on every reload
				for (const srv of this.mcpServers) {
					if (!isAgencyService(srv)) continue;
					if (agencyDefaults.has(srv.name)) {
						this.enabledMcpServers.add(srv.name);
					} else {
						this.enabledMcpServers.delete(srv.name);
					}
				}
				const newSkillNames = new Set(this.skills.map(s => s.name));
				for (const name of [...this.enabledSkills]) {
					if (!newSkillNames.has(name)) this.enabledSkills.delete(name);
				}
				for (const name of newSkillNames) {
					if (!previousSkillNames.has(name)) this.enabledSkills.add(name);
				}
				// Preserve connection status for servers that still exist
				for (const name of [...this.mcpServerStatus.keys()]) {
					if (!newServerNames.has(name)) this.mcpServerStatus.delete(name);
				}
			} else {
				this.enabledSkills = new Set(this.skills.map(s => s.name));
				// Auto-enable mcp.json servers; agency services use agency.md `enabled` list
				this.enabledMcpServers = new Set(
					this.mcpServers
						.filter(s => !isAgencyService(s) || agencyDefaults.has(s.name))
						.map(s => s.name)
				);
				this.mcpServerStatus.clear();
			}

			// Populate model list for BYOK providers synchronously (no CLI needed)
			if (!options?.silent) {
				const preset = this.plugin.settings.providerPreset;
				const isByok = preset !== 'github';
				if (isByok && this.plugin.settings.providerModel) {
					const id = this.plugin.settings.providerModel;
					this.models = [{id, name: id} as ModelInfo];
				}
				// GitHub Copilot: fire model loading in background after file I/O finishes
				// so the CLI binary startup does not block updateConfigUI/Notice.
				if (!isByok && this.plugin.copilot) {
					void this.plugin.copilot.listModels()
						.then(models => {
							this.models = models;
							this.updateConfigUI({preserveToggles: true});
						})
						.catch(err => console.warn('Sidekick: failed to load models', err));
				}
			}
		} catch (e) {
			console.error('Sidekick: failed to load configs', e);
		} finally {
			this.configLoading = false;
			this.configLoadedAt = Date.now();
		}

		this.updateConfigUI({preserveToggles: isReload});
		this.configDirty = true;
		if (!options?.silent) {
			new Notice(`Loaded ${this.agents.length} agent(s), ${this.skills.length} skill(s), ${this.mcpServers.length} tool server(s), ${this.prompts.length} prompt(s), ${this.triggers.length} trigger(s).`);
		}
	}

	registerConfigFileWatcher(): void {
		const DEBOUNCE_MS = 500;

		const scheduleRefresh = (filePath: string) => {
			const base = normalizePath(this.plugin.settings.sidekickFolder);
			if (!filePath.startsWith(base + '/')) return;
			if (this.configLoading || (Date.now() - this.configLoadedAt < 2_000)) return;
			debugTrace(`Sidekick: config file changed: ${filePath}`);
			if (this.configRefreshTimer) clearTimeout(this.configRefreshTimer);
			this.configRefreshTimer = setTimeout(() => {
				this.configRefreshTimer = null;
				void this.loadAllConfigs({silent: true});
			}, DEBOUNCE_MS);
		};

		this.registerEvent(
			this.app.vault.on('modify', (file) => scheduleRefresh(file.path))
		);
		this.registerEvent(
			this.app.vault.on('create', (file) => scheduleRefresh(file.path))
		);
		this.registerEvent(
			this.app.vault.on('delete', (file) => scheduleRefresh(file.path))
		);
		this.registerEvent(
			this.app.vault.on('rename', (file, oldPath) => {
				scheduleRefresh(file.path);
				scheduleRefresh(oldPath);
			})
		);
	}

	updateConfigUI(options?: {preserveToggles?: boolean}): void {
		// Agents
		this.agentSelect.empty();
		const noAgent = this.agentSelect.createEl('option', {text: 'Auto', attr: {value: ''}});
		noAgent.value = '';
		for (const agent of this.agents) {
			const opt = this.agentSelect.createEl('option', {text: agent.name});
			opt.value = agent.name;
			opt.title = agent.instructions;
		}
		if (this.selectedAgent && this.agents.some(a => a.name === this.selectedAgent)) {
			this.agentSelect.value = this.selectedAgent;
			const selAgent = this.agents.find(a => a.name === this.selectedAgent);
			this.agentSelect.title = selAgent ? selAgent.instructions : '';
		} else {
			this.selectedAgent = '';
			this.agentSelect.value = '';
			this.agentSelect.title = '';
		}

		// Auto-select agent's preferred model
		const selectedAgentConfig = this.agents.find(a => a.name === this.selectedAgent);
		const resolvedModel = this.resolveModelForAgent(selectedAgentConfig, this.selectedModel || undefined);
		if (resolvedModel) {
			this.selectedModel = resolvedModel;
		}

		// Models
		this.populateModelSelect();
		if (this.selectedModel && this.models.some(m => m.id === this.selectedModel)) {
			this.modelSelect.value = this.selectedModel;
		} else if (this.models.length > 0 && this.models[0]) {
			this.selectedModel = this.models[0].id;
			this.modelSelect.value = this.selectedModel;
		}

		// Apply agent's tools and skills filter (skip on reload to preserve user toggles)
		if (!options?.preserveToggles) {
			const selectedAgentForFilter = this.agents.find(a => a.name === this.selectedAgent);
			this.applyAgentToolsAndSkills(selectedAgentForFilter);
		}
		this.updateReasoningBadge();

		// Update search panel dropdowns
		if (this.searchAgentSelect) {
			this.updateSearchConfigUI();
		}

		// Show/hide agency tab based on settings
		const agencyTab = this.tabBarEl.querySelector('[data-tab="agency"]') as HTMLElement | null;
		if (agencyTab) {
			agencyTab.toggleClass('is-hidden', !this.plugin.settings.agencyEnabled);
		}
		// If agency is disabled and we're on the agency tab, switch to chat
		if (!this.plugin.settings.agencyEnabled && this.activeTab === 'agency') {
			this.switchTab('chat');
		}

		// Pre-render all tool panels (even hidden) so they're ready when user switches tabs
		this.renderMcpServersList();
		this.renderAgencyServersList();
		this.renderAgentToolMappings();

		// Discover MCP tools in the background after config load.
		// Always probe (even when the tools tab isn't visible) so results
		// are ready when the user opens it.
		if (this.enabledMcpServers.size > 0) {
			this.scheduleMcpToolDiscovery();
		}
	}

	populateModelSelect(): void {
		this.modelSelect.empty();
		if (this.models.length === 0) {
			const placeholder = this.modelSelect.createEl('option', {text: 'No models — click to retry'});
			placeholder.value = '';
			placeholder.disabled = true;
		}
		for (const model of this.models) {
			const opt = this.modelSelect.createEl('option', {text: model.name});
			opt.value = model.id;
		}
	}

	async refreshModels(): Promise<void> {
		const preset = this.plugin.settings.providerPreset;
		const isByok = preset !== 'github';
		if (isByok && this.plugin.settings.providerModel) {
			const id = this.plugin.settings.providerModel;
			this.models = [{id, name: id} as ModelInfo];
		} else if (isByok) {
			return;
		} else if (this.plugin.copilot) {
			try {
				this.models = await this.plugin.copilot.listModels();
			} catch (err) {
				console.warn('Sidekick: failed to refresh models', err);
			}
		}
		this.populateModelSelect();
		if (this.models.length > 0 && this.models[0]) {
			this.selectedModel = this.models[0].id;
			this.modelSelect.value = this.selectedModel;
			this.configDirty = true;
			this.updateReasoningBadge();
		}
	}

	getSelectedModelInfo(): ModelInfo | undefined {
		return this.models.find(m => m.id === this.selectedModel);
	}

	openReasoningMenu(e: MouseEvent): void {
		if (this.currentSession && !this.configDirty) return;
		const model = this.getSelectedModelInfo();
		const supported = model?.supportedReasoningEfforts;
		if (!model?.capabilities?.supports?.reasoningEffort || !supported || supported.length === 0) {
			const menu = new Menu();
			menu.addItem(item => item.setTitle('Model does not support reasoning effort').setDisabled(true));
			menu.showAtMouseEvent(e);
			return;
		}
		const menu = new Menu();
		const current = this.plugin.settings.reasoningEffort;
		for (const level of supported) {
			const label = level.charAt(0).toUpperCase() + level.slice(1);
			menu.addItem(item => {
				item.setTitle(label)
					.setChecked(level === current)
					.onClick(() => {
						// Toggle off if already selected
						this.plugin.settings.reasoningEffort = level === current ? '' : level;
						void this.plugin.saveSettings();
						this.configDirty = true;
						this.updateReasoningBadge();
					});
			});
		}
		menu.showAtMouseEvent(e);
	}

	updateReasoningBadge(): void {
		const model = this.getSelectedModelInfo();
		const supportsReasoning = model?.capabilities?.supports?.reasoningEffort && (model.supportedReasoningEfforts?.length ?? 0) > 0;
		const level = this.plugin.settings.reasoningEffort;
		// Reset if current level isn't supported by the new model
		if (level !== '' && supportsReasoning && model?.supportedReasoningEfforts && !model.supportedReasoningEfforts.includes(level as ReasoningEffort)) {
			this.plugin.settings.reasoningEffort = '';
			void this.plugin.saveSettings();
		}
		const current = this.plugin.settings.reasoningEffort;
		const active = current !== '' && !!supportsReasoning;
		this.modelIconEl.toggleClass('is-active', active);
		this.modelIconEl.toggleClass('is-non-interactive', !supportsReasoning);
		if (!supportsReasoning) {
			this.modelIconEl.setAttribute('title', 'Model does not support reasoning effort');
		} else {
			const label = current === '' ? 'Reasoning effort' : `Reasoning effort: ${current.charAt(0).toUpperCase() + current.slice(1)}`;
			this.modelIconEl.setAttribute('title', label);
		}
	}

	openSkillsMenu(e: MouseEvent): void {
		const menu = new Menu();
		if (this.skills.length === 0) {
			menu.addItem(item => item.setTitle('No skills configured').setDisabled(true));
		} else {
			for (const skill of this.skills) {
				menu.addItem(item => {
					item.setTitle(skill.name)
						.setChecked(this.enabledSkills.has(skill.name))
						.onClick(() => {
							if (this.enabledSkills.has(skill.name)) {
								this.enabledSkills.delete(skill.name);
							} else {
								this.enabledSkills.add(skill.name);
							}
							this.configDirty = true;
							this.updateSkillsBadge();
						});
				});
			}
		}
		menu.showAtMouseEvent(e);
	}

	openToolsMenu(e: MouseEvent): void {
		const menu = new Menu();
		if (this.mcpServers.length === 0) {
			menu.addItem(item => item.setTitle('No tools configured').setDisabled(true));
		} else {
			for (const server of this.mcpServers) {
				menu.addItem(item => {
					item.setTitle(server.name)
						.setChecked(this.enabledMcpServers.has(server.name))
						.onClick(() => {
							const shouldEnable = !this.enabledMcpServers.has(server.name);
							void this.setMcpServerEnabled(server, shouldEnable);
						});
				});
			}
		}
		menu.addSeparator();
		const currentApproval = this.plugin.settings.toolApproval;
		menu.addItem(item => {
			item.setTitle('Approval mode');
			const sub: Menu = (item as unknown as {setSubmenu: () => Menu}).setSubmenu();
			sub.addItem(si => {
				si.setTitle('Allow (auto-approve)')
					.setChecked(currentApproval === 'allow')
					.onClick(async () => {
						this.plugin.settings.toolApproval = 'allow';
						await this.plugin.saveSettings();
					});
			});
			sub.addItem(si => {
				si.setTitle('Ask (require approval)')
					.setChecked(currentApproval === 'ask')
					.onClick(async () => {
						this.plugin.settings.toolApproval = 'ask';
						await this.plugin.saveSettings();
					});
			});
		});
		menu.showAtMouseEvent(e);
	}

	async setMcpServerEnabled(server: McpServerEntry, enable: boolean): Promise<boolean> {
		const currentlyEnabled = this.enabledMcpServers.has(server.name);
		if (currentlyEnabled === enable) return true;

		if (enable) {
			this.mcpServerStatus.delete(server.name);
			if (server.auth) {
				this.mcpServerStatus.set(server.name, {
					status: 'pending',
					message: `MCP server '${server.name}': running auth flow...`,
				});
				this.renderMcpServersList();
				this.renderAgencyServersList();

				const ok = await this.runAuthRefresh(server.name, server.auth, {showSuccessNotice: false});
				if (!ok) {
					this.mcpServerStatus.set(server.name, {
						status: 'error',
						message: `MCP server '${server.name}': auth flow failed while enabling. Click the key button to retry.`,
					});
					this.renderMcpServersList();
					this.renderAgencyServersList();
					return false;
				}
			}

			this.enabledMcpServers.add(server.name);
		} else {
			this.enabledMcpServers.delete(server.name);
			this.mcpServerStatus.delete(server.name);
		}

		this.configDirty = true;
		this.updateToolsBadge();
		this.renderMcpServersList();
		this.renderAgencyServersList();
		this.renderAgentToolMappings();

		// Auto-probe the server for tools when enabling
		if (enable) {
			void this.probeServer(server);
		}

		return true;
	}

	/**
	 * Probe a single server for tool discovery and update the UI.
	 */
	async probeServer(server: McpServerEntry): Promise<void> {
		this.mcpServerStatus.set(server.name, {
			status: 'pending',
			message: 'Discovering tools…',
		});
		this.renderMcpServersList();
		this.renderAgencyServersList();
		try {
			const result = await probeMcpServer(server);
			if (result.tools.length > 0) {
				this.mcpServerStatus.set(server.name, {
					status: 'connected',
					tools: result.tools,
				});
			} else if (result.error) {
				this.mcpServerStatus.set(server.name, {
					status: 'error',
					message: result.error,
					httpStatus: result.httpStatus,
				});
			}
		} catch (e) {
			this.mcpServerStatus.set(server.name, {
				status: 'error',
				message: e instanceof Error ? e.message : String(e),
			});
		}
		this.renderMcpServersList();
		this.renderAgencyServersList();
	}

	/**
	 * Apply the agent's tools and skills filter.
	 * If the agent specifies a list, enable only those.
	 * If the list is empty/undefined or the agent has no preference, enable all.
	 */
	/**
	 * Switch to the named agent: update state, dropdown, model, tools/skills, and mark config dirty.
	 * No-op if the agent name is not found.
	 */
	selectAgent(agentName: string): void {
		// Handle deselecting (empty = "Auto" / no agent)
		if (!agentName) {
			this.selectedAgent = '';
			this.agentSelect.value = '';
			this.agentSelect.selectedIndex = 0;
			this.agentSelect.title = '';
			this.applyAgentToolsAndSkills(undefined);
			this.configDirty = true;
			return;
		}
		const agent = this.agents.find(a => a.name === agentName)
			// Fallback: case-insensitive match
			?? this.agents.find(a => a.name.toLowerCase() === agentName.toLowerCase());
		if (!agent) return; // No matching agent found — leave dropdown unchanged
		this.selectedAgent = agent.name;
		// Update the dropdown — set both .value and .selectedIndex for reliability
		this.agentSelect.value = agent.name;
		const opts = this.agentSelect.options;
		for (let i = 0; i < opts.length; i++) {
			if (opts[i]!.value === agent.name) {
				this.agentSelect.selectedIndex = i;
				break;
			}
		}
		this.agentSelect.title = agent.instructions;
		// Auto-select agent's preferred model
		const resolvedModel = this.resolveModelForAgent(agent, this.selectedModel || undefined);
		if (resolvedModel && resolvedModel !== this.selectedModel) {
			this.selectedModel = resolvedModel;
			this.modelSelect.value = resolvedModel;
		}
		this.applyAgentToolsAndSkills(agent);
		this.configDirty = true;
	}

	applyAgentToolsAndSkills(agent?: AgentConfig): void {
		// Tools: undefined = enable all, [] = disable all, [...] = enable listed.
		// Agent names in the tools list are sub-agent references, not MCP servers.
		// Agency services always follow agency.md `enabled` defaults.
		const agencyDefaults = this.agencyConfig.enabled
			? new Set(this.agencyConfig.enabled.map(s => `agency-${s}`))
			: new Set<string>();

		if (agent?.tools !== undefined) {
			const agentNames = new Set(this.agents.map(a => a.name));
			const mcpOnly = agent.tools.filter(t => !agentNames.has(t));
			const allowed = new Set(mcpOnly);
			this.enabledMcpServers = new Set(
				this.mcpServers.filter(s =>
					s.name === OIL_SERVER_NAME ? true
					: isAgencyService(s) ? agencyDefaults.has(s.name)
					: allowed.has(s.name)
				).map(s => s.name)
			);
		} else {
			this.enabledMcpServers = new Set(
				this.mcpServers.filter(s =>
					isAgencyService(s) ? agencyDefaults.has(s.name) : true
				).map(s => s.name)
			);
		}

		// Skills: undefined = enable all, [] = disable all, [...] = enable listed
		if (agent?.skills !== undefined) {
			const allowed = new Set(agent.skills);
			this.enabledSkills = new Set(
				this.skills.filter(s => allowed.has(s.name)).map(s => s.name)
			);
		} else {
			this.enabledSkills = new Set(this.skills.map(s => s.name));
		}

		this.updateSkillsBadge();
		this.updateToolsBadge();
	}

	updateSkillsBadge(): void {
		const count = this.enabledSkills.size;
		this.skillsBtnEl.toggleClass('is-active', count > 0);
		this.skillsBtnEl.setAttribute('title', count > 0 ? `Skills (${count} active)` : 'Skills');
	}

	updateToolsBadge(): void {
		const count = this.enabledMcpServers.size;
		this.toolsBtnEl.toggleClass('is-active', count > 0);
		this.toolsBtnEl.setAttribute('title', count > 0 ? `Tools (${count} active)` : 'Tools');
	}

	// ── Attachments & scope ──────────────────────────────────────

	renderAttachments(): void {
		this.attachmentsBar.empty();
		if (this.attachments.length === 0) {
			this.attachmentsBar.addClass('is-hidden');
			return;
		}
		this.attachmentsBar.removeClass('is-hidden');

		for (let i = 0; i < this.attachments.length; i++) {
			const att = this.attachments[i];
			if (!att) continue;
			const tag = this.attachmentsBar.createDiv({cls: 'sidekick-attachment-tag'});
			const typeIcon = att.type === 'image' ? 'image' : att.type === 'clipboard' ? 'clipboard' : att.type === 'selection' ? 'text-cursor-input' : 'file-text';
			const ic = tag.createSpan({cls: 'sidekick-attachment-icon'});
			setIcon(ic, typeIcon);
			tag.createSpan({text: att.name, cls: 'sidekick-attachment-name'});
			const removeBtn = tag.createSpan({cls: 'sidekick-attachment-remove'});
			setIcon(removeBtn, 'x');
			const idx = i;
			removeBtn.addEventListener('click', () => {
				this.attachments.splice(idx, 1);
				this.renderAttachments();
				this.rebuildSuggestions(false);
				this.renderActiveNoteBar();
			});
		}
	}

	/** Set the vault scope programmatically and refresh the scope bar. */
	public setScope(paths: string[]): void {
		this.scopePaths = paths;
		this.renderScopeBar();
	}

	/** Set the working directory programmatically. */
	public setWorkingDir(folderPath: string): void {
		this.workingDir = folderPath;
		this.updateCwdButton();
		this.configDirty = true;
	}

	/** Set the prompt text programmatically and focus the input. */
	public setPromptText(text: string): void {
		this.inputEl.value = text;
		this.inputEl.setCssProps({'--input-height': 'auto'});
		this.inputEl.setCssProps({'--input-height': Math.min(this.inputEl.scrollHeight, 200) + 'px'});
		this.inputEl.focus();
	}

	/** Add a selection attachment from the editor context menu / brain button. */
	public addSelectionAttachment(text: string, info: SelectionInfo): void {
		// Resolve filePath: prefer info.filePath, fall back to current active file
		const filePath = info.filePath ?? this.app.workspace.getActiveFile()?.path;
		if (!filePath) return; // can't create selection attachment without a file
		const displayName = info.startLine === info.endLine
			? `${info.fileName}:${info.startLine}`
			: `${info.fileName}:${info.startLine}-${info.endLine}`;
		this.attachments.push({
			type: 'selection',
			name: displayName,
			path: filePath,
			content: text,
			selection: {
				startLine: info.startLine,
				startChar: info.startChar,
				endLine: info.endLine,
				endChar: info.endChar,
			},
		});
		this.renderAttachments();
		this.renderActiveNoteBar();
	}

	renderScopeBar(): void {
		this.scopeBar.empty();
		if (this.scopePaths.length === 0) {
			this.scopeBar.addClass('is-hidden');
			return;
		}
		this.scopeBar.removeClass('is-hidden');

		const label = this.scopeBar.createSpan({cls: 'sidekick-scope-label'});
		setIcon(label, 'folder-tree');
		const isEntireVault = this.scopePaths.length === 1 && this.scopePaths[0] === '/';
		const scopeText = isEntireVault
			? ' Entire vault scope'
			: ` ${this.scopePaths.length} item(s) in scope`;
		label.appendText(scopeText);

		const tooltipItems = this.scopePaths.map(p => p === '/' ? this.app.vault.getName() : p).join('\n');
		label.setAttribute('title', tooltipItems);
		label.addEventListener('click', (e) => {
			const menu = new Menu();
			for (const p of this.scopePaths) {
				const display = p === '/' ? this.app.vault.getName() : p;
				menu.addItem(item => item.setTitle(display).setDisabled(true));
			}
			menu.showAtMouseEvent(e);
		});

		const removeBtn = this.scopeBar.createSpan({cls: 'sidekick-scope-remove'});
		setIcon(removeBtn, 'x');
		removeBtn.addEventListener('click', () => {
			this.scopePaths = [];
			this.renderScopeBar();
		});
	}


	buildSessionSidebar(parent: HTMLElement): void {
		this.sidebarEl = parent.createDiv({cls: 'sidekick-sidebar'});
		if (this.sidebarExpanded) this.sidebarEl.addClass('is-expanded');

		// Toggle tab — always visible, sits above everything
		this.sidebarToggleEl = this.sidebarEl.createEl('button', {
			cls: 'sidekick-sidebar-toggle',
			attr: {title: 'Toggle session history'},
		});
		const toggleIcon = this.sidebarToggleEl.createSpan({cls: 'sidekick-sidebar-toggle-icon'});
		setIcon(toggleIcon, 'history');
		this.sidebarToggleEl.createSpan({cls: 'sidekick-sidebar-toggle-label', text: 'History'});
		this.sidebarToggleEl.addEventListener('click', () => this.toggleSidebar());

		// Header: new session button + filter + sort + search
		const header = this.sidebarEl.createDiv({cls: 'sidekick-sidebar-header'});

		const headerBtnRow = header.createDiv({cls: 'sidekick-sidebar-btn-row'});

		const newBtn = headerBtnRow.createEl('button', {
			cls: 'clickable-icon sidekick-icon-btn sidekick-sidebar-new-btn',
			attr: {title: 'New session'},
		});
		setIcon(newBtn, 'plus');
		newBtn.addEventListener('click', () => void this.newConversation());

		this.sidebarFilterEl = headerBtnRow.createEl('button', {
			cls: 'clickable-icon sidekick-sidebar-filter-btn',
			attr: {title: 'Filter sessions by type'},
		});
		setIcon(this.sidebarFilterEl, 'filter');
		this.sidebarFilterEl.addEventListener('click', (e) => this.openSessionFilterMenu(e));
		this.updateFilterBadge();

		this.sidebarSortEl = headerBtnRow.createEl('button', {
			cls: 'clickable-icon sidekick-sidebar-sort-btn',
			attr: {title: 'Sort sessions'},
		});
		setIcon(this.sidebarSortEl, 'arrow-up-down');
		this.sidebarSortEl.addEventListener('click', (e) => this.openSessionSortMenu(e));
		this.updateSortBadge();

		this.sidebarRefreshEl = headerBtnRow.createEl('button', {
			cls: 'clickable-icon sidekick-sidebar-refresh-btn',
			attr: {title: 'Refresh sessions'},
		});
		setIcon(this.sidebarRefreshEl, 'refresh-cw');
		this.sidebarRefreshEl.addEventListener('click', () => {
			void this.loadSessions();
			void this.loadAllConfigs();
		});

		this.sidebarDeleteEl = headerBtnRow.createEl('button', {
			cls: 'clickable-icon sidekick-sidebar-delete-btn',
			attr: {title: 'Delete displayed sessions'},
		});
		setIcon(this.sidebarDeleteEl, 'trash-2');
		this.sidebarDeleteEl.addEventListener('click', () => this.confirmDeleteDisplayedSessions());

		this.sidebarSearchEl = header.createEl('input', {
			type: 'text',
			placeholder: 'Search…',
			cls: 'sidekick-sidebar-search',
		});
		this.sidebarSearchEl.addEventListener('input', () => {
			this.sessionFilter = this.sidebarSearchEl.value.toLowerCase();
			this.renderSessionList();
		});

		// Session list (scrollable)
		this.sidebarListEl = this.sidebarEl.createDiv({cls: 'sidekick-sidebar-list'});

		// Apply initial collapsed/expanded visibility
		this.renderSessionList();
	}

	toggleSidebar(expanded?: boolean): void {
		this.sidebarExpanded = expanded ?? !this.sidebarExpanded;
		this.sidebarEl.toggleClass('is-expanded', this.sidebarExpanded);
		this.renderSessionList();
	}

	async loadSessions(): Promise<void> {
		if (!this.plugin.copilot) return;
		try {
			this.sessionList = await this.plugin.copilot.listSessions();
			this.sortSessionList();
			this.renderSessionList();
		} catch {
			// silently ignore — session list stays as-is
		}
	}

	sortSessionList(): void {
		switch (this.sessionSort) {
			case 'modified':
				this.sessionList.sort((a, b) => {
					const ta = a.modifiedTime instanceof Date ? a.modifiedTime.getTime() : new Date(a.modifiedTime).getTime();
					const tb = b.modifiedTime instanceof Date ? b.modifiedTime.getTime() : new Date(b.modifiedTime).getTime();
					return tb - ta;
				});
				break;
			case 'created':
				this.sessionList.sort((a, b) => {
					const ta = a.startTime instanceof Date ? a.startTime.getTime() : new Date(a.startTime).getTime();
					const tb = b.startTime instanceof Date ? b.startTime.getTime() : new Date(b.startTime).getTime();
					return tb - ta;
				});
				break;
			case 'name':
				this.sessionList.sort((a, b) => {
					const na = this.getSessionDisplayName(a).toLowerCase();
					const nb = this.getSessionDisplayName(b).toLowerCase();
					return na.localeCompare(nb);
				});
				break;
		}
	}

	renderSessionList(): void {
		if (!this.sidebarListEl) return;
		this.sidebarListEl.empty();

		const isExpanded = this.sidebarExpanded;
		// Show/hide search and filter/sort/refresh when collapsed
		if (this.sidebarSearchEl) {
			this.sidebarSearchEl.toggleClass('is-hidden', !isExpanded);
		}
		if (this.sidebarFilterEl) {
			this.sidebarFilterEl.toggleClass('is-hidden', !isExpanded);
		}
		if (this.sidebarSortEl) {
			this.sidebarSortEl.toggleClass('is-hidden', !isExpanded);
		}
		if (this.sidebarRefreshEl) {
			this.sidebarRefreshEl.toggleClass('is-hidden', !isExpanded);
		}
		if (this.sidebarDeleteEl) {
			this.sidebarDeleteEl.toggleClass('is-hidden', !isExpanded);
		}

		for (const session of this.sessionList) {
			// Apply type filter
			if (this.sessionTypeFilter.size > 0) {
				const type = this.getSessionType(session);
				if (!this.sessionTypeFilter.has(type)) continue;
			}

			const name = this.getSessionDisplayName(session);
			if (this.sessionFilter && !name.toLowerCase().includes(this.sessionFilter)) continue;

			this.renderSessionItem(this.sidebarListEl, session, {
				expanded: isExpanded,
				onClick: () => void this.selectSession(session.sessionId),
				onContextMenu: (e) => this.showSessionContextMenu(e, session.sessionId),
			});
		}

		// Keep trigger history in sync with session list
		this.renderTriggerHistory();
	}

	/** Render a single session item into a container. Shared by session list and trigger history. */
	renderSessionItem(container: HTMLElement, session: SessionMetadata, opts: {
		expanded?: boolean;
		onClick: () => void;
		onContextMenu: (e: MouseEvent) => void;
	}): void {
		const expanded = opts.expanded ?? true;
		const item = container.createDiv({cls: 'sidekick-session-item'});
		const isActive = session.sessionId === this.currentSessionId;
		if (isActive) item.addClass('is-active');

		const sessionType = this.getSessionType(session);
		const iconName = sessionType === 'chat' ? 'message-square' : sessionType === 'trigger' ? 'zap' : sessionType === 'inline' ? 'file-text' : sessionType === 'search' ? 'search' : 'code';
		const iconEl = item.createSpan({cls: 'sidekick-session-icon'});
		setIcon(iconEl, iconName);

		// Green active dot when processing (current or background session)
		const isCurrentStreaming = isActive && this.isStreaming;
		const bgSession = this.activeSessions.get(session.sessionId);
		const isBgStreaming = bgSession?.isStreaming ?? false;
		if (isCurrentStreaming || isBgStreaming) {
			iconEl.createSpan({cls: 'sidekick-session-active-dot'});
		}

		const name = this.getSessionDisplayName(session);
		if (expanded) {
			const details = item.createDiv({cls: 'sidekick-session-details'});
			details.createDiv({cls: 'sidekick-session-name', text: name});
			const modTime = session.modifiedTime instanceof Date
				? session.modifiedTime
				: new Date(session.modifiedTime);
			details.createDiv({cls: 'sidekick-session-time', text: this.formatTimeAgo(modTime)});
		}

		item.setAttribute('title', name);
		item.addEventListener('click', opts.onClick);
		item.addEventListener('contextmenu', opts.onContextMenu);
	}

	getSessionDisplayName(session: SessionMetadata): string {
		const raw = this.sessionNames[session.sessionId]
			|| session.summary
			|| `Session ${session.sessionId.slice(0, 8)}`;
		// Strip session type prefix for display
		return raw.replace(/^\[(chat|inline|trigger(?::[a-z0-9-]+)?|search)\]\s*/, '');
	}

	/** Return the session type prefix: 'chat', 'inline', 'trigger', 'search', or 'other'. */
	getSessionType(session: SessionMetadata): 'chat' | 'inline' | 'trigger' | 'search' | 'other' {
		const name = this.sessionNames[session.sessionId] || '';
		debugTrace(`Sidekick: getSessionType id=${session.sessionId.slice(0, 8)} name="${name.slice(0, 40)}"`);
		if (name.startsWith('[chat]')) return 'chat';
		if (name.startsWith('[inline]')) return 'inline';
		if (name.startsWith('[trigger]') || name.startsWith('[trigger:')) return 'trigger';
		if (name.startsWith('[search]')) return 'search';
		return 'other';
	}

	openSessionFilterMenu(e: MouseEvent): void {
		const menu = new Menu();
		const types: Array<{value: 'chat' | 'inline' | 'trigger' | 'search' | 'other'; label: string}> = [
			{value: 'chat', label: 'Chat'},
			{value: 'trigger', label: 'Triggers'},
			{value: 'search', label: 'Search'},
			{value: 'inline', label: 'Inline'},
			{value: 'other', label: 'Other'},
		];
		for (const {value, label} of types) {
			menu.addItem(item => {
				item.setTitle(label)
					.setChecked(this.sessionTypeFilter.has(value))
					.onClick(() => {
						if (this.sessionTypeFilter.has(value)) {
							this.sessionTypeFilter.delete(value);
						} else {
							this.sessionTypeFilter.add(value);
						}
						this.updateFilterBadge();
						this.renderSessionList();
					});
			});
		}
		menu.addSeparator();
		menu.addItem(item => {
			item.setTitle('Show all')
				.onClick(() => {
					this.sessionTypeFilter.clear();
					this.updateFilterBadge();
					this.renderSessionList();
				});
		});
		menu.showAtMouseEvent(e);
	}

	updateFilterBadge(): void {
		// When no types selected (show all), dim the icon; otherwise mark active
		const hasFilter = this.sessionTypeFilter.size > 0;
		this.sidebarFilterEl.toggleClass('is-active', hasFilter);
		this.sidebarFilterEl.setAttribute('title',
			hasFilter
				? `Filter: ${[...this.sessionTypeFilter].join(', ')}`
				: 'Filter sessions (showing all)');
	}

	openSessionSortMenu(e: MouseEvent): void {
		const menu = new Menu();
		const sorts: Array<{value: 'modified' | 'created' | 'name'; label: string}> = [
			{value: 'modified', label: 'Modified date'},
			{value: 'created', label: 'Created date'},
			{value: 'name', label: 'Name'},
		];
		for (const {value, label} of sorts) {
			menu.addItem(item => {
				item.setTitle(label)
					.setChecked(this.sessionSort === value)
					.onClick(() => {
						this.sessionSort = value;
						this.updateSortBadge();
						this.sortSessionList();
						this.renderSessionList();
					});
			});
		}
		menu.showAtMouseEvent(e);
	}

	updateSortBadge(): void {
		const labels: Record<string, string> = {modified: 'Modified', created: 'Created', name: 'Name'};
		this.sidebarSortEl.setAttribute('title', `Sort: ${labels[this.sessionSort]}`);
	}

	/**
	 * Public API: register an inline session so it appears in the sidebar.
	 * Called by editorMenu after completing an inline operation.
	 */
	public registerInlineSession(sessionId: string, description: string): void {
		this.sessionNames[sessionId] = `[inline] ${description}`;
		this.saveSessionNames();

		// Add to session list immediately so sidebar updates
		if (!this.sessionList.some(s => s.sessionId === sessionId)) {
			const now = new Date();
			this.sessionList.unshift({
				sessionId,
				startTime: now,
				modifiedTime: now,
				isRemote: false,
			} as SessionMetadata);
		}
		this.renderSessionList();
	}

	// ── Background session management ────────────────────────────

	/**
	 * Save the currently viewed session into the activeSessions map.
	 * If the session is streaming, events keep routing to the BackgroundSession.
	 * If idle, the session handle is preserved for quick switching.
	 */
	saveCurrentToBackground(): void {
		if (!this.currentSession || !this.currentSessionId) return;

		// Evict the oldest idle background session if at capacity
		const MAX_BACKGROUND_SESSIONS = 8;
		if (this.activeSessions.size >= MAX_BACKGROUND_SESSIONS) {
			let oldestKey: string | null = null;
			let oldestTime = Infinity;
			for (const [key, bg] of this.activeSessions) {
				if (bg.isStreaming) continue; // don't evict active streams
				const entry = this.sessionList.find(s => s.sessionId === key);
				const t = entry?.modifiedTime instanceof Date
					? entry.modifiedTime.getTime()
					: entry ? new Date(entry.modifiedTime).getTime() : 0;
				if (t < oldestTime) {
					oldestTime = t;
					oldestKey = key;
				}
			}
			if (oldestKey) {
				const evicted = this.activeSessions.get(oldestKey);
				if (evicted) {
					for (const unsub of evicted.unsubscribers) unsub();
					evicted.savedDom = null; // release DOM fragment
					try { void evicted.session.disconnect(); } catch { /* ignore */ }
					this.activeSessions.delete(oldestKey);
				}
			}
		}

		// Detach events from foreground routing
		this.unsubscribeEvents();

		// Save chat DOM into a DocumentFragment for fast restore
		const fragment = document.createDocumentFragment();
		while (this.chatContainer.firstChild) {
			fragment.appendChild(this.chatContainer.firstChild);
		}

		const bg: BackgroundSession = {
			sessionId: this.currentSessionId,
			session: this.currentSession,
			messages: [...this.messages],
			isStreaming: this.isStreaming,
			streamingContent: this.streamingContent,
			savedDom: fragment,
			unsubscribers: [],
			turnStartTime: this.turnStartTime,
			turnToolsUsed: [...this.turnToolsUsed],
			turnSkillsUsed: [...this.turnSkillsUsed],
			turnUsage: this.turnUsage ? {...this.turnUsage} : null,
			activeToolCalls: new Map(this.activeToolCalls),
			streamingComponent: this.streamingComponent,
			streamingBodyEl: this.streamingBodyEl,
			streamingWrapperEl: this.streamingWrapperEl,
			toolCallsContainer: this.toolCallsContainer,
		};

		// If still streaming, attach background event routing
		if (bg.isStreaming) {
			this.registerBackgroundEvents(bg);
		}

		this.activeSessions.set(this.currentSessionId, bg);

		// Detach streaming component from the view (it lives in the bg now)
		if (this.streamingComponent) {
			this.streamingComponent = null;
		}
		this.currentSession = null;
		this.currentSessionId = null;
	}

	/**
	 * Restore a BackgroundSession as the foreground session.
	 */
	async restoreFromBackground(bg: BackgroundSession): Promise<void> {
		// Unsubscribe background event routing
		for (const unsub of bg.unsubscribers) unsub();
		bg.unsubscribers = [];

		// Restore state
		this.currentSession = bg.session;
		this.currentSessionId = bg.sessionId;
		this.messages = bg.messages;
		this.isStreaming = bg.isStreaming;
		this.streamingContent = bg.streamingContent;
		this.turnStartTime = bg.turnStartTime;
		this.turnToolsUsed = bg.turnToolsUsed;
		this.turnSkillsUsed = bg.turnSkillsUsed;
		this.turnUsage = bg.turnUsage;
		this.configDirty = false;

		this.chatContainer.empty();

		if (bg.isStreaming && bg.savedDom) {
			// Session is still streaming — restore its live DOM (including streaming placeholder)
			this.streamingComponent = bg.streamingComponent;
			this.streamingBodyEl = bg.streamingBodyEl;
			this.streamingWrapperEl = bg.streamingWrapperEl;
			this.toolCallsContainer = bg.toolCallsContainer;
			this.activeToolCalls = bg.activeToolCalls;
			this.chatContainer.appendChild(bg.savedDom);
			bg.savedDom = null;
			// Re-render the streaming content that accumulated while in background
			if (this.streamingContent && this.streamingBodyEl) {
				void this.updateStreamingRender();
			}
		} else {
			// Session finished while in background — re-render messages from scratch
			this.streamingComponent = null;
			this.streamingBodyEl = null;
			this.streamingWrapperEl = null;
			this.toolCallsContainer = null;
			this.activeToolCalls.clear();
			const renderPromises: Promise<void>[] = [];
			for (const msg of this.messages) {
				renderPromises.push(this.renderMessageBubble(msg));
			}
			await Promise.all(renderPromises);
			if (this.messages.length === 0) {
				this.renderWelcome();
			}
		}

		// Re-attach foreground event routing
		this.registerSessionEvents();

		// Lock toolbar since session is active
		this.updateToolbarLock();

		// Remove from background map
		this.activeSessions.delete(bg.sessionId);

		// Restore agent from session name
		this.restoreAgentFromSessionName(bg.sessionId);

		// Force scroll to end
		this.forceScrollToBottom();
	}

	/**
	 * Register event handlers that route session events into a BackgroundSession
	 * object while the session is not being viewed.
	 */
	registerBackgroundEvents(bg: BackgroundSession): void {
		registerBgEvents(bg.session, bg, {
			onSessionFinished: () => {
				this.renderSessionList();
				void this.loadSessions();
			},
			onToolDiscovered: (mcpServer, toolName) => {
				this.trackDiscoveredTool(mcpServer, toolName);
			},
			onSessionEvent: (type, message, level) => {
				this.handleMcpSessionEvent(type, message, level);
			},
		});
	}

	/**
	 * Restore the agent and model dropdowns from a session's saved name.
	 */
	restoreAgentFromSessionName(sessionId: string): void {
		let sessionName = this.sessionNames[sessionId] || '';
		// Strip session type prefix
		sessionName = sessionName.replace(/^\[(chat|inline|trigger)\]\s*/, '');
		const colonIdx = sessionName.indexOf(':');
		if (colonIdx > 0) {
			const agentName = sessionName.substring(0, colonIdx).trim();
			if (this.agents.some(a => a.name === agentName)) {
				this.selectAgent(agentName);
			}
		}
	}

	async selectSession(sessionId: string): Promise<void> {
		if (sessionId === this.currentSessionId && this.currentSession) return;

		// ── Save current session to background (if streaming, keep it alive) ──
		if (this.currentSession && this.currentSessionId) {
			this.saveCurrentToBackground();
		}

		// Clear UI for the new session
		this.messages = [];
		this.streamingContent = '';
		this.streamingBodyEl = null;
		this.streamingWrapperEl = null;
		this.toolCallsContainer = null;
		this.activeToolCalls.clear();
		if (this.streamingComponent) {
			this.removeChild(this.streamingComponent);
			this.streamingComponent = null;
		}
		this.isStreaming = false;
		this.chatContainer.empty();

		// ── Check if the target session is already alive in background ──
		const bg = this.activeSessions.get(sessionId);
		if (bg) {
			await this.restoreFromBackground(bg);
			this.renderSessionList();
			this.updateSendButton();
			return;
		}

		// ── Otherwise, resume from SDK (cold load) ──

		try {
			// Build full session config so skills, MCP servers, etc. are available
			const agent = this.agents.find(a => a.name === this.selectedAgent);

			// Enrich Azure-authenticated MCP servers with fresh tokens before resume
			await enrichServersWithAzureAuth(this.mcpServers, this.enabledMcpServers);

			const sessionConfig = this.buildSessionConfig({
				model: this.selectedModel || undefined,
				systemContent: agent?.instructions || undefined,
			});

			this.currentSession = await this.plugin.copilot!.resumeSession(sessionId, {
				...sessionConfig,
			});
			this.currentSessionId = sessionId;
			this.configDirty = false;
			this.registerSessionEvents();
			this.updateToolbarLock();

			// Discover MCP tools for resumed session
			if (this.enabledMcpServers.size > 0) {
				this.scheduleMcpToolDiscovery();
			}

			// Load and render message history from SDK
			const events = await this.currentSession.getMessages();
			const renderPromises: Promise<void>[] = [];
			for (const event of events) {
				if (event.type === 'user.message') {
					const msg: ChatMessage = {
						id: event.id,
						role: 'user',
						content: event.data.content,
						timestamp: new Date(event.timestamp).getTime(),
					};
					this.messages.push(msg);
					renderPromises.push(this.renderMessageBubble(msg));
				} else if (event.type === 'assistant.message') {
					const msg: ChatMessage = {
						id: event.id,
						role: 'assistant',
						content: event.data.content,
						timestamp: new Date(event.timestamp).getTime(),
					};
					this.messages.push(msg);
					renderPromises.push(this.renderMessageBubble(msg));
				}
			}
			await Promise.all(renderPromises);

			if (this.messages.length === 0) {
				this.renderWelcome();
			}

			// Restore the agent that was used in this session
			this.restoreAgentFromSessionName(sessionId);

			// Force scroll to the end of the loaded conversation
			this.forceScrollToBottom();

			this.renderSessionList();
			this.updateSendButton();
		} catch (e) {
			this.addInfoMessage(`Failed to load session: ${String(e)}`);
			this.renderWelcome();
			this.currentSessionId = null;
			this.renderSessionList();
		}
	}

	showSessionContextMenu(e: MouseEvent, sessionId: string): void {
		e.preventDefault();
		e.stopPropagation();
		const menu = new Menu();

		menu.addItem(item => item
			.setTitle('Rename')
			.setIcon('pencil')
			.onClick(() => this.renameSession(sessionId)));

		menu.addItem(item => item
			.setTitle('Delete')
			.setIcon('trash-2')
			.onClick(() => void this.deleteSessionById(sessionId)));

		menu.showAtMouseEvent(e);
	}

	renameSession(sessionId: string): void {
		const rawName = this.sessionNames[sessionId] || '';
		// Extract prefix and display name
		const prefixMatch = rawName.match(/^(\[(chat|inline|trigger)\]\s*)/);
		const prefix = prefixMatch ? prefixMatch[1] : '';
		const displayName = prefix ? rawName.slice(prefix.length) : rawName;

		const modal = new Modal(this.app);
		modal.titleEl.setText('Rename session');

		const input = modal.contentEl.createEl('input', {
			type: 'text',
			value: displayName,
			cls: 'sidekick-rename-input',
		});


		const btnRow = modal.contentEl.createDiv({cls: 'sidekick-approval-buttons'});
		const saveBtn = btnRow.createEl('button', {cls: 'mod-cta', text: 'Save'});
		saveBtn.addEventListener('click', () => {
			const newName = input.value.trim();
			if (newName) {
				this.sessionNames[sessionId] = `${prefix}${newName}`;
				this.saveSessionNames();
				this.renderSessionList();
			}
			modal.close();
		});

		const cancelBtn = btnRow.createEl('button', {text: 'Cancel'});
		cancelBtn.addEventListener('click', () => modal.close());

		// Enter key to save
		input.addEventListener('keydown', (ke) => {
			if (ke.key === 'Enter') {
				ke.preventDefault();
				saveBtn.click();
			}
		});

		modal.open();
		input.focus();
		input.select();
	}

	async deleteSessionById(sessionId: string): Promise<void> {
		// Clean up background session if it exists
		const bg = this.activeSessions.get(sessionId);
		if (bg) {
			for (const unsub of bg.unsubscribers) unsub();
			try { await bg.session.disconnect(); } catch { /* ignore */ }
			if (bg.streamingComponent) {
				try { this.removeChild(bg.streamingComponent); } catch { /* ignore */ }
			}
			this.activeSessions.delete(sessionId);
		}

		try {
			await this.plugin.copilot!.deleteSession(sessionId);
		} catch (e) {
			new Notice(`Failed to delete session: ${String(e)}`);
			return;
		}

		delete this.sessionNames[sessionId];
		this.saveSessionNames();
		this.sessionList = this.sessionList.filter(s => s.sessionId !== sessionId);

		if (this.currentSessionId === sessionId) {
			this.currentSessionId = null;
			this.currentSession = null;
			this.newConversation();
		}

		this.renderSessionList();
		new Notice('Session deleted.');
	}

	confirmDeleteDisplayedSessions(): void {
		const displayed = this.getDisplayedSessions();
		if (displayed.length === 0) {
			new Notice('No sessions to delete.');
			return;
		}

		const modal = new Modal(this.app);
		modal.titleEl.setText('Delete sessions');
		modal.contentEl.createEl('p', {
			text: `Are you sure you want to delete ${displayed.length} session${displayed.length === 1 ? '' : 's'}?`,
		});
		const btnRow = modal.contentEl.createDiv({cls: 'modal-button-container'});
		btnRow.createEl('button', {text: 'Cancel', cls: 'mod-cancel'}).addEventListener('click', () => modal.close());
		const confirmBtn = btnRow.createEl('button', {text: 'Delete', cls: 'mod-warning'});
		confirmBtn.addEventListener('click', () => {
			modal.close();
			void this.deleteDisplayedSessions(displayed);
		});
		modal.open();
	}

	getDisplayedSessions(): SessionMetadata[] {
		return this.sessionList.filter(session => {
			if (this.sessionTypeFilter.size > 0) {
				const type = this.getSessionType(session);
				if (!this.sessionTypeFilter.has(type)) return false;
			}
			if (this.sessionFilter) {
				const name = this.getSessionDisplayName(session);
				if (!name.toLowerCase().includes(this.sessionFilter)) return false;
			}
			return true;
		});
	}

	async deleteDisplayedSessions(sessions: SessionMetadata[]): Promise<void> {
		let deleted = 0;
		for (const session of sessions) {
			try {
				await this.deleteSessionById(session.sessionId);
				deleted++;
			} catch { /* continue with remaining */ }
		}
		new Notice(`Deleted ${deleted} session${deleted === 1 ? '' : 's'}.`);
	}

	saveSessionNames(): void {
		this.plugin.settings.sessionNames = {...this.sessionNames};
		void this.plugin.saveSettings();
	}

	formatTimeAgo(d: Date): string {
		const now = Date.now();
		const diff = now - d.getTime();
		const minutes = Math.floor(diff / 60000);
		const hours = Math.floor(diff / 3600000);
		const days = Math.floor(diff / 86400000);

		if (minutes < 1) return 'Just now';
		if (minutes < 60) return `${minutes}m ago`;
		if (hours < 24) return `${hours}h ago`;
		if (days === 1) return 'Yesterday';
		if (days < 7) return `${days}d ago`;
		return d.toLocaleDateString();
	}

	// ── Tools panel — see view/toolsPanel.ts ────────────────────
	// ── Search panel ────────────────────────────────────────────

	buildSearchPanel(parent: HTMLElement): void {
		const wrapper = parent.createDiv({cls: 'sidekick-search-wrapper'});

		// ── Toolbar row: scope | mode toggle | [advanced: agent | model | skills | tools] ──
		const toolbar = wrapper.createDiv({cls: 'sidekick-toolbar sidekick-search-toolbar'});

		// Search scope (folder picker) — always visible
		this.searchCwdBtnEl = toolbar.createEl('button', {cls: 'clickable-icon sidekick-icon-btn', attr: {title: 'Search scope'}});
		setIcon(this.searchCwdBtnEl, 'folder');
		this.searchCwdBtnEl.addEventListener('click', () => this.openSearchScopePicker());
		this.updateSearchCwdButton();

		// Mode toggle (basic / advanced)
		this.searchModeToggleEl = toolbar.createEl('button', {cls: 'clickable-icon sidekick-icon-btn', attr: {title: 'Toggle basic/advanced mode'}});
		this.searchModeToggleEl.addEventListener('click', () => this.toggleSearchMode());
		this.updateSearchModeToggle();

		// Advanced controls group — hidden in basic mode
		this.searchAdvancedToolbarEl = toolbar.createDiv({cls: 'sidekick-search-advanced-group'});

		// Agent dropdown
		const agentGroup = this.searchAdvancedToolbarEl.createDiv({cls: 'sidekick-toolbar-group'});
		const agentIcon = agentGroup.createSpan({cls: 'sidekick-toolbar-icon'});
		setIcon(agentIcon, 'bot');
		this.searchAgentSelect = agentGroup.createEl('select', {cls: 'sidekick-select'});
		this.searchAgentSelect.addEventListener('change', () => {
			this.searchAgent = this.searchAgentSelect.value;
			const agent = this.agents.find(a => a.name === this.searchAgent);
			this.searchAgentSelect.title = agent ? agent.instructions : '';
			// Auto-select agent's preferred model
			const resolvedModel = this.resolveModelForAgent(agent, this.searchModel || undefined);
			if (resolvedModel && resolvedModel !== this.searchModel) {
				this.searchModel = resolvedModel;
				this.searchModelSelect.value = resolvedModel;
			}
			// Apply agent's tools and skills filter for search
			this.applySearchAgentToolsAndSkills(agent);
			// Persist
			this.plugin.settings.searchAgent = this.searchAgent;
			void this.plugin.saveSettings();
		});

		// Model dropdown
		const modelGroup = this.searchAdvancedToolbarEl.createDiv({cls: 'sidekick-toolbar-group'});
		const modelIcon = modelGroup.createSpan({cls: 'sidekick-toolbar-icon'});
		setIcon(modelIcon, 'cpu');
		this.searchModelSelect = modelGroup.createEl('select', {cls: 'sidekick-select sidekick-model-select'});
		this.searchModelSelect.addEventListener('change', () => {
			this.searchModel = this.searchModelSelect.value;
		});

		// Skills button
		this.searchSkillsBtnEl = this.searchAdvancedToolbarEl.createEl('button', {cls: 'clickable-icon sidekick-icon-btn', attr: {title: 'Skills'}});
		setIcon(this.searchSkillsBtnEl, 'wand-2');
		this.searchSkillsBtnEl.addEventListener('click', (e) => this.openSearchSkillsMenu(e));

		// Tools button
		this.searchToolsBtnEl = this.searchAdvancedToolbarEl.createEl('button', {cls: 'clickable-icon sidekick-icon-btn', attr: {title: 'Tools'}});
		setIcon(this.searchToolsBtnEl, 'plug');
		this.searchToolsBtnEl.addEventListener('click', (e) => this.openSearchToolsMenu(e));

		// Apply initial visibility
		this.updateSearchAdvancedVisibility();

		// ── Search input + button ──
		const inputRow = wrapper.createDiv({cls: 'sidekick-search-input-row'});
		this.searchInputEl = inputRow.createEl('textarea', {
			cls: 'sidekick-search-input',
			attr: {placeholder: 'Describe what you\'re looking for…', rows: '2'},
		});
		this.searchInputEl.addEventListener('keydown', (e) => {
			if (e.key === 'Enter' && !e.shiftKey) {
				e.preventDefault();
				void this.handleSearch();
			}
		});

		this.searchBtnEl = inputRow.createEl('button', {cls: 'sidekick-search-btn', attr: {title: 'Search'}});
		setIcon(this.searchBtnEl, 'search');
		this.searchBtnEl.addEventListener('click', () => void this.handleSearch());

		// ── Results area ──
		this.searchResultsEl = wrapper.createDiv({cls: 'sidekick-search-results'});
	}

	get searchMode(): 'basic' | 'advanced' {
		return this.plugin.settings.searchMode;
	}

	toggleSearchMode(): void {
		const newMode = this.searchMode === 'basic' ? 'advanced' : 'basic';
		this.plugin.settings.searchMode = newMode;
		void this.plugin.saveSettings();
		this.updateSearchModeToggle();
		this.updateSearchAdvancedVisibility();
		// Disconnect cached basic session when switching modes
		if (newMode === 'advanced' && this.basicSearchSession) {
			void this.basicSearchSession.disconnect().catch(() => {});
			this.basicSearchSession = null;
		}
	}

	updateSearchModeToggle(): void {
		this.searchModeToggleEl.empty();
		if (this.searchMode === 'basic') {
			setIcon(this.searchModeToggleEl, 'settings');
			this.searchModeToggleEl.title = 'Basic mode (fast) — click for advanced';
		} else {
			setIcon(this.searchModeToggleEl, 'settings');
			this.searchModeToggleEl.title = 'Advanced mode — click for basic (fast)';
		}
		this.searchModeToggleEl.toggleClass('is-active', this.searchMode === 'advanced');
	}

	updateSearchAdvancedVisibility(): void {
		this.searchAdvancedToolbarEl.toggleClass('is-hidden', this.searchMode !== 'advanced');
	}

	updateSearchConfigUI(): void {
		// Agents
		this.searchAgentSelect.empty();
		const noAgent = this.searchAgentSelect.createEl('option', {text: 'Agent', attr: {value: ''}});
		noAgent.value = '';
		for (const agent of this.agents) {
			const opt = this.searchAgentSelect.createEl('option', {text: agent.name});
			opt.value = agent.name;
			opt.title = agent.instructions;
		}

		// Restore saved search agent from settings
		const savedAgent = this.plugin.settings.searchAgent;
		if (savedAgent && this.agents.some(a => a.name === savedAgent)) {
			this.searchAgent = savedAgent;
			this.searchAgentSelect.value = savedAgent;
			const selAgent = this.agents.find(a => a.name === savedAgent);
			this.searchAgentSelect.title = selAgent ? selAgent.instructions : '';
		}

		// Auto-select agent's preferred model
		const agentConfig = this.agents.find(a => a.name === this.searchAgent);
		const resolvedModel = this.resolveModelForAgent(agentConfig, this.searchModel || undefined);
		if (resolvedModel) {
			this.searchModel = resolvedModel;
		}

		// Models
		this.searchModelSelect.empty();
		for (const model of this.models) {
			const opt = this.searchModelSelect.createEl('option', {text: model.name});
			opt.value = model.id;
		}
		if (this.searchModel && this.models.some(m => m.id === this.searchModel)) {
			this.searchModelSelect.value = this.searchModel;
		} else if (this.models.length > 0 && this.models[0]) {
			this.searchModel = this.models[0].id;
			this.searchModelSelect.value = this.searchModel;
		}

		// Apply agent's tools and skills filter
		this.applySearchAgentToolsAndSkills(agentConfig);
	}

	applySearchAgentToolsAndSkills(agent?: AgentConfig): void {
		// Tools: undefined = enable all, [] = disable all, [...] = enable listed.
		// Agent names in the tools list are sub-agent references, not MCP servers.
		if (agent?.tools !== undefined) {
			const agentNames = new Set(this.agents.map(a => a.name));
			const mcpOnly = agent.tools.filter(t => !agentNames.has(t));
			const allowed = new Set(mcpOnly);
			this.searchEnabledMcpServers = new Set(
				this.mcpServers.filter(s => allowed.has(s.name)).map(s => s.name)
			);
		} else {
			this.searchEnabledMcpServers = new Set(this.mcpServers.map(s => s.name));
		}

		// Skills: undefined = enable all, [] = disable all, [...] = enable listed
		if (agent?.skills !== undefined) {
			const allowed = new Set(agent.skills);
			this.searchEnabledSkills = new Set(
				this.skills.filter(s => allowed.has(s.name)).map(s => s.name)
			);
		} else {
			this.searchEnabledSkills = new Set(this.skills.map(s => s.name));
		}

		this.updateSearchSkillsBadge();
		this.updateSearchToolsBadge();
	}

	openSearchSkillsMenu(e: MouseEvent): void {
		const menu = new Menu();
		if (this.skills.length === 0) {
			menu.addItem(item => item.setTitle('No skills configured').setDisabled(true));
		} else {
			for (const skill of this.skills) {
				menu.addItem(item => {
					item.setTitle(skill.name)
						.setChecked(this.searchEnabledSkills.has(skill.name))
						.onClick(() => {
							if (this.searchEnabledSkills.has(skill.name)) {
								this.searchEnabledSkills.delete(skill.name);
							} else {
								this.searchEnabledSkills.add(skill.name);
							}
							this.updateSearchSkillsBadge();
						});
				});
			}
		}
		menu.showAtMouseEvent(e);
	}

	openSearchToolsMenu(e: MouseEvent): void {
		const menu = new Menu();
		if (this.mcpServers.length === 0) {
			menu.addItem(item => item.setTitle('No tools configured').setDisabled(true));
		} else {
			for (const server of this.mcpServers) {
				menu.addItem(item => {
					item.setTitle(server.name)
						.setChecked(this.searchEnabledMcpServers.has(server.name))
						.onClick(() => {
							if (this.searchEnabledMcpServers.has(server.name)) {
								this.searchEnabledMcpServers.delete(server.name);
							} else {
								this.searchEnabledMcpServers.add(server.name);
							}
							this.updateSearchToolsBadge();
						});
				});
			}
		}
		menu.showAtMouseEvent(e);
	}

	updateSearchSkillsBadge(): void {
		const count = this.searchEnabledSkills.size;
		this.searchSkillsBtnEl.toggleClass('is-active', count > 0);
		this.searchSkillsBtnEl.setAttribute('title', count > 0 ? `Skills (${count} active)` : 'Skills');
	}

	updateSearchToolsBadge(): void {
		const count = this.searchEnabledMcpServers.size;
		this.searchToolsBtnEl.toggleClass('is-active', count > 0);
		this.searchToolsBtnEl.setAttribute('title', count > 0 ? `Tools (${count} active)` : 'Tools');
	}

	openSearchScopePicker(): void {
		new FolderTreeModal(this.app, this.searchWorkingDir, (folder) => {
			this.searchWorkingDir = folder.path;
			this.updateSearchCwdButton();
		}).open();
	}

	updateSearchCwdButton(): void {
		const vaultName = this.app.vault.getName();
		const label = this.searchWorkingDir
			? `Search scope: ${vaultName}/${this.searchWorkingDir}`
			: `Search scope: ${vaultName} (entire vault)`;
		this.searchCwdBtnEl.setAttribute('title', label);
		this.searchCwdBtnEl.toggleClass('is-active', !!this.searchWorkingDir);
	}

	getSearchWorkingDirectory(): string {
		const base = this.getVaultBasePath();
		if (!this.searchWorkingDir) return base;
		return base + '/' + normalizePath(this.searchWorkingDir);
	}

	async handleSearch(): Promise<void> {
		if (this.isSearching) {
			// Cancel in-progress search
			const session = this.searchMode === 'basic' ? this.basicSearchSession : this.searchSession;
			if (session) {
				try { await session.abort(); } catch { /* ignore */ }
			}
			if (this.searchMode === 'advanced' && this.searchSession) {
				try { await this.searchSession.disconnect(); } catch { /* ignore */ }
				this.searchSession = null;
			}
			this.isSearching = false;
			this.updateSearchButton();
			return;
		}

		const query = this.searchInputEl.value.trim();
		if (!query) return;

		if (!this.plugin.copilot) {
			new Notice('Copilot is not configured.');
			return;
		}

		this.isSearching = true;
		this.updateSearchButton();
		this.searchResultsEl.empty();
		this.searchResultsEl.createDiv({cls: 'sidekick-search-loading', text: 'Searching…'});

		try {
			if (this.searchMode === 'basic') {
				await this.handleBasicSearch(query);
			} else {
				await this.handleAdvancedSearch(query);
			}
		} catch (e) {
			if (this.isSearching) {
				this.searchResultsEl.empty();
				this.searchResultsEl.createDiv({cls: 'sidekick-search-empty', text: `Search failed: ${String(e)}`});
			}
		} finally {
			this.isSearching = false;
			this.updateSearchButton();
		}
	}

	async handleBasicSearch(query: string): Promise<void> {
		// Check cache first
		const scopePath = this.getSearchWorkingDirectory();
		const cacheKey = this.buildSearchCacheKey(query, 'basic', [scopePath]);
		const cached = this.searchCache.get(cacheKey);
		if (cached && Date.now() - cached.cachedAt < SidekickView.SEARCH_CACHE_TTL) {
			this.renderSearchResults(cached.content, true);
			return;
		}

		// Phase 1: Local pre-filter using metadata (instant)
		const candidates = this.vaultIndex?.preFilter(query, [this.searchWorkingDir || '/'], 25) ?? [];

		// Reuse persistent session; create only if missing
		if (!this.basicSearchSession) {
			this.basicSearchSession = await this.plugin.copilot!.createSession(this.buildBasicSearchSessionConfig());
		}

		const scopeLabel = this.searchWorkingDir || this.app.vault.getName();

		let searchPrompt: string;
		let attachments: NonNullable<MessageOptions['attachments']> | undefined;

		if (candidates.length > 0) {
			// Phase 2: Build compact summaries for LLM re-ranking
			const summaries = candidates.map(c => ({
				file: c.note.path,
				folder: c.note.folder,
				tags: c.note.tags.slice(0, 5),
				headings: c.note.headings.slice(0, 5),
				matchReasons: c.matchReasons,
				score: c.score,
			}));

			searchPrompt = [
				'Re-rank these search candidates by relevance to the query.',
				'Return ONLY a JSON array of objects with "file", "folder", and "reason".',
				'Sort by relevance (best first). No markdown fences, no extra text.',
				'',
				`Query: ${query}`,
				'',
				'Candidates:',
				JSON.stringify(summaries, null, 2),
			].join('\n');
			attachments = undefined; // No directory attachment — candidates already narrowed
		} else {
			// No metadata matches — fall back to full LLM search
			searchPrompt = `Perform a semantic search for files matching the following query. Return ONLY a JSON array of objects, each with "file" (vault-relative path), "folder" (parent folder path), and "reason" (brief description why it matches). Sort by relevance (best match first). No markdown fences, no extra text.\n\nQuery: ${query}`;
			attachments = [{type: 'directory', path: scopePath, displayName: scopeLabel}];
		}

		try {
			const timeout = candidates.length > 0 ? 30_000 : 120_000;
			const response = await this.basicSearchSession.sendAndWait({
				prompt: searchPrompt,
				attachments,
			}, timeout);
			const content = response?.data.content || '';
			this.addToSearchCache(cacheKey, {content, cachedAt: Date.now(), scopePaths: [scopePath], mode: 'basic'});
			this.renderSearchResults(content);
		} catch (e) {
			// Session may be broken — discard and rethrow so outer catch handles it
			try { await this.basicSearchSession.disconnect(); } catch { /* ignore */ }
			this.basicSearchSession = null;
			throw e;
		}
	}

	async handleAdvancedSearch(query: string): Promise<void> {
		// Check cache first
		const scopePath = this.getSearchWorkingDirectory();
		const agentKey = this.searchAgent || undefined;
		const cacheKey = this.buildSearchCacheKey(query, 'advanced', [scopePath], agentKey);
		const cached = this.searchCache.get(cacheKey);
		if (cached && Date.now() - cached.cachedAt < SidekickView.SEARCH_CACHE_TTL) {
			this.renderSearchResults(cached.content, true);
			return;
		}

		const sessionConfig = this.buildSearchSessionConfig();
		this.searchSession = await this.plugin.copilot!.createSession(sessionConfig);
		const sessionId = this.searchSession.sessionId;

		// Name the session
		const agentLabel = this.searchAgent || 'Search';
		const truncated = query.length > 40 ? query.slice(0, 40) + '…' : query;
		this.sessionNames[sessionId] = `[search] ${agentLabel}: ${truncated}`;
		this.saveSessionNames();

		// Add to session list
		if (!this.sessionList.some(s => s.sessionId === sessionId)) {
			const now = new Date();
			this.sessionList.unshift({
				sessionId,
				startTime: now,
				modifiedTime: now,
				isRemote: false,
			} as SessionMetadata);
		}
		this.renderSessionList();

		// Pre-filter hints for the LLM
		const preFilterCandidates = this.vaultIndex?.preFilter(query, [this.searchWorkingDir || '/'], 15) ?? [];
		const hint = preFilterCandidates.length > 0
			? `\n\nLocal pre-filter found ${preFilterCandidates.length} likely matches:\n` +
				preFilterCandidates.map(c => `- ${c.note.path} (${c.matchReasons.join(', ')})`).join('\n') +
				'\n\nUse these as starting points, but search beyond them if needed.'
			: '';

		const searchPrompt = `Perform a semantic search for files matching the following query. Return ONLY a JSON array of objects, each with "file" (vault-relative path), "folder" (parent folder path), and "reason" (brief description why it matches). Sort by relevance (best match first). No markdown fences, no extra text.${hint}\n\nQuery: ${query}`;

		const scopeLabel = this.searchWorkingDir || this.app.vault.getName();
		try {
			const response = await this.searchSession.sendAndWait({
				prompt: searchPrompt,
				attachments: [{type: 'directory', path: scopePath, displayName: scopeLabel}],
			}, 120_000);
			const content = response?.data.content || '';
			this.addToSearchCache(cacheKey, {content, cachedAt: Date.now(), scopePaths: [scopePath], mode: 'advanced', agent: agentKey});
			this.renderSearchResults(content);
		} finally {
			if (this.searchSession) {
				try { await this.searchSession.disconnect(); } catch { /* ignore */ }
				this.searchSession = null;
			}
		}
	}

	/** Minimal session config for basic search — no MCP servers, skills, or custom agents. */
	buildBasicSearchSessionConfig(): SessionConfig {
		const permissionHandler = (request: PermissionRequest): PermissionRequestResult | Promise<PermissionRequestResult> => {
			if (this.plugin.settings.toolApproval === 'allow') {
				return {kind: 'approve-once'};
			}
			const modal = new ToolApprovalModal(this.app, request);
			modal.open();
			return modal.promise;
		};

		// Use inline model setting, fall back to first available model
		let model = this.plugin.settings.inlineModel || undefined;
		if (!model && this.models.length > 0 && this.models[0]) {
			model = this.models[0].id;
		}

		// BYOK provider
		const provider = buildProviderConfig(this.plugin.settings);
		const providerPreset = this.plugin.settings.providerPreset;

		return {
			model: (provider && this.plugin.settings.providerModel) ? this.plugin.settings.providerModel : model,
			streaming: providerPreset !== 'foundry-local',
			onPermissionRequest: permissionHandler,
			workingDirectory: this.getSearchWorkingDirectory(),
			...(provider ? {provider} : {}),
		};
	}

	renderSearchResults(content: string, fromCache = false): void {
		this.searchResultsEl.empty();

		if (fromCache) {
			this.searchResultsEl.createDiv({cls: 'sidekick-search-cached', text: 'Cached results'});
		}

		// Try to parse JSON array from the response
		let results: Array<{file?: string; path?: string; folder: string; reason: string}> = [];
		try {
			// Strip markdown fences if present
			const cleaned = content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
			const parsed = JSON.parse(cleaned);
			// Handle both single object and array responses
			results = Array.isArray(parsed) ? parsed : [parsed];
		} catch {
			// If not valid JSON, show the raw response
			this.searchResultsEl.createDiv({cls: 'sidekick-search-empty', text: content || 'No results found.'});
			return;
		}

		if (!Array.isArray(results) || results.length === 0) {
			this.searchResultsEl.createDiv({cls: 'sidekick-search-empty', text: 'No results found.'});
			return;
		}

		for (const result of results) {
			const item = this.searchResultsEl.createDiv({cls: 'sidekick-search-result'});

			const fileRow = item.createDiv({cls: 'sidekick-search-result-file'});
			const fileIcon = fileRow.createSpan({cls: 'sidekick-search-result-icon'});
			setIcon(fileIcon, 'file-text');
			const filePath = (result.file || result.path || '').replace(/^\/+/, '');
			const fileName = filePath.split('/').pop() || filePath || 'Unknown';
			const fileLink = fileRow.createSpan({cls: 'sidekick-search-result-name', text: fileName});

			fileLink.addEventListener('click', () => {
				if (!filePath) return;
				const resolved = this.app.vault.getAbstractFileByPath(filePath)
					?? (result.folder ? this.app.vault.getAbstractFileByPath(result.folder + '/' + filePath) : null);
				if (resolved instanceof TFile) {
					void this.app.workspace.openLinkText(resolved.path, '', false);
				} else {
					// Fallback: let Obsidian try to resolve the link
					void this.app.workspace.openLinkText(filePath, '', false);
				}
			});

			if (result.folder) {
				fileRow.createSpan({cls: 'sidekick-search-result-folder', text: result.folder});
			}

			if (result.reason) {
				item.createDiv({cls: 'sidekick-search-result-reason', text: result.reason});
			}
		}
	}

	// ── Search cache helpers ─────────────────────────────────────

	buildSearchCacheKey(query: string, mode: 'basic' | 'advanced', scopePaths: string[], agent?: string): string {
		const normalized = [
			query.trim().toLowerCase(),
			mode,
			[...scopePaths].sort().join('|'),
			agent ?? '',
		].join('\0');
		let hash = 0;
		for (let i = 0; i < normalized.length; i++) {
			hash = ((hash << 5) - hash + normalized.charCodeAt(i)) | 0;
		}
		return hash.toString(36);
	}

	addToSearchCache(key: string, entry: {content: string; cachedAt: number; scopePaths: string[]; mode: 'basic' | 'advanced'; agent?: string}): void {
		if (this.searchCache.size >= SidekickView.SEARCH_CACHE_MAX) {
			let oldestKey = '';
			let oldestTime = Infinity;
			for (const [k, v] of this.searchCache) {
				if (v.cachedAt < oldestTime) {
					oldestTime = v.cachedAt;
					oldestKey = k;
				}
			}
			if (oldestKey) this.searchCache.delete(oldestKey);
		}
		this.searchCache.set(key, entry);
	}

	invalidateSearchCache(): void {
		if (this.searchCache.size > 0) {
			this.searchCache.clear();
		}
	}

	updateSearchButton(): void {
		this.searchBtnEl.empty();
		if (this.isSearching) {
			setIcon(this.searchBtnEl, 'square');
			this.searchBtnEl.title = 'Cancel search';
			this.searchBtnEl.addClass('is-searching');
		} else {
			setIcon(this.searchBtnEl, 'search');
			this.searchBtnEl.title = 'Search';
			this.searchBtnEl.removeClass('is-searching');
		}
	}

	scrollToBottom(): void {
		// Only auto-scroll if user is near the bottom.
		// Scroll immediately (no extra rAF) since callers are already in
		// rAF or post-render context — an extra frame delay during streaming
		// causes the threshold check to desync and lose auto-scroll.
		const threshold = 200;
		const el = this.chatContainer;
		const isNear = el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
		if (isNear) {
			el.scrollTop = el.scrollHeight;
		}
	}

	forceScrollToBottom(): void {
		// Double rAF ensures layout is complete after markdown rendering
		window.requestAnimationFrame(() => {
			window.requestAnimationFrame(() => {
				this.chatContainer.scrollTop = this.chatContainer.scrollHeight;
			});
		});
	}
}

// ── Install feature modules ─────────────────────────────────────
// These extend SidekickView.prototype with methods organized by feature area.
import {installChatRenderer} from './view/chatRenderer';
import {installSearchPanel} from './view/searchPanel';
import {installTriggersPanel} from './view/triggersPanel';
import {installSessionSidebar} from './view/sessionSidebar';
import {installInputArea} from './view/inputArea';
import {installConfigToolbar} from './view/configToolbar';
import {installToolsPanel, OIL_SERVER_NAME, buildOilServerEntry} from './view/toolsPanel';
import {installPromptsPanel} from './view/promptsPanel';
import {installSkillsPanel} from './view/skillsPanel';
import {installChatSession} from './view/chatSession';
import {installActiveNote} from './view/activeNote';
import {installActionBars} from './view/actionBars';
import {installPromptSlash} from './view/promptSlash';
import {installBuiltinCommands} from './view/builtinCommands';
import {installAgentMention} from './view/agentMention';
import {installContextTracker} from './view/contextTracker';
import {installSessionConfigMixin} from './view/sessionConfig';

installChatRenderer(SidekickView);
installSearchPanel(SidekickView);
installTriggersPanel(SidekickView);
installSessionSidebar(SidekickView);
installInputArea(SidekickView);
installConfigToolbar(SidekickView);
installToolsPanel(SidekickView);
installPromptsPanel(SidekickView);
installSkillsPanel(SidekickView);
installChatSession(SidekickView);
installActiveNote(SidekickView);
installActionBars(SidekickView);
installPromptSlash(SidekickView);
installBuiltinCommands(SidekickView);
installAgentMention(SidekickView);
installContextTracker(SidekickView);
installSessionConfigMixin(SidekickView);
