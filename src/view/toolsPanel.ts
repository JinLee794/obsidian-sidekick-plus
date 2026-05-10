import {Notice, setIcon, normalizePath, TFile} from 'obsidian';
import type {SidekickView} from '../sidekickView';
import type {McpAuthConfig, McpToolInfo, McpServerEntry} from '../types';
import {getToolsFolder, setMcpInputValue} from '../settings';
import {McpEditorModal} from '../modals/mcpEditorModal';
import {AgencyConfigModal} from '../modals/agencyConfigModal';
import {debugTrace} from '../debug';
import {probeAllMcpServers, isProxyOnlyServer, isAgencyAvailable, isAgencyService, resetAgencyCache, enrichServersWithAzureAuth, needsAzureAuth, clearAzureTokenCache} from '../mcpProbe';
import {buildSpawnEnv, EXE_SUFFIX, IS_WINDOWS} from '../platformEnv';

/** Name for the built-in Obsidian Intelligence Layer MCP server. */
export const OIL_SERVER_NAME = 'oil';

/** NPM package for the OIL MCP server. */
export const OIL_PACKAGE = '@jinlee794/obsidian-intelligence-layer@latest';

/** Build the built-in OIL McpServerEntry, injecting the vault path at runtime. */
export function buildOilServerEntry(vaultPath: string): McpServerEntry {
	return {
		name: OIL_SERVER_NAME,
		config: {
			type: 'stdio',
			command: 'npx',
			args: ['-y', OIL_PACKAGE, 'mcp'],
			env: {
				'npm_config_@jinlee794:registry': 'https://npm.pkg.github.com',
				'OBSIDIAN_VAULT_PATH': vaultPath,
			},
		},
	};
}

