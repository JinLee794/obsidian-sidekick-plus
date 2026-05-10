import {normalizePath, setIcon, TFile} from 'obsidian';
import type {SidekickView} from '../sidekickView';

declare module '../sidekickView' {
	interface SidekickView {
		skillsPanelEl: HTMLElement;
		skillsListEl: HTMLElement;
		skillsFilterEl: HTMLInputElement;
		skillsPanelFilter: string;
		buildSkillsPanel(parent: HTMLElement): void;
		renderSkillsPanelList(): void;
	}
}

export function installSkillsPanel(ViewClass: {prototype: unknown}): void {
	const proto = ViewClass.prototype as SidekickView;

	proto.buildSkillsPanel = function(parent: HTMLElement): void {
		const wrapper = parent.createDiv({cls: 'sidekick-prompts-wrapper'});

		// ── Header ─────────────────────────────────────────────
		const header = wrapper.createDiv({cls: 'sidekick-tools-header'});
		header.createDiv({cls: 'sidekick-tools-title', text: 'Skills'});
		const controls = header.createDiv({cls: 'sidekick-tools-controls'});

		// Path hint
		controls.createSpan({
			cls: 'sidekick-tools-path',
			text: `${this.plugin.settings.sidekickFolder}/skills/`,
		});

		// Refresh
		const refreshBtn = controls.createEl('button', {
			cls: 'clickable-icon sidekick-triggers-ctrl-btn',
			attr: {title: 'Refresh skills'},
		});
		setIcon(refreshBtn, 'refresh-cw');
		refreshBtn.addEventListener('click', () => {
			void this.loadAllConfigs({silent: true}).then(() => this.renderSkillsPanelList());
		});

		// ── Filter input ───────────────────────────────────────
		const filterRow = wrapper.createDiv({cls: 'sidekick-prompts-filter-row'});
		this.skillsFilterEl = filterRow.createEl('input', {
			cls: 'sidekick-prompts-filter',
			attr: {type: 'text', placeholder: 'Filter skills…'},
		});
		this.skillsPanelFilter = '';
		this.skillsFilterEl.addEventListener('input', () => {
			this.skillsPanelFilter = this.skillsFilterEl.value.toLowerCase();
			this.renderSkillsPanelList();
		});

		// ── Skills list ────────────────────────────────────────
		this.skillsListEl = wrapper.createDiv({cls: 'sidekick-prompts-list'});
	};

	proto.renderSkillsPanelList = function(): void {
		this.skillsListEl.empty();

		const filtered = this.skills.filter(s =>
			!this.skillsPanelFilter ||
			s.name.toLowerCase().includes(this.skillsPanelFilter) ||
			s.description.toLowerCase().includes(this.skillsPanelFilter)
		);

		if (filtered.length === 0) {
			const empty = this.skillsListEl.createDiv({cls: 'sidekick-tools-empty'});
			if (this.skills.length === 0) {
				empty.createSpan({text: 'No skills configured. '});
				const hint = empty.createEl('span', {cls: 'sidekick-tools-hint'});
				hint.setText(`Add skill folders with SKILL.md to ${this.plugin.settings.sidekickFolder}/skills/`);
			} else {
				empty.createSpan({text: 'No skills match your filter.'});
			}
			return;
		}

		for (const skill of filtered) {
			const card = this.skillsListEl.createDiv({cls: 'sidekick-prompt-card'});
			const isEnabled = this.enabledSkills.has(skill.name);

			// Click card to open SKILL.md
			card.addEventListener('click', (e) => {
				if ((e.target as HTMLElement).closest('.sidekick-skill-card-toggle')) return;
				const filePath = normalizePath(`${skill.folderPath}/SKILL.md`);
				const file = this.app.vault.getAbstractFileByPath(filePath);
				if (file instanceof TFile) {
					void this.app.workspace.getLeaf(false).openFile(file);
				}
			});
			card.style.cursor = 'pointer';

			// Top row: name + enabled badge + toggle
			const topRow = card.createDiv({cls: 'sidekick-prompt-card-top'});

			const nameEl = topRow.createDiv({cls: 'sidekick-prompt-card-name'});
			const skillIcon = nameEl.createSpan({cls: 'sidekick-skill-card-icon'});
			setIcon(skillIcon, 'sparkles');
			nameEl.createSpan({text: skill.name});

			const badges = topRow.createDiv({cls: 'sidekick-prompt-card-badges'});
			const _statusBadge = badges.createSpan({
				cls: 'sidekick-skill-card-status' + (isEnabled ? ' is-enabled' : ''),
				text: isEnabled ? 'enabled' : 'disabled',
			});

			const toggleBtn = topRow.createEl('button', {
				cls: 'sidekick-skill-card-toggle',
				text: isEnabled ? 'Disable' : 'Enable',
				attr: {title: isEnabled ? 'Remove from active skills' : 'Add to active skills'},
			});
			toggleBtn.toggleClass('is-enabled', isEnabled);
			toggleBtn.addEventListener('click', () => {
				if (this.enabledSkills.has(skill.name)) {
					this.enabledSkills.delete(skill.name);
				} else {
					this.enabledSkills.add(skill.name);
				}
				this.plugin.settings.enabledSkills = [...this.enabledSkills];
				void this.plugin.saveSettings();
				this.renderSkillsPanelList();
				// Also update the chat toolbar badge if visible
				if (typeof this.updateSkillsBadge === 'function') this.updateSkillsBadge();
			});

			// Description
			if (skill.description) {
				card.createDiv({cls: 'sidekick-prompt-card-desc', text: skill.description});
			}

			// Folder path hint
			card.createDiv({cls: 'sidekick-prompt-card-content', text: skill.folderPath});
		}
	};
}
