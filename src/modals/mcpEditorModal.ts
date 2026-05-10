import {App, Modal, Notice, TFile, normalizePath, setIcon} from 'obsidian';
import {
	probeMcpServer,
	enrichServersWithAzureAuth,
	isProxyOnlyServer,
	isAgencyAvailable,
} from '../mcpProbe';
import type {McpServerEntry} from '../types';

/** Connection status for a single MCP server card. */
type ServerStatus = 'idle' | 'testing' | 'connected' | 'skipped' | 'error' | 'invalid';

/** Trust classification for an MCP server. */
type TrustLevel = 'verified' | 'local' | 'unverified';

/**
 * Trusted host patterns — servers whose URLs match one of these are treated as
 * "verified" (first-party / well-known). Everything else with a URL is
 * "unverified" and gets a security warning.
 */
const TRUSTED_HOSTS: RegExp[] = [
	/\.microsoft\.com$/i,
	/\.azure\.com$/i,
	/\.azure\.net$/i,
	/\.windows\.net$/i,
	/\.github\.com$/i,
	/\.github\.io$/i,
	/\.openai\.com$/i,
	/^localhost$/i,
	/^127\.0\.0\.1$/,
	/^\[::1\]$/,
	/^0\.0\.0\.0$/,
];

/** Classify a server's trust level based on its transport + URL. */
function classifyTrust(transport: string, cfg: Record<string, unknown>): TrustLevel {
	// Local stdio servers are inherently local (they run on this machine).
	if (transport === 'stdio') return 'local';
	const url = cfg['url'] as string | undefined;
	if (!url) return 'unverified';
	try {
		const parsed = new URL(url);
		const host = parsed.hostname;
		if (TRUSTED_HOSTS.some(p => p.test(host))) return 'verified';
	} catch { /* bad URL — unverified */ }
	return 'unverified';
}

interface ServerState {
	name: string;
	cfg: Record<string, unknown>;
	transport: 'stdio' | 'http' | 'sse' | 'unknown';
	endpointHint: string;
	configIssues: string[];
	status: ServerStatus;
	trustLevel: TrustLevel;
	resultText?: string;
	tools?: {name: string; description: string}[];
	rowEl?: HTMLElement;
	statusEl?: HTMLElement;
	resultEl?: HTMLElement;
	testBtn?: HTMLButtonElement;
	expanded?: boolean;
}

/**
 * Modal to view/edit the mcp.json configuration file directly from the tools view.
 *
 * Provides:
 *  - Live JSON syntax validation with helpful error messages
 *  - Per-server structural checks (missing url, type, etc.)
 *  - Auto-probe on open + per-server test button — status reflects ACTUAL
 *    MCP connectivity (not just JSON validity)
 *  - Format JSON, Reset, Save, Test all controls
 */
export class McpEditorModal extends Modal {
	private readonly mcpPath: string;
	private textArea!: HTMLTextAreaElement;
	private errorEl!: HTMLElement;
	private serversEl!: HTMLElement;
	private summaryEl!: HTMLElement;
	private saveBtn!: HTMLButtonElement;
	private onSaved: () => void;
	private originalText = '';
	private serverStates: ServerState[] = [];
	private autoProbeTimer: number | null = null;

	constructor(app: App, toolsFolder: string, onSaved: () => void) {
		super(app);
		this.mcpPath = normalizePath(`${toolsFolder}/mcp.json`);
		this.onSaved = onSaved;
	}