export function installToolsPanel(ViewClass: {prototype: unknown}): void {
	const proto = ViewClass.prototype as SidekickView;

	proto.buildToolsPanel = function(parent: HTMLElement): void {
		const wrapper = parent.createDiv({cls: 'sidekick-tools-wrapper'});

		// ── MCP servers section ──────────────────────────────
		const mcpSection = wrapper.createDiv({cls: 'sidekick-tools-section'});
		const mcpHeader = mcpSection.createDiv({cls: 'sidekick-tools-header'});
		mcpHeader.createDiv({cls: 'sidekick-tools-title', text: 'MCP servers'});
		const mcpControls = mcpHeader.createDiv({cls: 'sidekick-tools-controls'});
		const mcpPathEl = mcpControls.createSpan({
			cls: 'sidekick-tools-path',
			text: `${this.plugin.settings.sidekickFolder}/tools/mcp.json`,
		});
		mcpPathEl.setAttribute('title', 'MCP configuration file');
		const editBtn = mcpControls.createEl('button', {
			cls: 'clickable-icon sidekick-triggers-ctrl-btn',
			attr: {title: 'Edit mcp.json'},
		});
		setIcon(editBtn, 'pencil');
		editBtn.addEventListener('click', () => {
			const toolsFolder = getToolsFolder(this.plugin.settings);
			new McpEditorModal(this.app, toolsFolder, () => {
				void this.loadAllConfigs({silent: true}).then(() => this.renderMcpServersList());
			}).open();
		});
		const refreshBtn = mcpControls.createEl('button', {
			cls: 'clickable-icon sidekick-triggers-ctrl-btn',
			attr: {title: 'Refresh'},
		});
		setIcon(refreshBtn, 'refresh-cw');
		refreshBtn.addEventListener('click', () => {
			void this.loadAllConfigs({silent: true}).then(() => {
				this.renderMcpServersList();
				this.scheduleMcpToolDiscovery();
			});
		});
		this.toolsMcpListEl = mcpSection.createDiv({cls: 'sidekick-tools-list'});
	};

	proto.buildOilPanel = function(parent: HTMLElement): void {
		this.toolsOilListEl = parent.createDiv({cls: 'sidekick-tools-oil-inline'});
	};

	proto.renderOilPanel = function(): void {
		this.toolsOilListEl.empty();

		const runtimeStatus = this.mcpServerStatus.get(OIL_SERVER_NAME);
		const item = this.toolsOilListEl.createDiv({cls: 'sidekick-tools-item'});

		// Status dot
		const statusDot = item.createSpan({cls: 'sidekick-tools-status-dot'});
		if (runtimeStatus) {
			statusDot.toggleClass('is-connected', runtimeStatus.status === 'connected');
			statusDot.toggleClass('is-error', runtimeStatus.status === 'error');
			statusDot.toggleClass('is-pending', runtimeStatus.status === 'pending');
			const label = runtimeStatus.status === 'connected' ? 'Connected'
				: runtimeStatus.status === 'error' ? 'Error'
				: 'Connecting…';
			statusDot.setAttribute('title', runtimeStatus.message || label);
		} else {
			statusDot.toggleClass('is-enabled', true);
			statusDot.setAttribute('title', 'Enabled (connects on next session)');
		}

		const info = item.createDiv({cls: 'sidekick-tools-item-info'});
		const nameRow = info.createDiv({cls: 'sidekick-tools-item-name'});
		nameRow.setText(OIL_SERVER_NAME);
		const builtInBadge = nameRow.createSpan({cls: 'sidekick-tools-tag sidekick-tools-tag-muted'});
		builtInBadge.setText('built-in');
		builtInBadge.style.marginLeft = '6px';
		builtInBadge.style.fontSize = '10px';

		// Error message
		if (runtimeStatus?.status === 'error' && runtimeStatus.message) {
			const errMsg = info.createDiv({cls: 'sidekick-tools-item-error'});
			errMsg.setText(runtimeStatus.message);
		}

		const meta = info.createDiv({cls: 'sidekick-tools-item-meta'});
		const typeTag = meta.createSpan({cls: 'sidekick-tools-tag'});
		typeTag.setText('stdio');
		const pkgTag = meta.createSpan({cls: 'sidekick-tools-tag sidekick-tools-tag-muted'});
		pkgTag.setText(OIL_PACKAGE);
		pkgTag.setAttribute('title', OIL_PACKAGE);

		// Discovered tools
		const discoveredTools = runtimeStatus?.tools;
		if (discoveredTools && discoveredTools.length > 0) {
			const details = info.createEl('details', {cls: 'sidekick-tools-discovered-details'});
			const summary = details.createEl('summary', {cls: 'sidekick-tools-discovered-summary'});
			summary.createSpan({cls: 'sidekick-tools-tag sidekick-tools-tag-accent', text: `${discoveredTools.length} tool(s) available`});
			const toolsListEl = details.createDiv({cls: 'sidekick-tools-discovered'});
			for (const tool of discoveredTools) {
				const toolEl = toolsListEl.createDiv({cls: 'sidekick-tools-discovered-item'});
				const dot = toolEl.createSpan({cls: 'sidekick-tools-discovered-dot'});
				dot.toggleClass('is-connected', runtimeStatus?.status === 'connected');
				toolEl.createSpan({cls: 'sidekick-tools-discovered-name', text: tool.name});
				if (tool.description) {
					const descEl = toolEl.createSpan({cls: 'sidekick-tools-discovered-desc'});
					descEl.setText(tool.description);
					descEl.setAttribute('title', tool.description);
				}
			}
		}
	};

	proto.buildAgencyPanel = function(parent: HTMLElement): void {
		const wrapper = parent.createDiv({cls: 'sidekick-tools-wrapper'});

		const agencySection = wrapper.createDiv({cls: 'sidekick-tools-section'});
		const agencyHeader = agencySection.createDiv({cls: 'sidekick-tools-header'});
		agencyHeader.createDiv({cls: 'sidekick-tools-title', text: 'Agency services'});
		const agencyControls = agencyHeader.createDiv({cls: 'sidekick-tools-controls'});
		const agencyHint = agencyControls.createSpan({cls: 'sidekick-tools-agency-hint'});
		// eslint-disable-next-line sidekick-custom/ui-sentence-case
		agencyHint.setText('via agency CLI');
		const agencySettingsBtn = agencyControls.createEl('button', {
			cls: 'clickable-icon sidekick-triggers-ctrl-btn',
			attr: {title: 'Configure agency services'},
		});
		setIcon(agencySettingsBtn, 'settings');
		agencySettingsBtn.addEventListener('click', () => {
			const toolsFolder = getToolsFolder(this.plugin.settings);
			new AgencyConfigModal(this.app, toolsFolder, this.agencyConfig, () => {
				resetAgencyCache();
				void this.loadAllConfigs({silent: true}).then(() => {
					this.renderAgencyServersList();
					this.scheduleMcpToolDiscovery();
				});
			}).open();
		});
		const agencyRefreshBtn = agencyControls.createEl('button', {
			cls: 'clickable-icon sidekick-triggers-ctrl-btn',
			attr: {title: 'Refresh agency services'},
		});
		setIcon(agencyRefreshBtn, 'refresh-cw');
		agencyRefreshBtn.addEventListener('click', () => {
			resetAgencyCache();
			void this.loadAllConfigs({silent: true}).then(() => {
				this.renderAgencyServersList();
				this.scheduleMcpToolDiscovery();
			});
		});
		this.toolsAgencyListEl = agencySection.createDiv({cls: 'sidekick-tools-list'});
	};

	proto.buildAgentsPanel = function(parent: HTMLElement): void {
		const wrapper = parent.createDiv({cls: 'sidekick-prompts-wrapper'});

		// ── Header ───────────────────────────────────────────────
		const header = wrapper.createDiv({cls: 'sidekick-tools-header'});
		header.createDiv({cls: 'sidekick-tools-title', text: 'Agents'});
		const controls = header.createDiv({cls: 'sidekick-tools-controls'});

		controls.createSpan({
			cls: 'sidekick-tools-path',
			text: `${this.plugin.settings.sidekickFolder}/agents/`,
		});

		const newAgentBtn = controls.createEl('button', {
			cls: 'clickable-icon sidekick-triggers-ctrl-btn',
			attr: {title: 'New agent'},
		});
		setIcon(newAgentBtn, 'plus');
		newAgentBtn.addEventListener('click', () => this.openAgentEditor());

		const refreshBtn = controls.createEl('button', {
			cls: 'clickable-icon sidekick-triggers-ctrl-btn',
			attr: {title: 'Refresh agents'},
		});
		setIcon(refreshBtn, 'refresh-cw');
		refreshBtn.addEventListener('click', () => {
			void this.loadAllConfigs({silent: true}).then(() => this.renderAgentToolMappings());
		});

		// ── Filter input ──────────────────────────────────────
		const filterRow = wrapper.createDiv({cls: 'sidekick-prompts-filter-row'});
		const filterInput = filterRow.createEl('input', {
			cls: 'sidekick-prompts-filter',
			attr: {type: 'text', placeholder: 'Filter agents…'},
		});
		this.agentsPanelFilterEl = filterInput;
		this.agentsPanelFilter = '';
		filterInput.addEventListener('input', () => {
			this.agentsPanelFilter = filterInput.value.toLowerCase();
			this.renderAgentToolMappings();
		});

		// ── Agents list ───────────────────────────────────────
		this.toolsAgentListEl = wrapper.createDiv({cls: 'sidekick-prompts-list'});
	};

	proto.renderToolsPanel = function(): void {
		this.renderOilPanel();
		this.renderMcpServersList();
	};

	proto.renderMcpServersList = function(): void {
		this.toolsMcpListEl.empty();

		// Filter out agency-discovered servers and built-in OIL — they have their own sections
		const userServers = this.mcpServers.filter((s: {name: string; config: Record<string, unknown>}) => !isAgencyService(s) && s.name !== OIL_SERVER_NAME);

		if (userServers.length === 0) {
			const empty = this.toolsMcpListEl.createDiv({cls: 'sidekick-tools-empty'});
			empty.createSpan({text: 'No MCP servers configured. '});
			const hint = empty.createSpan({cls: 'sidekick-tools-hint'});
			hint.setText(`Add servers to ${this.plugin.settings.sidekickFolder}/tools/mcp.json`);
			return;
		}

		for (const server of userServers) {
			const item = this.toolsMcpListEl.createDiv({cls: 'sidekick-tools-item'});
			const enabled = this.enabledMcpServers.has(server.name);
			const runtimeStatus = this.mcpServerStatus.get(server.name);

			// Status indicator — show runtime connection status when available
			const statusDot = item.createSpan({cls: 'sidekick-tools-status-dot'});
			if (runtimeStatus) {
				statusDot.toggleClass('is-connected', runtimeStatus.status === 'connected');
				statusDot.toggleClass('is-error', runtimeStatus.status === 'error');
				statusDot.toggleClass('is-pending', runtimeStatus.status === 'pending');
				const label = runtimeStatus.status === 'connected' ? 'Connected'
					: runtimeStatus.status === 'error' ? 'Error'
					: 'Connecting…';
				statusDot.setAttribute('title', runtimeStatus.message || label);
			} else {
				statusDot.toggleClass('is-enabled', enabled);
				statusDot.toggleClass('is-disabled', !enabled);
				statusDot.setAttribute('title', enabled ? 'Enabled (not yet connected)' : 'Disabled');
			}

			// Server info
			const info = item.createDiv({cls: 'sidekick-tools-item-info'});
			const nameRow = info.createDiv({cls: 'sidekick-tools-item-name'});
			nameRow.setText(server.name);

			// Auth refresh button — shown when server has auth config
			if (server.auth) {
				const authBtn = nameRow.createEl('button', {
					cls: 'clickable-icon sidekick-tools-auth-btn',
					attr: {title: `Refresh auth (${server.auth.command} ${(server.auth.args ?? []).join(' ')})`},
				});
				setIcon(authBtn, 'key');
				authBtn.addEventListener('click', (e) => {
					e.stopPropagation();
					void this.runAuthRefresh(server.name, server.auth!);
				});
			}

			// Connection status message when there's an error
			if (runtimeStatus?.status === 'error' && runtimeStatus.message) {
				const errMsg = info.createDiv({cls: 'sidekick-tools-item-error'});
				errMsg.setText(runtimeStatus.message);
			}

			// Note for proxy-only servers
			if (enabled && isProxyOnlyServer(server) && !runtimeStatus?.tools?.length) {
				const note = info.createDiv({cls: 'sidekick-tools-item-proxy-note'});
				if (isAgencyAvailable()) {
					note.setText('Proxied via agency CLI — discovering tools…');
				} else {
					note.setText('Install agency CLI (https://aka.ms/agency) to connect, or authenticate via Copilot SDK');
				}
			}

			// Note for Azure-authenticated servers that failed
			if (enabled && !isProxyOnlyServer(server) && needsAzureAuth(server) && runtimeStatus?.status === 'error' && (runtimeStatus?.httpStatus === 401 || runtimeStatus?.httpStatus === 403)) {
				const note = info.createDiv({cls: 'sidekick-tools-item-proxy-note'});
				note.setText('Azure auth failed — running az login…');
			}

			const meta = info.createDiv({cls: 'sidekick-tools-item-meta'});

			// Server type
			const cfg = server.config;
			const isAgencyProxied = isProxyOnlyServer(server) && isAgencyAvailable();
			const serverType = isAgencyProxied
				? 'agency'
				: (cfg['type'] as string | undefined) ?? (cfg['command'] ? 'local' : 'unknown');
			const typeTag = meta.createSpan({cls: 'sidekick-tools-tag'});
			typeTag.setText(serverType);

			// URL or command
			if (serverType === 'http' || serverType === 'sse') {
				const urlTag = meta.createSpan({cls: 'sidekick-tools-tag sidekick-tools-tag-muted'});
				urlTag.setText(cfg['url'] as string || '');
				urlTag.setAttribute('title', cfg['url'] as string || '');
			} else if (cfg['command']) {
				const cmdTag = meta.createSpan({cls: 'sidekick-tools-tag sidekick-tools-tag-muted'});
				const cmd = cfg['command'] as string;
				const args = (cfg['args'] as string[] | undefined) ?? [];
				cmdTag.setText(`${cmd} ${args.join(' ')}`.trim());
				cmdTag.setAttribute('title', `${cmd} ${args.join(' ')}`.trim());
			}

			// Tools filter from config
			const tools = cfg['tools'] as string[] | undefined;
			if (tools && tools.length > 0 && !(tools.length === 1 && tools[0] === '*')) {
				const toolsTag = meta.createSpan({cls: 'sidekick-tools-tag sidekick-tools-tag-accent'});
				toolsTag.setText(`${tools.length} tool(s)`);
				toolsTag.setAttribute('title', tools.join(', '));
			}

			// Discovered tools from runtime handshake
			const discoveredTools = runtimeStatus?.tools;
			if (discoveredTools && discoveredTools.length > 0) {
				const details = info.createEl('details', {cls: 'sidekick-tools-discovered-details'});
				const summary = details.createEl('summary', {cls: 'sidekick-tools-discovered-summary'});
				summary.createSpan({cls: 'sidekick-tools-tag sidekick-tools-tag-accent', text: `${discoveredTools.length} tool(s) available`});

				const toolsListEl = details.createDiv({cls: 'sidekick-tools-discovered'});
				for (const tool of discoveredTools) {
					const toolEl = toolsListEl.createDiv({cls: 'sidekick-tools-discovered-item'});
					const dot = toolEl.createSpan({cls: 'sidekick-tools-discovered-dot'});
					dot.toggleClass('is-connected', runtimeStatus?.status === 'connected');
					toolEl.createSpan({cls: 'sidekick-tools-discovered-name', text: tool.name});
					if (tool.description) {
						const descEl = toolEl.createSpan({cls: 'sidekick-tools-discovered-desc'});
						descEl.setText(tool.description);
						descEl.setAttribute('title', tool.description);
					}
				}
			} else if (enabled && (!isProxyOnlyServer(server) || isAgencyAvailable())) {
				const pendingTag = meta.createSpan({cls: 'sidekick-tools-tag sidekick-tools-tag-muted'});
				pendingTag.setText('Click refresh to discover tools');
			}

			// Toggle — use Obsidian's native toggle structure
			const toggleContainer = item.createDiv({cls: 'checkbox-container sidekick-tools-toggle'});
			toggleContainer.toggleClass('is-enabled', enabled);
			const checkbox = toggleContainer.createEl('input', {type: 'checkbox'});
			checkbox.checked = enabled;
			checkbox.tabIndex = 0;
			toggleContainer.addEventListener('click', (e) => {
				if (e.target === checkbox) return;
				checkbox.checked = !checkbox.checked;
				checkbox.dispatchEvent(new Event('change'));
			});
			checkbox.addEventListener('change', () => {
				const shouldEnable = checkbox.checked;
				checkbox.disabled = true;
				void this.setMcpServerEnabled(server, shouldEnable).finally(() => {
					if (!checkbox.isConnected) return;
					checkbox.disabled = false;
					checkbox.checked = this.enabledMcpServers.has(server.name);
					toggleContainer.toggleClass('is-enabled', checkbox.checked);
				});
			});
		}
	};

	proto.renderAgencyServersList = function(): void {
		this.toolsAgencyListEl.empty();
		const agencyServers = this.mcpServers.filter((s: {name: string; config: Record<string, unknown>}) => isAgencyService(s));

		if (agencyServers.length === 0) {
			if (!isAgencyAvailable()) {
				const empty = this.toolsAgencyListEl.createDiv({cls: 'sidekick-tools-empty'});
				empty.setText('Agency CLI not installed. Get it at https://aka.ms/agency');
			} else {
				const empty = this.toolsAgencyListEl.createDiv({cls: 'sidekick-tools-empty'});
				empty.setText('No agency services configured. Click the settings icon to add services.');
			}
			return;
		}

		for (const server of agencyServers) {
			const item = this.toolsAgencyListEl.createDiv({cls: 'sidekick-tools-item'});
			const enabled = this.enabledMcpServers.has(server.name);
			const runtimeStatus = this.mcpServerStatus.get(server.name);

			// Status dot
			const statusDot = item.createSpan({cls: 'sidekick-tools-status-dot'});
			if (runtimeStatus) {
				statusDot.toggleClass('is-connected', runtimeStatus.status === 'connected');
				statusDot.toggleClass('is-error', runtimeStatus.status === 'error');
				statusDot.toggleClass('is-pending', runtimeStatus.status === 'pending');
				statusDot.setAttribute('title', runtimeStatus.message || runtimeStatus.status);
			} else {
				statusDot.toggleClass('is-enabled', enabled);
				statusDot.toggleClass('is-disabled', !enabled);
				statusDot.setAttribute('title', enabled ? 'Enabled' : 'Disabled');
			}

			const info = item.createDiv({cls: 'sidekick-tools-item-info'});

			// Service name (strip agency- prefix for display)
			const serviceName = (server.config['_agencyService'] as string) || server.name;
			const nameRow = info.createDiv({cls: 'sidekick-tools-item-name'});
			nameRow.setText(serviceName);

			// Description
			const agencyDesc = server.config['_agencyDescription'] as string | undefined;
			if (agencyDesc) {
				const descEl = info.createDiv({cls: 'sidekick-tools-item-desc'});
				descEl.setText(agencyDesc);
			}

			// Error message
			if (runtimeStatus?.status === 'error' && runtimeStatus.message) {
				const errMsg = info.createDiv({cls: 'sidekick-tools-item-error'});
				errMsg.setText(runtimeStatus.message);
			}

			// Discovered tools
			const discoveredTools = runtimeStatus?.tools;
			if (discoveredTools && discoveredTools.length > 0) {
				const details = info.createEl('details', {cls: 'sidekick-tools-discovered-details'});
				const summary = details.createEl('summary', {cls: 'sidekick-tools-discovered-summary'});
				summary.createSpan({cls: 'sidekick-tools-tag sidekick-tools-tag-accent', text: `${discoveredTools.length} tool(s) available`});
				const toolsListEl = details.createDiv({cls: 'sidekick-tools-discovered'});
				for (const tool of discoveredTools) {
					const toolEl = toolsListEl.createDiv({cls: 'sidekick-tools-discovered-item'});
					const dot = toolEl.createSpan({cls: 'sidekick-tools-discovered-dot'});
					dot.toggleClass('is-connected', runtimeStatus?.status === 'connected');
					toolEl.createSpan({cls: 'sidekick-tools-discovered-name', text: tool.name});
					if (tool.description) {
						const descEl = toolEl.createSpan({cls: 'sidekick-tools-discovered-desc'});
						descEl.setText(tool.description);
						descEl.setAttribute('title', tool.description);
					}
				}
			}

			// Toggle
			const toggleContainer = item.createDiv({cls: 'checkbox-container sidekick-tools-toggle'});
			toggleContainer.toggleClass('is-enabled', enabled);
			const checkbox = toggleContainer.createEl('input', {type: 'checkbox'});
			checkbox.checked = enabled;
			checkbox.tabIndex = 0;
			toggleContainer.addEventListener('click', (e) => {
				if (e.target === checkbox) return;
				checkbox.checked = !checkbox.checked;
				checkbox.dispatchEvent(new Event('change'));
			});
			checkbox.addEventListener('change', () => {
				const shouldEnable = checkbox.checked;
				checkbox.disabled = true;
				void this.setMcpServerEnabled(server, shouldEnable).finally(() => {
					if (!checkbox.isConnected) return;
					checkbox.disabled = false;
					checkbox.checked = this.enabledMcpServers.has(server.name);
					toggleContainer.toggleClass('is-enabled', checkbox.checked);
				});
			});
		}
	};

	proto.renderAgentToolMappings = function(): void {
		this.toolsAgentListEl.empty();

		const filter = this.agentsPanelFilter ?? '';
		const filtered = this.agents.filter(a =>
			!filter ||
			a.name.toLowerCase().includes(filter) ||
			a.description.toLowerCase().includes(filter) ||
			(a.model ?? '').toLowerCase().includes(filter)
		);

		if (filtered.length === 0) {
			const empty = this.toolsAgentListEl.createDiv({cls: 'sidekick-tools-empty'});
			if (this.agents.length === 0) {
				empty.createSpan({text: 'No agents configured. '});
				const hint = empty.createEl('span', {cls: 'sidekick-tools-hint'});
				hint.setText(`Add .agent.md files to ${this.plugin.settings.sidekickFolder}/agents/`);
			} else {
				empty.createSpan({text: 'No agents match your filter.'});
			}
			return;
		}

		const agentNames = new Set(this.agents.map(a => a.name));

		for (const agent of filtered) {
			const card = this.toolsAgentListEl.createDiv({cls: 'sidekick-prompt-card'});
			const isActive = this.selectedAgent === agent.name;
			if (isActive) card.addClass('is-active');

			// Click card to open the .agent.md file
			card.addEventListener('click', (e) => {
				const target = e.target as HTMLElement;
				if (target.closest('.sidekick-agent-card-use') || target.closest('.sidekick-agent-card-edit')) return;
				const file = this.app.vault.getAbstractFileByPath(normalizePath(agent.filePath));
				if (file instanceof TFile) {
					void this.app.workspace.getLeaf(false).openFile(file);
				}
			});
			card.style.cursor = 'pointer';

			// ── Top row: name + active badge + actions ────────────────────────────────────────
			const topRow = card.createDiv({cls: 'sidekick-prompt-card-top'});

			const nameEl = topRow.createDiv({cls: 'sidekick-prompt-card-name'});
			const agentIcon = nameEl.createSpan({cls: 'sidekick-skill-card-icon'});
			setIcon(agentIcon, 'bot');
			nameEl.createSpan({text: agent.name});

			const badges = topRow.createDiv({cls: 'sidekick-prompt-card-badges'});
			if (isActive) {
				badges.createSpan({cls: 'sidekick-skill-card-status is-enabled', text: 'active'});
			}
			if (agent.model) {
				const modelBadge = badges.createSpan({cls: 'sidekick-prompt-card-agent', attr: {title: `Model: ${agent.model}`}});
				const mIcon = modelBadge.createSpan();
				setIcon(mIcon, 'cpu');
				modelBadge.createSpan({text: agent.model});
			}

			const editBtn = topRow.createEl('button', {
				cls: 'sidekick-agent-card-edit clickable-icon',
				attr: {title: 'Edit agent in modal'},
			});
			setIcon(editBtn, 'pencil');
			editBtn.addEventListener('click', (e) => { e.stopPropagation(); this.openAgentEditor(agent); });

			const useBtn = topRow.createEl('button', {
				cls: 'sidekick-prompt-card-use sidekick-agent-card-use',
				text: isActive ? 'Active' : 'Use',
				attr: {title: isActive ? 'Already the active agent' : 'Set as active agent in chat'},
			});
			if (isActive) useBtn.disabled = true;
			useBtn.addEventListener('click', () => {
				this.switchTab('chat');
				this.selectAgent(agent.name);
			});

			// ── Description ───────────────────────────────────────────
			if (agent.description) {
				card.createDiv({cls: 'sidekick-prompt-card-desc', text: agent.description});
			}

			// ── Stats row ──────────────────────────────────────────────
			const toolEntries = agent.tools === undefined ? this.mcpServers.map(s => s.name) : agent.tools;
			const subAgentRefs = toolEntries.filter(t => agentNames.has(t) && t !== agent.name);
			const toolRefs = toolEntries.filter(t => !subAgentRefs.includes(t));
			const skillEntries = agent.skills === undefined ? this.skills.map(s => s.name) : agent.skills;
			const handoffCount = agent.handoffs?.length ?? 0;

			const stats = card.createDiv({cls: 'sidekick-agent-card-stats'});
			const addStat = (icon: string, count: number, label: string, allMarker: boolean) => {
				const stat = stats.createSpan({cls: 'sidekick-agent-card-stat'});
				const i = stat.createSpan({cls: 'sidekick-agent-card-stat-icon'});
				setIcon(i, icon);
				stat.createSpan({text: ` ${count} ${label}${allMarker ? ' (all)' : ''}`});
			};
			addStat('plug', toolRefs.length, toolRefs.length === 1 ? 'tool' : 'tools', agent.tools === undefined);
			addStat('sparkles', skillEntries.length, skillEntries.length === 1 ? 'skill' : 'skills', agent.skills === undefined);
			if (subAgentRefs.length > 0) addStat('git-branch', subAgentRefs.length, 'sub', false);
			if (handoffCount > 0) addStat('arrow-right', handoffCount, 'handoff' + (handoffCount === 1 ? '' : 's'), false);

			// ── Collapsible details ─────────────────────────────────────────
			const details = card.createEl('details', {cls: 'sidekick-agent-card-details'});
			// Stop the click on summary from bubbling to the card open-file handler
			const summary = details.createEl('summary', {cls: 'sidekick-agent-card-summary'});
			summary.setText('Show tools, skills & instructions');
			summary.addEventListener('click', (e) => e.stopPropagation());

			// Tools
			const toolsBlock = details.createDiv({cls: 'sidekick-agent-card-block'});
			toolsBlock.createSpan({cls: 'sidekick-agent-card-block-label', text: 'Tools'});
			const toolsList = toolsBlock.createDiv({cls: 'sidekick-tools-agent-tools'});
			if (agent.tools === undefined) {
				const allTag = toolsList.createSpan({cls: 'sidekick-tools-tag sidekick-tools-tag-accent'});
				allTag.setText('All MCP servers');
				for (const server of this.mcpServers) {
					const tag = toolsList.createSpan({cls: 'sidekick-tools-tag'});
					tag.toggleClass('is-enabled', this.enabledMcpServers.has(server.name));
					tag.setText(server.name);
				}
			} else if (agent.tools.length === 0) {
				toolsList.createSpan({cls: 'sidekick-tools-tag sidekick-tools-tag-muted', text: 'No tools'});
			} else {
				for (const toolName of agent.tools) {
					const isAgentRef = agentNames.has(toolName) && toolName !== agent.name;
					const tag = toolsList.createSpan({cls: 'sidekick-tools-tag'});
					if (isAgentRef) {
						tag.toggleClass('is-enabled', true);
						tag.toggleClass('sidekick-tools-tag-agent', true);
						tag.setText(`\u2BA9 ${toolName}`);
						tag.setAttribute('title', `Sub-agent: ${toolName}`);
					} else {
						const serverExists = this.mcpServers.some(s => s.name === toolName);
						const isEnabled = this.enabledMcpServers.has(toolName);
						tag.toggleClass('is-enabled', serverExists && isEnabled);
						tag.toggleClass('is-missing', !serverExists);
						tag.setText(toolName);
						if (!serverExists) tag.setAttribute('title', 'Server not found in mcp.json');
					}
				}
			}

			// Skills
			if (this.skills.length > 0) {
				const skillsBlock = details.createDiv({cls: 'sidekick-agent-card-block'});
				skillsBlock.createSpan({cls: 'sidekick-agent-card-block-label', text: 'Skills'});
				const skillsList = skillsBlock.createDiv({cls: 'sidekick-tools-agent-tools'});
				if (agent.skills === undefined) {
					skillsList.createSpan({cls: 'sidekick-tools-tag sidekick-tools-tag-accent', text: 'All skills'});
					for (const skill of this.skills) {
						const tag = skillsList.createSpan({cls: 'sidekick-tools-tag'});
						tag.toggleClass('is-enabled', this.enabledSkills.has(skill.name));
						tag.setText(skill.name);
					}
				} else if (agent.skills.length === 0) {
					skillsList.createSpan({cls: 'sidekick-tools-tag sidekick-tools-tag-muted', text: 'No skills'});
				} else {
					for (const skillName of agent.skills) {
						const tag = skillsList.createSpan({cls: 'sidekick-tools-tag'});
						const exists = this.skills.some(s => s.name === skillName);
						tag.toggleClass('is-enabled', exists && this.enabledSkills.has(skillName));
						tag.toggleClass('is-missing', !exists);
						tag.setText(skillName);
					}
				}
			}

			// Excluded built-in tools
			if (agent.excludeTools && agent.excludeTools.length > 0) {
				const excludeBlock = details.createDiv({cls: 'sidekick-agent-card-block'});
				excludeBlock.createSpan({cls: 'sidekick-agent-card-block-label', text: 'Excluded built-ins'});
				const excludeList = excludeBlock.createDiv({cls: 'sidekick-tools-agent-tools'});
				for (const toolName of agent.excludeTools) {
					excludeList.createSpan({cls: 'sidekick-tools-tag sidekick-tools-tag-muted', text: toolName});
				}
			}

			// Handoffs
			if (agent.handoffs && agent.handoffs.length > 0) {
				const handoffBlock = details.createDiv({cls: 'sidekick-agent-card-block'});
				handoffBlock.createSpan({cls: 'sidekick-agent-card-block-label', text: 'Handoffs'});
				const handoffList = handoffBlock.createDiv({cls: 'sidekick-tools-agent-tools'});
				for (const handoff of agent.handoffs) {
					const tag = handoffList.createSpan({cls: 'sidekick-tools-tag'});
					tag.setText(`\u2192 ${handoff.label} (${handoff.agent})`);
					if (handoff.prompt) tag.setAttribute('title', handoff.prompt);
				}
			}

			// Instructions preview
			if (agent.instructions) {
				const instrBlock = details.createDiv({cls: 'sidekick-agent-card-block'});
				instrBlock.createSpan({cls: 'sidekick-agent-card-block-label', text: 'Instructions'});
				const preview = agent.instructions.length > 400
					? agent.instructions.slice(0, 400) + '…'
					: agent.instructions;
				instrBlock.createDiv({cls: 'sidekick-prompt-card-content', text: preview});
			}
		}
	};

	proto.handleMcpSessionEvent = function(category: string, message: string, level: 'info' | 'warning'): void {
		if (category !== 'mcp') return;
		debugTrace('MCP session event', {category, message, level});

		// Parse server name from typical MCP messages like "MCP server 'name': connected"
		const serverMatch = message.match(/MCP server ['"]?([^'":\s]+)['"]?\s*:\s*(.*)/i)
			?? message.match(/(?:connected|failed|error|started|auth\w*)\s+(?:MCP server\s+)?['"]?([^'":\s]+)['"]?/i);

		let newlyConnected = false;
		if (serverMatch) {
			const serverName = serverMatch[1]!;
			const detail = serverMatch[2] || '';
			const lowerMsg = (detail || message).toLowerCase();
			const prev = this.mcpServerStatus.get(serverName);
			debugTrace('MCP server event parsed', {serverName, detail, lowerMsg});

			if (lowerMsg.includes('connect') && !lowerMsg.includes('fail') && !lowerMsg.includes('error') && !lowerMsg.includes('disconnect')) {
				this.mcpServerStatus.set(serverName, {status: 'connected', message, tools: prev?.tools});
				if (!prev || prev.status !== 'connected') newlyConnected = true;
			} else if (lowerMsg.includes('error') || lowerMsg.includes('fail') || lowerMsg.includes('auth') || lowerMsg.includes('sign')) {
				this.mcpServerStatus.set(serverName, {status: 'error', message});
			} else {
				this.mcpServerStatus.set(serverName, {status: 'pending', message, tools: prev?.tools});
			}
		} else {
			debugTrace('MCP event - no server match', {message});
		}

		if (level === 'warning') {
			this.addInfoMessage(`MCP: ${message}`);
		}

		this.renderMcpServersList();
		this.renderAgencyServersList();
		this.renderOilPanel();

		// When a server newly connects, try to discover tools via SDK
		if (newlyConnected) {
			this.scheduleSdkToolDiscovery(1000);
		}
	};

	proto.refreshMcpToolsList = async function(): Promise<void> {
		if (this.mcpServers.length === 0 || this.enabledMcpServers.size === 0) return;

		// Build a filtered enabled set that excludes servers with known auth errors
		// or servers currently waiting for az login to complete.
		const azLoginPending = (this as unknown as {_azLoginServers?: Set<string>})._azLoginServers;
		const probableNames = new Set<string>();
		for (const name of this.enabledMcpServers) {
			if (azLoginPending?.has(name)) continue;
			const existing = this.mcpServerStatus.get(name);
			if (existing?.status === 'error' && (existing.httpStatus === 401 || existing.httpStatus === 403)) continue;
			probableNames.add(name);
		}
		if (probableNames.size === 0) return;

		try {
			// Enrich Azure-authenticated servers with fresh tokens before probing
			const enriched = await enrichServersWithAzureAuth(this.mcpServers, probableNames);
			if (enriched.size > 0) {
				for (const name of enriched) {
					const prev = this.mcpServerStatus.get(name);
					if (!prev || prev.status !== 'connected') {
						this.mcpServerStatus.set(name, {status: 'pending', message: 'Authenticating via Azure CLI…', tools: prev?.tools});
					}
				}
				this.renderMcpServersList();
				this.renderAgencyServersList();
			}

			const results = await probeAllMcpServers(this.mcpServers, probableNames);

			for (const result of results) {
				const existing = this.mcpServerStatus.get(result.serverName);
				if (result.tools.length > 0) {
					this.mcpServerStatus.set(result.serverName, {
						status: 'connected',
						message: existing?.message,
						tools: result.tools,
					});
				} else if (result.skipped) {
					// Proxy-only — status tracked from session events + SDK tools.list
				} else if (result.error) {
					if ((result.httpStatus === 401 || result.httpStatus === 403) && needsAzureAuth(this.mcpServers.find(s => s.name === result.serverName)!)) {
						clearAzureTokenCache();
						// Auto-trigger az login and retry
						const server = this.mcpServers.find(s => s.name === result.serverName);
						if (server) {
							this.mcpServerStatus.set(result.serverName, {
								status: 'pending',
								message: 'Azure auth failed — running az login…',
								tools: existing?.tools,
							});
							this.renderMcpServersList();
							void this.runAzLoginAndRetry(server);
							continue;
						}
					}
					this.mcpServerStatus.set(result.serverName, {
						status: 'error',
						message: result.error,
						tools: existing?.tools,
						httpStatus: result.httpStatus,
					});
				}
			}

			this.renderMcpServersList();
			this.renderAgencyServersList();
		} catch (e) {
			debugTrace('refreshMcpToolsList error', {error: String(e)});
		}
	};

	proto.discoverToolsViaSdk = async function(): Promise<void> {
		if (!this.plugin.copilot) return;
		try {
			const sdkTools = await this.plugin.copilot.listTools();
			debugTrace('SDK tools.list result', {
				totalTools: sdkTools.length,
				mcpTools: sdkTools.filter(t => t.namespacedName).map(t => ({
					name: t.name,
					namespacedName: t.namespacedName,
					description: t.description?.substring(0, 50),
				})),
			});

			// Group MCP tools by server name from namespacedName (e.g. "mail/get_messages")
			const mcpToolsByServer = new Map<string, McpToolInfo[]>();
			for (const tool of sdkTools) {
				if (!tool.namespacedName) continue;
				const slashIdx = tool.namespacedName.indexOf('/');
				if (slashIdx <= 0) continue;
				const serverName = tool.namespacedName.substring(0, slashIdx);
				// Track tools for enabled user/agency servers AND the built-in OIL server
				if (!this.enabledMcpServers.has(serverName) && serverName !== OIL_SERVER_NAME) continue;
				let list = mcpToolsByServer.get(serverName);
				if (!list) {
					list = [];
					mcpToolsByServer.set(serverName, list);
				}
				list.push({
					name: tool.name,
					namespacedName: tool.namespacedName,
					description: tool.description || '',
				});
			}

			let updated = false;
			for (const [serverName, tools] of mcpToolsByServer) {
				const existing = this.mcpServerStatus.get(serverName);
				if (!existing?.tools || existing.tools.length < tools.length) {
					this.mcpServerStatus.set(serverName, {
						status: 'connected',
						message: 'Connected via Copilot',
						tools,
					});
					updated = true;
				}
			}

			if (updated) {
				this.renderMcpServersList();
				this.renderAgencyServersList();
				this.renderOilPanel();
			}
		} catch (e) {
			debugTrace('discoverToolsViaSdk error', {error: String(e)});
		}
	};

	proto.scheduleSdkToolDiscovery = function(initialDelay = 2000): void {
		if (this.sdkToolDiscoveryTimer) clearTimeout(this.sdkToolDiscoveryTimer);
		// Single delayed discovery call — relies on session events for re-triggers
		// rather than a polling loop. handleMcpSessionEvent calls this again on connect.
		this.sdkToolDiscoveryTimer = setTimeout(async () => {
			await this.discoverToolsViaSdk();
		}, initialDelay);
	};

	proto.trackDiscoveredTool = function(serverName: string, toolName: string): void {
		const status = this.mcpServerStatus.get(serverName);
		const tools = status?.tools ?? [];
		if (tools.some(t => t.name === toolName)) return;
		tools.push({name: toolName, description: ''});
		this.mcpServerStatus.set(serverName, {
			status: 'connected',
			message: status?.message,
			tools,
		});
		this.renderMcpServersList();
		this.renderAgencyServersList();
		this.renderOilPanel();
	};

	proto.scheduleMcpToolDiscovery = function(): void {
		// Show pending state immediately for enabled servers that need probing
		// Skip servers already in error state (auth failures etc) — they need manual refresh
		let anyPending = false;
		for (const server of this.mcpServers) {
			if (!this.enabledMcpServers.has(server.name)) continue;
			const existing = this.mcpServerStatus.get(server.name);
			if (existing?.status === 'error') continue;
			if (!existing || (!existing.tools?.length && existing.status !== 'pending')) {
				this.mcpServerStatus.set(server.name, {
					status: 'pending',
					message: 'Discovering tools…',
					tools: existing?.tools,
				});
				anyPending = true;
			}
		}
		if (anyPending) {
			this.renderMcpServersList();
			this.renderAgencyServersList();
		}
		// Start probing immediately (no delay)
		void this.refreshMcpToolsList();
		// Also schedule SDK-based discovery for proxy-only servers
		const hasProxy = this.mcpServers.some(
			s => this.enabledMcpServers.has(s.name) && isProxyOnlyServer(s)
		);
		if (hasProxy) {
			this.scheduleSdkToolDiscovery(2000);
		}
	};

	proto.runAuthRefresh = async function(
		serverName: string,
		auth: McpAuthConfig,
		options?: {showSuccessNotice?: boolean; reloadConfigs?: boolean},
	): Promise<boolean> {
		const nodeRequire = (window as unknown as {require?: NodeRequire}).require;
		const {execFile} = nodeRequire?.('node:child_process') as typeof import('node:child_process') ?? await import('node:child_process');
		const {promisify} = nodeRequire?.('node:util') as typeof import('node:util') ?? await import('node:util');
		const execFileAsync = promisify(execFile);
		const showSuccessNotice = options?.showSuccessNotice ?? true;
		const reloadConfigs = options?.reloadConfigs ?? true;
		const previouslyEnabled = new Set(this.enabledMcpServers);

		new Notice(`Refreshing auth for ${serverName}…`);

		try {
			const {stdout, stderr} = await execFileAsync(auth.command, auth.args ?? [], {
				timeout: 60_000,
				env: buildSpawnEnv(),
				shell: IS_WINDOWS,
			});

			const output = stdout.trim();

			// If setInput is configured, store the captured output as an MCP input variable
			if (auth.setInput && output) {
				await setMcpInputValue(this.app, this.plugin, auth.setInput, output, false);
				if (showSuccessNotice) {
					new Notice(`Auth refreshed for ${serverName} — token saved to input "${auth.setInput}".`);
				}
			} else if (auth.setInput && !output) {
				new Notice(`Auth command for ${serverName} produced no output — input "${auth.setInput}" not updated.`);
			} else if (showSuccessNotice) {
				new Notice(`Auth refreshed for ${serverName}.`);
			}

			if (stderr?.trim()) {
				console.log(`Sidekick: auth refresh stderr for ${serverName}:`, stderr.trim());
			}

			// Reload configs so newly stored input values are resolved in server configs.
			if (reloadConfigs) {
				await this.loadAllConfigs({silent: true});
				this.enabledMcpServers = new Set(
					this.mcpServers
						.filter(server => previouslyEnabled.has(server.name))
						.map(server => server.name)
				);
				this.configDirty = true;
				this.updateToolsBadge();
			}
			if (this.activeTab === 'tools') this.renderMcpServersList();
			if (this.activeTab === 'agency') this.renderAgencyServersList();
			return true;
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			console.error(`Sidekick: auth refresh failed for ${serverName}:`, err);
			new Notice(`Auth refresh failed for ${serverName}: ${msg}`);
			return false;
		}
	};

	/**
	 * Auto-trigger `az login` when an Azure-authenticated HTTP server gets a 401/403,
	 * then clear the token cache, re-enrich, and re-probe the server.
	 * Tracks per-server login state to prevent concurrent attempts and skip re-probes.
	 */
	proto.runAzLoginAndRetry = async function(server: McpServerEntry): Promise<void> {
		const self = this as unknown as {_azLoginInProgress?: boolean; _azLoginServers?: Set<string>};
		if (!self._azLoginServers) self._azLoginServers = new Set();

		// Prevent multiple concurrent az login attempts
		if (self._azLoginInProgress) {
			// Still mark this server as login-pending so probes skip it
			self._azLoginServers.add(server.name);
			debugTrace('az login already in progress, skipping', {server: server.name});
			return;
		}
		self._azLoginInProgress = true;
		self._azLoginServers.add(server.name);

		const nodeRequire = (window as unknown as {require?: NodeRequire}).require;
		const cp = nodeRequire?.('node:child_process') as typeof import('node:child_process') | undefined;
		const util = nodeRequire?.('node:util') as typeof import('node:util') | undefined;
		if (!cp || !util) {
			self._azLoginInProgress = false;
			self._azLoginServers.delete(server.name);
			return;
		}
		const execFileAsync = util.promisify(cp.execFile);

		new Notice('Azure auth required — launching az login…');

		try {
			await execFileAsync(`az${EXE_SUFFIX}`, ['login', '--only-show-errors'], {
				timeout: 120_000,
				env: buildSpawnEnv(),
				shell: IS_WINDOWS,
			});

			new Notice('Azure login succeeded — refreshing token…');
			clearAzureTokenCache();

			// Re-enrich and re-probe ALL servers that were pending az login
			const pendingServers = this.mcpServers.filter(
				(s: McpServerEntry) => self._azLoginServers!.has(s.name)
			);
			await enrichServersWithAzureAuth(pendingServers);

			const results = await probeAllMcpServers(pendingServers, new Set(pendingServers.map((s: McpServerEntry) => s.name)));
			for (const result of results) {
				if (result.tools.length > 0) {
					this.mcpServerStatus.set(result.serverName, {
						status: 'connected',
						message: 'Authenticated via az login',
						tools: result.tools,
					});
					new Notice(`${result.serverName}: connected with ${result.tools.length} tools`);
				} else if (result.error) {
					this.mcpServerStatus.set(result.serverName, {
						status: 'error',
						message: result.error,
						httpStatus: result.httpStatus,
					});
					new Notice(`${result.serverName}: ${result.error}`);
				}
			}
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			debugTrace('az login failed', {error: msg});
			// Set error without httpStatus so future refreshes will re-attempt
			for (const name of self._azLoginServers) {
				this.mcpServerStatus.set(name, {
					status: 'error',
					message: `az login failed: ${msg}`,
				});
			}
			new Notice(`az login failed: ${msg}`);
		} finally {
			self._azLoginInProgress = false;
			self._azLoginServers.clear();
			this.renderMcpServersList();
			this.renderOilPanel();
		}
	};
}
