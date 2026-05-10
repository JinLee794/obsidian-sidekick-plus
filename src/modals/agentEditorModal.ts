import {App, Modal, Notice, TFile, normalizePath, setIcon} from 'obsidian';
import type {AgentConfig, HandoffConfig, SkillInfo, McpServerEntry} from '../types';

/**
 * Context passed to AgentEditorModal so it can offer intelligent suggestions.
 */
export interface AgentEditorContext {
	agents: AgentConfig[];
	skills: SkillInfo[];
	mcpServers: McpServerEntry[];
	models: {id: string; name: string}[];
	agentsFolder: string;
}

/**
 * Visual editor modal for *.agent.md files.
 * Reads/writes the YAML frontmatter + body while presenting a form-based UI
 * with intelligent suggestions for tools, skills, agents, and handoffs.
 */
export class AgentEditorModal extends Modal {
	private readonly context: AgentEditorContext;
	private readonly agent: AgentConfig | null;
	private readonly onSaved: () => void;

	// Form state
	private nameInput!: HTMLInputElement;
	private descInput!: HTMLInputElement;
	private modelSelect!: HTMLSelectElement;
	private instructionsArea!: HTMLTextAreaElement;
	private toolsContainer!: HTMLElement;
	private skillsContainer!: HTMLElement;
	private handoffsContainer!: HTMLElement;

	private selectedTools = new Set<string>();
	private allToolsMode = false;
	private selectedSkills = new Set<string>();
	private allSkillsMode = false;
	private handoffs: HandoffConfig[] = [];

	constructor(app: App, context: AgentEditorContext, agent: AgentConfig | null, onSaved: () => void) {
		super(app);
		this.context = context;
		this.agent = agent;
		this.onSaved = onSaved;

		// Initialize from existing agent
		if (agent) {
			if (agent.tools === undefined) {
				this.allToolsMode = true;
			} else {
				for (const t of agent.tools) this.selectedTools.add(t);
			}
			if (agent.skills === undefined) {
				this.allSkillsMode = true;
			} else {
				for (const s of agent.skills) this.selectedSkills.add(s);
			}
			if (agent.handoffs) {
				this.handoffs = agent.handoffs.map(h => ({...h}));
			}
		} else {
			this.allToolsMode = true;
			this.allSkillsMode = true;
		}
	}