	async onOpen(): Promise<void> {
		const {contentEl, modalEl} = this;
		contentEl.empty();
		contentEl.addClass('sidekick-mcp-editor-modal');
		modalEl.addClass('sidekick-mcp-editor-modal-wrapper');

		// ── Header ─────────────────────────────────────
		const header = contentEl.createDiv({cls: 'sidekick-mcp-editor-head'});
		const titleWrap = header.createDiv({cls: 'sidekick-mcp-editor-title-wrap'});
		const titleIcon = titleWrap.createSpan({cls: 'sidekick-mcp-editor-title-icon'});
		setIcon(titleIcon, 'plug-zap');
		titleWrap.createEl('h3', {text: 'MCP servers', cls: 'sidekick-mcp-editor-title'});
		const pathHint = header.createDiv({cls: 'sidekick-mcp-editor-path'});
		pathHint.setText(this.mcpPath);
		pathHint.setAttribute('title', this.mcpPath);

		// Load existing file content
		let content = '';
		const file = this.app.vault.getAbstractFileByPath(this.mcpPath);
		if (file && file instanceof TFile) {
			content = await this.app.vault.read(file);
		} else {
			content = JSON.stringify({servers: {}}, null, '\t');
		}
		this.originalText = content;

		// ── Server status list (above the editor for visibility) ─
		this.summaryEl = contentEl.createDiv({cls: 'sidekick-mcp-editor-summary'});
		this.serversEl = contentEl.createDiv({cls: 'sidekick-mcp-editor-servers'});

		// ── Editor toolbar + textarea ──────────────────
		const editorWrap = contentEl.createDiv({cls: 'sidekick-mcp-editor-editor-wrap'});
		const editorBar = editorWrap.createDiv({cls: 'sidekick-mcp-editor-editor-bar'});
		editorBar.createSpan({cls: 'sidekick-mcp-editor-editor-label', text: 'mcp.json'});
		const editorActions = editorBar.createDiv({cls: 'sidekick-mcp-editor-editor-actions'});
		const formatBtn = editorActions.createEl('button', {
			cls: 'clickable-icon sidekick-mcp-editor-icon-btn',
			attr: {title: 'Format JSON'},
		});
		setIcon(formatBtn, 'wand-2');
		formatBtn.addEventListener('click', () => this.formatJson());
		const resetBtn = editorActions.createEl('button', {
			cls: 'clickable-icon sidekick-mcp-editor-icon-btn',
			attr: {title: 'Revert unsaved changes'},
		});
		setIcon(resetBtn, 'rotate-ccw');
		resetBtn.addEventListener('click', () => this.revert());

		this.textArea = editorWrap.createEl('textarea', {
			cls: 'sidekick-mcp-editor-textarea',
		});
		this.textArea.value = content;
		this.textArea.spellcheck = false;
		this.textArea.addEventListener('input', () => this.scheduleValidate());
		this.textArea.addEventListener('keydown', (e) => this.handleEditorKey(e));

		// Error message area (under editor)
		this.errorEl = contentEl.createDiv({cls: 'sidekick-mcp-editor-error'});

		// ── Footer button row ──────────────────────────
		const btnRow = contentEl.createDiv({cls: 'sidekick-mcp-editor-buttons'});

		const testAllBtn = btnRow.createEl('button', {cls: 'sidekick-mcp-editor-secondary-btn'});
		const testIcon = testAllBtn.createSpan({cls: 'sidekick-mcp-editor-btn-icon'});
		setIcon(testIcon, 'zap');
		testAllBtn.createSpan({text: 'Test all'});
		testAllBtn.addEventListener('click', () => void this.testAllServers(true));

		btnRow.createDiv({cls: 'sidekick-mcp-editor-spacer'});

		const cancelBtn = btnRow.createEl('button', {text: 'Cancel'});
		cancelBtn.addEventListener('click', () => this.close());

		this.saveBtn = btnRow.createEl('button', {cls: 'mod-cta', text: 'Save'});
		this.saveBtn.addEventListener('click', () => void this.save());

		// Initial render + auto-probe
		this.validate();
		void this.testAllServers(false);
	}

	onClose(): void {
		if (this.autoProbeTimer !== null) {
			window.clearTimeout(this.autoProbeTimer);
			this.autoProbeTimer = null;
		}
		this.contentEl.empty();
	}

	// ── Editor helpers ─────────────────────────────────
	private handleEditorKey(e: KeyboardEvent): void {
		if (e.key === 'Tab') {
			e.preventDefault();
			const start = this.textArea.selectionStart;
			const end = this.textArea.selectionEnd;
			const value = this.textArea.value;
			this.textArea.value = value.substring(0, start) + '\t' + value.substring(end);
			this.textArea.selectionStart = this.textArea.selectionEnd = start + 1;
			this.scheduleValidate();
		}
	}

	private formatJson(): void {
		const text = this.textArea.value.trim();
		if (!text) return;
		try {
			const parsed = JSON.parse(text);
			this.textArea.value = JSON.stringify(parsed, null, '\t');
			this.validate();
		} catch (e) {
			new Notice(`Cannot format: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	private revert(): void {
		this.textArea.value = this.originalText;
		this.validate();
		void this.testAllServers(false);
	}

	private scheduleValidate(): void {
		// Validate immediately; only the auto-probe is debounced
		this.validate();
		if (this.autoProbeTimer !== null) {
			window.clearTimeout(this.autoProbeTimer);
		}
		this.autoProbeTimer = window.setTimeout(() => {
			this.autoProbeTimer = null;
			void this.testAllServers(false);
		}, 1500);
	}

	/** Validate JSON, check server structure, and render per-server status. */
	// ── Validation pipeline ────────────────────────────
	/**
	 * Parse + structurally validate the JSON, rebuild server states, and re-render
	 * the cards. Connection status is preserved across re-renders for unchanged
	 * server entries (so editing one server doesn't reset all probe results).
	 */
	private validate(): boolean {
		const text = this.textArea.value.trim();
		this.errorEl.empty();
		this.textArea.removeClass('is-invalid');

		if (!text) {
			this.saveBtn.disabled = false;
			this.serverStates = [];
			this.renderServerCards();
			this.updateSummary();
			return true;
		}

		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch (e) {
			const msg = e instanceof SyntaxError ? e.message : String(e);
			this.showError(`Invalid JSON: ${msg}`);
			this.serverStates = [];
			this.renderServerCards();
			this.updateSummary();
			return false;
		}

		if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
			this.showError('JSON must be an object (e.g. { "servers": { ... } })');
			this.serverStates = [];
			this.renderServerCards();
			this.updateSummary();
			return false;
		}

		const root = parsed as Record<string, unknown>;
		const serversObj =
			(root['servers'] as Record<string, unknown> | undefined) ??
			(root['mcpServers'] as Record<string, unknown> | undefined);

		if (!serversObj || typeof serversObj !== 'object') {
			this.showWarning('Tip: Add a "servers" or "mcpServers" key to define MCP servers.');
			this.saveBtn.disabled = false;
			this.serverStates = [];
			this.renderServerCards();
			this.updateSummary();
			return true;
		}

		// Build new states, preserving prior probe results when the config hasn't changed.
		const prevByName = new Map(this.serverStates.map(s => [s.name, s] as const));
		const next: ServerState[] = [];
		for (const [name, rawCfg] of Object.entries(serversObj)) {
			next.push(this.buildServerState(name, rawCfg, prevByName.get(name)));
		}
		this.serverStates = next;
		this.renderServerCards();
		this.updateSummary();
		this.saveBtn.disabled = false;
		return true;
	}

	private buildServerState(
		name: string,
		rawCfg: unknown,
		prev: ServerState | undefined,
	): ServerState {
		const issues: string[] = [];
		let cfg: Record<string, unknown> = {};
		let transport: ServerState['transport'] = 'unknown';
		let endpointHint = '';

		if (!rawCfg || typeof rawCfg !== 'object' || Array.isArray(rawCfg)) {
			return {
				name,
				cfg: {},
				transport: 'unknown',
				endpointHint: '',
				configIssues: ['Config must be an object'],
				status: 'invalid',
				trustLevel: 'unverified',
				resultText: 'Invalid config',
			};
		}

		cfg = rawCfg as Record<string, unknown>;
		const serverType = cfg['type'] as string | undefined;

		if (serverType === 'http' || serverType === 'sse') {
			transport = serverType;
			const url = cfg['url'];
			if (!url || typeof url !== 'string') {
				issues.push('Missing "url"');
			} else {
				endpointHint = url;
			}
		} else if (cfg['command']) {
			transport = 'stdio';
			const cmd = String(cfg['command']);
			const args = (cfg['args'] as unknown[] | undefined) ?? [];
			endpointHint = [cmd, ...args.map(String)].join(' ');
		} else if (!serverType) {
			issues.push('Missing "type" or "command"');
		}

		const tools = cfg['tools'];
		if (tools !== undefined && !Array.isArray(tools)) {
			issues.push('"tools" must be an array');
		}

		// Preserve previous probe result if config hasn't changed
		const cfgChanged = !prev || JSON.stringify(prev.cfg) !== JSON.stringify(cfg);

		return {
			name,
			cfg,
			transport,
			endpointHint,
			configIssues: issues,
			status: issues.length > 0 ? 'invalid'
				: cfgChanged ? 'idle'
				: prev.status,
			trustLevel: classifyTrust(transport, cfg),
			resultText: cfgChanged ? undefined : prev?.resultText,
			tools: cfgChanged ? undefined : prev?.tools,
			expanded: cfgChanged ? false : prev?.expanded,
		};
	}

	// ── Card rendering ─────────────────────────────────
	private renderServerCards(): void {
		this.serversEl.empty();
		if (this.serverStates.length === 0) {
			const empty = this.serversEl.createDiv({cls: 'sidekick-mcp-editor-empty'});
			empty.setText('No servers defined yet. Add entries under "servers" in the editor below.');
			return;
		}

		// Show a security banner if any server is unverified
		const hasUnverified = this.serverStates.some(s => s.trustLevel === 'unverified');
		if (hasUnverified) {
			const banner = this.serversEl.createDiv({cls: 'sidekick-mcp-editor-security-banner'});
			const bannerIcon = banner.createSpan({cls: 'sidekick-mcp-editor-security-banner-icon'});
			setIcon(bannerIcon, 'shield-alert');
			const bannerText = banner.createDiv({cls: 'sidekick-mcp-editor-security-banner-text'});
			bannerText.createEl('strong', {text: 'Security notice'});
			bannerText.createEl('span', {
				text: ' — One or more servers point to external URLs that are not from a recognized provider. '
					+ 'MCP servers can read and modify your vault data. Only add servers you trust.',
			});
		}

		for (const state of this.serverStates) {
			this.renderCard(state);
		}
	}

	private renderCard(state: ServerState): void {
		const card = this.serversEl.createDiv({cls: 'sidekick-mcp-editor-card'});
		state.rowEl = card;

		// Status indicator (left)
		const status = card.createDiv({cls: 'sidekick-mcp-editor-card-status'});
		state.statusEl = status;
		this.applyStatusVisual(state);

		// Body (center)
		const body = card.createDiv({cls: 'sidekick-mcp-editor-card-body'});
		const titleRow = body.createDiv({cls: 'sidekick-mcp-editor-card-title-row'});
		titleRow.createSpan({cls: 'sidekick-mcp-editor-card-name', text: state.name});

		// Transport tag
		if (state.transport !== 'unknown') {
			const tag = titleRow.createSpan({
				cls: `sidekick-mcp-editor-card-tag is-${state.transport}`,
				text: state.transport,
			});
			tag.setAttribute('title', `Transport: ${state.transport}`);
		}

		// Proxy badge for agent365 servers
		if (state.cfg['url'] && isProxyOnlyServer({name: state.name, config: state.cfg})) {
			const proxy = titleRow.createSpan({cls: 'sidekick-mcp-editor-card-tag is-proxy'});
			proxy.setText(isAgencyAvailable() ? 'agency proxy' : 'needs agency');
			proxy.setAttribute('title', isAgencyAvailable()
				? 'Routed through local agency CLI proxy'
				: 'Install agency CLI to connect (https://aka.ms/agency)');
		}

		// Trust badge
		if (state.trustLevel === 'verified') {
			const badge = titleRow.createSpan({cls: 'sidekick-mcp-editor-card-tag is-verified'});
			const icon = badge.createSpan({cls: 'sidekick-mcp-editor-trust-icon'});
			setIcon(icon, 'shield-check');
			badge.createSpan({text: 'verified'});
			badge.setAttribute('title', 'Server URL matches a recognized trusted provider');
		} else if (state.trustLevel === 'unverified') {
			const badge = titleRow.createSpan({cls: 'sidekick-mcp-editor-card-tag is-unverified'});
			const icon = badge.createSpan({cls: 'sidekick-mcp-editor-trust-icon'});
			setIcon(icon, 'shield-alert');
			badge.createSpan({text: 'unverified'});
			badge.setAttribute('title', 'This server is not from a recognized provider — review its origin before use');
		}

		// Result badge (right side of title)
		const resultBadge = titleRow.createSpan({cls: 'sidekick-mcp-editor-card-result'});
		state.resultEl = resultBadge;
		this.applyResultBadge(state);

		// Endpoint subtitle
		if (state.endpointHint) {
			const sub = body.createDiv({cls: 'sidekick-mcp-editor-card-endpoint'});
			sub.setText(state.endpointHint);
			sub.setAttribute('title', state.endpointHint);
		}

		// Config issues (warnings)
		for (const issue of state.configIssues) {
			body.createDiv({cls: 'sidekick-mcp-editor-card-issue', text: issue});
		}

		// Security warning for unverified servers
		if (state.trustLevel === 'unverified') {
			const warn = body.createDiv({cls: 'sidekick-mcp-editor-card-security-warn'});
			const warnIcon = warn.createSpan({cls: 'sidekick-mcp-editor-card-security-warn-icon'});
			setIcon(warnIcon, 'alert-triangle');
			warn.createSpan({
				text: 'External server — may have access to vault data. Verify the URL and provider before enabling.',
			});
		}

		// Error / detail message line
		if ((state.status === 'error' || state.status === 'skipped') && state.resultText) {
			const msg = body.createDiv({cls: `sidekick-mcp-editor-card-msg is-${state.status}`});
			msg.setText(state.resultText);
		}

		// Tool list (collapsible) when connected
		if (state.status === 'connected' && state.tools && state.tools.length > 0) {
			const toggle = body.createDiv({cls: 'sidekick-mcp-editor-card-tools-toggle'});
			const chev = toggle.createSpan({cls: 'sidekick-mcp-editor-card-tools-chev'});
			setIcon(chev, state.expanded ? 'chevron-down' : 'chevron-right');
			toggle.createSpan({text: `${state.tools.length} tools`});
			const list = body.createDiv({cls: 'sidekick-mcp-editor-card-tools-list'});
			list.toggle(!!state.expanded);
			for (const tool of state.tools) {
				const item = list.createDiv({cls: 'sidekick-mcp-editor-card-tool'});
				item.createSpan({cls: 'sidekick-mcp-editor-card-tool-name', text: tool.name});
				if (tool.description) {
					const desc = item.createSpan({cls: 'sidekick-mcp-editor-card-tool-desc'});
					desc.setText(tool.description.split('\n')[0] ?? '');
				}
			}
			toggle.addEventListener('click', () => {
				state.expanded = !state.expanded;
				list.toggle(!!state.expanded);
				chev.empty();
				setIcon(chev, state.expanded ? 'chevron-down' : 'chevron-right');
			});
		}

		// Test button (right)
		const testBtn = card.createEl('button', {
			cls: 'clickable-icon sidekick-mcp-editor-card-test-btn',
			attr: {title: `Test ${state.name}`},
		});
		setIcon(testBtn, 'zap');
		state.testBtn = testBtn;
		testBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			void this.testServer(state, true);
		});
	}

	/** Update the left status dot/spinner based on current status. */
	private applyStatusVisual(state: ServerState): void {
		if (!state.statusEl) return;
		state.statusEl.empty();
		state.statusEl.removeClass(
			'is-idle', 'is-testing', 'is-connected', 'is-skipped', 'is-error', 'is-invalid',
		);
		state.statusEl.addClass(`is-${state.status}`);

		if (state.status === 'testing') {
			const spinner = state.statusEl.createDiv({cls: 'sidekick-mcp-editor-spinner'});
			spinner.setAttribute('title', 'Testing connection…');
		} else {
			const dot = state.statusEl.createDiv({cls: 'sidekick-mcp-editor-dot'});
			dot.setAttribute('title', this.statusTooltip(state));
		}
	}

	private statusTooltip(state: ServerState): string {
		switch (state.status) {
			case 'connected': return state.resultText ? `Connected — ${state.resultText}` : 'Connected';
			case 'skipped': return state.resultText ? `Skipped — ${state.resultText}` : 'Skipped';
			case 'error': return state.resultText ? `Error — ${state.resultText}` : 'Error';
			case 'invalid': return 'Invalid configuration';
			case 'testing': return 'Testing connection…';
			case 'idle':
			default: return 'Not yet tested';
		}
	}

	private applyResultBadge(state: ServerState): void {
		if (!state.resultEl) return;
		state.resultEl.empty();
		state.resultEl.removeClass(
			'is-idle', 'is-testing', 'is-connected', 'is-skipped', 'is-error', 'is-invalid',
		);
		state.resultEl.addClass(`is-${state.status}`);

		switch (state.status) {
			case 'idle':
				state.resultEl.setText('Untested');
				break;
			case 'testing':
				state.resultEl.setText('Testing…');
				break;
			case 'connected':
				state.resultEl.setText(state.tools ? `${state.tools.length} tools` : 'Connected');
				break;
			case 'skipped':
				state.resultEl.setText('Skipped');
				break;
			case 'error':
				state.resultEl.setText('Error');
				break;
			case 'invalid':
				state.resultEl.setText('Invalid');
				break;
		}
	}

	private updateSummary(): void {
		this.summaryEl.empty();
		if (this.serverStates.length === 0) return;

		const counts = {
			connected: 0,
			error: 0,
			skipped: 0,
			testing: 0,
			idle: 0,
			invalid: 0,
		};
		for (const s of this.serverStates) {
			counts[s.status]++;
		}

		const total = this.serverStates.length;
		const summary = this.summaryEl.createDiv({cls: 'sidekick-mcp-editor-summary-row'});
		summary.createSpan({
			cls: 'sidekick-mcp-editor-summary-total',
			text: `${total} server${total === 1 ? '' : 's'}`,
		});

		const pillSpec: Array<{key: keyof typeof counts; label: string; cls: string}> = [
			{key: 'connected', label: 'connected', cls: 'is-connected'},
			{key: 'error', label: 'error', cls: 'is-error'},
			{key: 'skipped', label: 'skipped', cls: 'is-skipped'},
			{key: 'invalid', label: 'invalid', cls: 'is-invalid'},
			{key: 'testing', label: 'testing', cls: 'is-testing'},
			{key: 'idle', label: 'untested', cls: 'is-idle'},
		];
		for (const {key, label, cls} of pillSpec) {
			if (counts[key] > 0) {
				const pill = summary.createSpan({cls: `sidekick-mcp-editor-summary-pill ${cls}`});
				pill.setText(`${counts[key]} ${label}`);
			}
		}
	}

	// ── Probing ────────────────────────────────────────
	/**
	 * Probe a single server. Updates state + UI in place.
	 * @param state          Server state to probe
	 * @param interactive    When true, surface results via Notice/console
	 */
	private async testServer(state: ServerState, interactive: boolean): Promise<void> {
		// Skip structurally invalid configs
		if (state.configIssues.length > 0) {
			if (interactive) {
				new Notice(`${state.name}: fix config issues first`);
			}
			return;
		}

		state.status = 'testing';
		state.resultText = undefined;
		state.tools = undefined;
		this.applyStatusVisual(state);
		this.applyResultBadge(state);
		this.updateSummary();
		state.testBtn?.addClass('is-testing');

		const entry: McpServerEntry = {name: state.name, config: {...state.cfg}};

		if (interactive) {
			console.group(`[Sidekick MCP Test] ${state.name}`);
			console.log('Config:', JSON.parse(JSON.stringify(state.cfg)));
		}

		try {
			await enrichServersWithAzureAuth([entry]);
			const result = await probeMcpServer(entry);
			if (interactive) console.log('Probe result:', result);

			if (result.tools.length > 0) {
				state.status = 'connected';
				state.tools = result.tools.map(t => ({name: t.name, description: t.description}));
				state.resultText = `${result.tools.length} tools`;
				if (interactive) {
					console.log(`✅ ${state.name}: ${result.tools.length} tools found`);
					console.table(result.tools.map(t => ({name: t.name, description: t.description})));
					new Notice(`${state.name}: ${result.tools.length} tools found`);
				}
			} else if (result.skipped) {
				state.status = 'skipped';
				state.resultText = 'Proxy-only — install agency CLI (https://aka.ms/agency)';
				if (interactive) {
					console.log(`⏭ ${state.name}: Skipped (proxy-only, no agency CLI)`);
					new Notice(`${state.name}: Install agency CLI to connect`);
				}
			} else if (result.error) {
				state.status = 'error';
				state.resultText = result.httpStatus
					? `HTTP ${result.httpStatus}: ${result.error}`
					: result.error;
				if (interactive) {
					console.warn(`❌ ${state.name}: ${result.error}`);
					if (result.httpStatus) console.log('HTTP status:', result.httpStatus);
					new Notice(`${state.name}: ${result.error}`);
				}
			} else {
				state.status = 'connected';
				state.tools = [];
				state.resultText = 'Connected · 0 tools';
			}
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			state.status = 'error';
			state.resultText = msg;
			if (interactive) {
				console.error(`❌ ${state.name}: ${msg}`);
				new Notice(`${state.name}: ${msg}`);
			}
		} finally {
			if (interactive) console.groupEnd();
			state.testBtn?.removeClass('is-testing');
			// Re-render only this card to refresh tool list / message areas
			this.rerenderCard(state);
			this.updateSummary();
		}
	}

	/** Replace a card's DOM in place with a fresh render reflecting current state. */
	private rerenderCard(state: ServerState): void {
		if (!state.rowEl) return;
		const old = state.rowEl;
		const placeholder = document.createComment('card-placeholder');
		old.replaceWith(placeholder);
		// Build replacement card by re-running renderCard against a fresh container
		const tmp = createDiv();
		const savedServersEl = this.serversEl;
		this.serversEl = tmp;
		this.renderCard(state);
		this.serversEl = savedServersEl;
		const fresh = tmp.firstElementChild;
		if (fresh) {
			placeholder.replaceWith(fresh);
			state.rowEl = fresh as HTMLElement;
		} else {
			placeholder.remove();
		}
	}

	/**
	 * Test all servers in parallel.
	 * @param interactive When false (auto-probe), suppress toast notifications.
	 */
	private async testAllServers(interactive: boolean): Promise<void> {
		if (this.serverStates.length === 0) return;
		if (interactive) console.group('[Sidekick MCP Test] Testing all servers');
		await Promise.all(
			this.serverStates
				.filter(s => s.configIssues.length === 0)
				.map(s => this.testServer(s, interactive)),
		);
		if (interactive) console.groupEnd();
	}

	// ── Misc ───────────────────────────────────────────
	private showError(msg: string): void {
		this.errorEl.empty();
		const wrap = this.errorEl.createDiv({cls: 'sidekick-mcp-editor-error-text is-error'});
		const icon = wrap.createSpan({cls: 'sidekick-mcp-editor-error-icon'});
		setIcon(icon, 'alert-circle');
		wrap.createSpan({text: msg});
		this.textArea.addClass('is-invalid');
		this.saveBtn.disabled = true;
	}

	private showWarning(msg: string): void {
		this.errorEl.empty();
		const wrap = this.errorEl.createDiv({cls: 'sidekick-mcp-editor-error-text is-warning'});
		const icon = wrap.createSpan({cls: 'sidekick-mcp-editor-error-icon'});
		setIcon(icon, 'info');
		wrap.createSpan({text: msg});
	}

	private async save(): Promise<void> {
		const text = this.textArea.value.trim();
		if (text && !this.validate()) return;

		try {
			const file = this.app.vault.getAbstractFileByPath(this.mcpPath);
			if (file && file instanceof TFile) {
				await this.app.vault.modify(file, text || '{}');
			} else {
				const folderPath = this.mcpPath.replace(/\/[^/]+$/, '');
				if (!this.app.vault.getAbstractFileByPath(folderPath)) {
					await this.app.vault.createFolder(folderPath);
				}
				await this.app.vault.create(this.mcpPath, text || '{}');
			}
			// eslint-disable-next-line sidekick-custom/ui-sentence-case
			new Notice('mcp.json saved');
			this.originalText = text || '{}';
			this.onSaved();
			this.close();
		} catch (e) {
			new Notice(`Failed to save mcp.json: ${String(e)}`);
		}
	}
}