	onOpen(): void {
		const {contentEl} = this;
		contentEl.empty();
		contentEl.addClass('sidekick-agent-editor');

		// Header
		contentEl.createEl('h3', {text: this.agent ? `Edit agent: ${this.agent.name}` : 'New agent'});

		const form = contentEl.createDiv({cls: 'sidekick-agent-editor-form'});

		// ── Name ──
		this.buildField(form, 'Name', 'Display name for the agent', el => {
			this.nameInput = el.createEl('input', {
				type: 'text', cls: 'sidekick-agent-editor-input',
				attr: {placeholder: 'e.g. Coder'},
			});
			this.nameInput.value = this.agent?.name ?? '';
		});

		// ── Description ──
		this.buildField(form, 'Description', 'Short description shown in the picker', el => {
			this.descInput = el.createEl('input', {
				type: 'text', cls: 'sidekick-agent-editor-input',
				attr: {placeholder: 'e.g. Helps write and review code'},
			});
			this.descInput.value = this.agent?.description ?? '';
		});

		// ── Model ──
		this.buildField(form, 'Model', 'AI model to use (leave empty for session default)', el => {
			this.modelSelect = el.createEl('select', {cls: 'sidekick-agent-editor-input'});
			const defaultOpt = this.modelSelect.createEl('option', {text: '(Session default)', attr: {value: ''}});
			defaultOpt.value = '';
			for (const m of this.context.models) {
				const opt = this.modelSelect.createEl('option', {text: m.name});
				opt.value = m.id;
			}
			if (this.agent?.model) {
				// Try to match by id or name
				const match = this.context.models.find(m =>
					m.id === this.agent!.model || m.name.toLowerCase() === this.agent!.model!.toLowerCase()
				);
				this.modelSelect.value = match ? match.id : '';
			}
		});

		// ── Tools ──
		this.buildField(form, 'Tools', 'MCP servers and sub-agent names. Checked = enabled.', el => {
			const allRow = el.createDiv({cls: 'sidekick-agent-editor-all-row'});
			const allCb = allRow.createEl('input', {type: 'checkbox'});
			allCb.checked = this.allToolsMode;
			allRow.createSpan({text: ' All tools (omit property)'});
			allCb.addEventListener('change', () => {
				this.allToolsMode = allCb.checked;
				this.renderToolsList();
			});
			this.toolsContainer = el.createDiv({cls: 'sidekick-agent-editor-chips'});
			this.renderToolsList();
		});

		// ── Skills ──
		this.buildField(form, 'Skills', 'Skills to enable for this agent.', el => {
			const allRow = el.createDiv({cls: 'sidekick-agent-editor-all-row'});
			const allCb = allRow.createEl('input', {type: 'checkbox'});
			allCb.checked = this.allSkillsMode;
			allRow.createSpan({text: ' All skills (omit property)'});
			allCb.addEventListener('change', () => {
				this.allSkillsMode = allCb.checked;
				this.renderSkillsList();
			});
			this.skillsContainer = el.createDiv({cls: 'sidekick-agent-editor-chips'});
			this.renderSkillsList();
		});

		// ── Handoffs ──
		this.buildField(form, 'Handoffs', 'Suggested next-action buttons shown after a response.', el => {
			this.handoffsContainer = el.createDiv({cls: 'sidekick-agent-editor-handoffs'});
			this.renderHandoffsList();

			const addBtn = el.createEl('button', {cls: 'sidekick-agent-editor-add-btn', text: '+ Add handoff'});
			addBtn.addEventListener('click', () => {
				this.handoffs.push({label: '', agent: '', prompt: '', send: false});
				this.renderHandoffsList();
			});
		});

		// ── Instructions ──
		this.buildField(form, 'Instructions', 'System prompt / instructions (Markdown body).', el => {
			this.instructionsArea = el.createEl('textarea', {
				cls: 'sidekick-agent-editor-textarea',
				attr: {rows: '8', placeholder: 'You are a helpful assistant...'},
			});
			this.instructionsArea.value = this.agent?.instructions ?? '';
		});

		// ── Buttons ──
		const btnRow = contentEl.createDiv({cls: 'sidekick-agent-editor-buttons'});
		const saveBtn = btnRow.createEl('button', {cls: 'mod-cta', text: 'Save'});
		saveBtn.addEventListener('click', () => void this.save());
		const cancelBtn = btnRow.createEl('button', {text: 'Cancel'});
		cancelBtn.addEventListener('click', () => this.close());
		if (this.agent) {
			const openBtn = btnRow.createEl('button', {text: 'Open file'});
			openBtn.addEventListener('click', () => {
				const file = this.app.vault.getAbstractFileByPath(this.agent!.filePath);
				if (file instanceof TFile) {
					this.app.workspace.getLeaf(false).openFile(file);
					this.close();
				}
			});
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}

	// ── Render helpers ──

	private buildField(parent: HTMLElement, label: string, hint: string, builder: (el: HTMLElement) => void): void {
		const group = parent.createDiv({cls: 'sidekick-agent-editor-field'});
		const labelEl = group.createDiv({cls: 'sidekick-agent-editor-label'});
		labelEl.createSpan({text: label, cls: 'sidekick-agent-editor-label-text'});
		labelEl.createSpan({text: hint, cls: 'sidekick-agent-editor-hint'});
		builder(group);
	}

	private renderToolsList(): void {
		this.toolsContainer.empty();
		if (this.allToolsMode) {
			this.toolsContainer.createSpan({cls: 'sidekick-agent-editor-muted', text: 'All tools enabled (property omitted)'});
			return;
		}

		// MCP servers
		for (const server of this.context.mcpServers) {
			this.renderChip(this.toolsContainer, server.name, 'plug',
				this.selectedTools.has(server.name),
				(checked) => { if (checked) { this.selectedTools.add(server.name); } else { this.selectedTools.delete(server.name); } },
				`MCP server: ${server.name}`
			);
		}

		// Other agents as sub-agent references
		for (const ag of this.context.agents) {
			if (this.agent && ag.name === this.agent.name) continue;
			this.renderChip(this.toolsContainer, `⤩ ${ag.name}`, 'bot',
				this.selectedTools.has(ag.name),
				(checked) => { if (checked) { this.selectedTools.add(ag.name); } else { this.selectedTools.delete(ag.name); } },
				`Sub-agent: ${ag.name}${ag.description ? ` — ${ag.description}` : ''}`
			);
		}
	}

	private renderSkillsList(): void {
		this.skillsContainer.empty();
		if (this.allSkillsMode) {
			this.skillsContainer.createSpan({cls: 'sidekick-agent-editor-muted', text: 'All skills enabled (property omitted)'});
			return;
		}

		for (const skill of this.context.skills) {
			this.renderChip(this.skillsContainer, skill.name, 'wand-2',
				this.selectedSkills.has(skill.name),
				(checked) => { if (checked) { this.selectedSkills.add(skill.name); } else { this.selectedSkills.delete(skill.name); } },
				skill.description || skill.name
			);
		}
	}

	private renderChip(
		parent: HTMLElement, text: string, icon: string,
		checked: boolean, onChange: (checked: boolean) => void, tooltip?: string
	): void {
		const chip = parent.createDiv({cls: 'sidekick-agent-editor-chip'});
		if (checked) chip.addClass('is-selected');
		const cb = chip.createEl('input', {type: 'checkbox'});
		cb.checked = checked;
		const iconEl = chip.createSpan({cls: 'sidekick-agent-editor-chip-icon'});
		setIcon(iconEl, icon);
		chip.createSpan({text});
		if (tooltip) chip.setAttribute('title', tooltip);
		cb.addEventListener('change', () => {
			onChange(cb.checked);
			chip.toggleClass('is-selected', cb.checked);
		});
		chip.addEventListener('click', (e) => {
			if (e.target !== cb) { cb.checked = !cb.checked; cb.dispatchEvent(new Event('change')); }
		});
	}

	private renderHandoffsList(): void {
		this.handoffsContainer.empty();

		if (this.handoffs.length === 0) {
			// eslint-disable-next-line sidekick-custom/ui-sentence-case
			this.handoffsContainer.createSpan({cls: 'sidekick-agent-editor-muted', text: 'No handoffs configured. Click "+ Add handoff" below.'});
			return;
		}

		for (let i = 0; i < this.handoffs.length; i++) {
			const h = this.handoffs[i]!;
			const card = this.handoffsContainer.createDiv({cls: 'sidekick-agent-editor-handoff-card'});

			const headerRow = card.createDiv({cls: 'sidekick-agent-editor-handoff-header'});
			headerRow.createSpan({text: `Handoff ${i + 1}`, cls: 'sidekick-agent-editor-handoff-num'});
			const removeBtn = headerRow.createEl('button', {cls: 'clickable-icon sidekick-agent-editor-remove-btn', attr: {title: 'Remove handoff'}});
			setIcon(removeBtn, 'x');
			removeBtn.addEventListener('click', () => {
				this.handoffs.splice(i, 1);
				this.renderHandoffsList();
			});

			// Label
			const labelInput = this.buildHandoffInput(card, 'Label', 'Button text shown to user', h.label);
			labelInput.addEventListener('input', () => { h.label = labelInput.value; });

			// Agent (with datalist suggestions)
			const agentInput = this.buildHandoffInput(card, 'Agent', 'Target agent name', h.agent);
			const agentList = card.createEl('datalist', {attr: {id: `sidekick-handoff-agents-${i}`}});
			for (const ag of this.context.agents) {
				if (this.agent && ag.name === this.agent.name) continue;
				agentList.createEl('option', {attr: {value: ag.name}, text: ag.description || ag.name});
			}
			agentInput.setAttribute('list', `sidekick-handoff-agents-${i}`);
			agentInput.addEventListener('input', () => { h.agent = agentInput.value; });

			// Prompt
			const promptArea = card.createEl('textarea', {
				cls: 'sidekick-agent-editor-handoff-prompt',
				attr: {placeholder: 'Prompt to send to the target agent...', rows: '3'},
			});
			promptArea.value = h.prompt ?? '';
			promptArea.addEventListener('input', () => { h.prompt = promptArea.value; });
			const promptLabel = card.createDiv({cls: 'sidekick-agent-editor-handoff-field-label'});
			promptLabel.setText('Prompt');
			card.insertBefore(promptLabel, promptArea);

			// Send + Model row
			const optRow = card.createDiv({cls: 'sidekick-agent-editor-handoff-opts'});

			const sendLabel = optRow.createEl('label', {cls: 'sidekick-agent-editor-inline-label'});
			const sendCb = sendLabel.createEl('input', {type: 'checkbox'});
			sendCb.checked = h.send ?? false;
			sendLabel.appendText(' Auto-send');
			sendCb.addEventListener('change', () => { h.send = sendCb.checked; });

			const modelInput = optRow.createEl('input', {
				type: 'text', cls: 'sidekick-agent-editor-input sidekick-agent-editor-handoff-model',
				attr: {placeholder: 'Model (optional)'},
			});
			modelInput.value = h.model ?? '';
			const modelList = card.createEl('datalist', {attr: {id: `sidekick-handoff-models-${i}`}});
			for (const m of this.context.models) {
				modelList.createEl('option', {attr: {value: m.id}, text: m.name});
			}
			modelInput.setAttribute('list', `sidekick-handoff-models-${i}`);
			modelInput.addEventListener('input', () => { h.model = modelInput.value || undefined; });
		}
	}

	private buildHandoffInput(parent: HTMLElement, label: string, placeholder: string, value: string): HTMLInputElement {
		const row = parent.createDiv({cls: 'sidekick-agent-editor-handoff-row'});
		row.createSpan({text: label, cls: 'sidekick-agent-editor-handoff-field-label'});
		const input = row.createEl('input', {
			type: 'text', cls: 'sidekick-agent-editor-input',
			attr: {placeholder},
		});
		input.value = value;
		return input;
	}

	// ── Save ──

	private async save(): Promise<void> {
		const name = this.nameInput.value.trim();
		if (!name) {
			new Notice('Agent name is required.');
			return;
		}

		const md = this.buildMarkdown(name);
		const fileName = `${name.replace(/[\\/:*?"<>|]/g, '').trim()}.agent.md`;
		const filePath = this.agent?.filePath ?? normalizePath(`${this.context.agentsFolder}/${fileName}`);

		try {
			const existing = this.app.vault.getAbstractFileByPath(filePath);
			if (existing instanceof TFile) {
				await this.app.vault.modify(existing, md);
			} else {
				// Ensure folder exists
				const folder = filePath.replace(/\/[^/]+$/, '');
				if (!this.app.vault.getAbstractFileByPath(folder)) {
					await this.app.vault.createFolder(folder);
				}
				await this.app.vault.create(filePath, md);
			}
			new Notice(`Agent "${name}" saved.`);
			this.onSaved();
			this.close();
		} catch (e) {
			new Notice(`Failed to save agent: ${String(e)}`);
		}
	}

	private buildMarkdown(name: string): string {
		const lines: string[] = ['---'];
		lines.push(`name: ${name}`);

		const desc = this.descInput.value.trim();
		if (desc) lines.push(`description: ${desc}`);

		const model = this.modelSelect.value;
		if (model) lines.push(`model: ${model}`);

		if (!this.allToolsMode) {
			if (this.selectedTools.size === 0) {
				lines.push('tools: []');
			} else {
				lines.push('tools:');
				for (const t of this.selectedTools) lines.push(`  - ${t}`);
			}
		}

		if (!this.allSkillsMode) {
			if (this.selectedSkills.size === 0) {
				lines.push('skills: []');
			} else {
				lines.push('skills:');
				for (const s of this.selectedSkills) lines.push(`  - ${s}`);
			}
		}

		if (this.handoffs.length > 0) {
			lines.push('handoffs:');
			for (const h of this.handoffs) {
				if (!h.agent) continue;
				lines.push(`  - label: ${h.label || h.agent}`);
				lines.push(`    agent: ${h.agent}`);
				if (h.send) lines.push(`    send: true`);
				if (h.model) lines.push(`    model: ${h.model}`);
				if (h.prompt) {
					lines.push('    prompt: |');
					for (const pl of h.prompt.split('\n')) {
						lines.push(`      ${pl}`);
					}
				}
			}
		}

		lines.push('---');
		const instructions = this.instructionsArea.value;
		if (instructions) {
			lines.push('');
			lines.push(instructions);
		}

		return lines.join('\n') + '\n';
	}
}
