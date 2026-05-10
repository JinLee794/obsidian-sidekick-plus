import {App, Modal, TFile, normalizePath} from 'obsidian';
import {discoverAgencyServers} from '../mcpProbe';
import type {AgencyConfig} from '../types';

/**
 * Modal that lets the user pick which agency CLI services to show
 * and which to auto-enable, then persists the choices to agency.md.
 */
export class AgencyConfigModal extends Modal {
	private readonly toolsFolder: string;
	private readonly currentConfig: AgencyConfig;
	private readonly onSave: () => void;

	/** Selected services to show (whitelist). null = show all. */
	private showAll: boolean;
	private selected: Map<string, boolean>; // service name → checked
	/** Services to auto-enable on first load. */
	private autoEnabled: Set<string>;

	constructor(
		app: App,
		toolsFolder: string,
		currentConfig: AgencyConfig,
		onSave: () => void,
	) {
		super(app);
		this.toolsFolder = toolsFolder;
		this.currentConfig = currentConfig;
		this.onSave = onSave;

		// Initialize state from current config
		this.showAll = !currentConfig.services || currentConfig.services.length === 0;
		this.selected = new Map();
		this.autoEnabled = new Set(currentConfig.enabled ?? []);
	}

	onOpen(): void {
		const {contentEl} = this;
		contentEl.addClass('sidekick-agency-config-modal');

		contentEl.createEl('h3', {text: 'Configure agency services'});
		contentEl.createEl('p', {
			text: 'Select which agency MCP servers to show in Tools, and which to auto-enable on startup.',
			cls: 'sidekick-agency-config-desc',
		});

		// Discover all available services
		const allServers = discoverAgencyServers();

		if (allServers.length === 0) {
			contentEl.createEl('p', {
				text: 'No agency services discovered. Make sure the agency CLI is installed.',
				cls: 'sidekick-agency-config-empty',
			});
			return;
		}

		// "Show all" toggle
		const showAllRow = contentEl.createDiv({cls: 'sidekick-agency-config-showall'});
		const showAllLabel = showAllRow.createEl('label', {cls: 'sidekick-agency-config-showall-label'});
		const showAllCheckbox = showAllLabel.createEl('input', {type: 'checkbox'});
		showAllCheckbox.checked = this.showAll;
		showAllLabel.createSpan({text: ' Show all services'});
		const showAllHint = showAllRow.createDiv({cls: 'sidekick-agency-config-hint'});
		showAllHint.setText('When unchecked, only selected services appear in the Tools panel.');

		// Services list
		const listContainer = contentEl.createDiv({cls: 'sidekick-agency-config-list'});

		// Populate initial state
		const currentWhitelist = new Set(this.currentConfig.services ?? []);
		for (const server of allServers) {
			const svcName = server.config['_agencyService'] as string;
			this.selected.set(svcName, this.showAll || currentWhitelist.has(svcName));
		}

		const renderList = () => {
			listContainer.empty();
			for (const server of allServers) {
				const svcName = server.config['_agencyService'] as string;
				const desc = server.config['_agencyDescription'] as string;

				const row = listContainer.createDiv({cls: 'sidekick-agency-config-row'});

				// Show checkbox
				const showCell = row.createDiv({cls: 'sidekick-agency-config-cell'});
				const showCb = showCell.createEl('input', {type: 'checkbox'});
				showCb.checked = this.showAll || (this.selected.get(svcName) ?? false);
				showCb.disabled = this.showAll;
				showCb.setAttribute('title', 'Show in Tools panel');
				showCb.addEventListener('change', () => {
					this.selected.set(svcName, showCb.checked);
					// If unchecked, also remove from auto-enabled
					if (!showCb.checked) {
						this.autoEnabled.delete(svcName);
						enableCb.checked = false;
					}
				});

				// Info
				const infoCell = row.createDiv({cls: 'sidekick-agency-config-info'});
				infoCell.createDiv({cls: 'sidekick-agency-config-name', text: svcName});
				if (desc) {
					const descEl = infoCell.createDiv({cls: 'sidekick-agency-config-svc-desc'});
					descEl.setText(desc);
				}

				// Auto-enable toggle
				const enableCell = row.createDiv({cls: 'sidekick-agency-config-cell'});
				const enableCb = enableCell.createEl('input', {type: 'checkbox'});
				enableCb.checked = this.autoEnabled.has(svcName);
				enableCb.setAttribute('title', 'Auto-enable on startup');
				enableCb.addEventListener('change', () => {
					if (enableCb.checked) {
						this.autoEnabled.add(svcName);
						// Also ensure it's shown
						if (!this.showAll) {
							this.selected.set(svcName, true);
							showCb.checked = true;
						}
					} else {
						this.autoEnabled.delete(svcName);
					}
				});
			}
		};

		showAllCheckbox.addEventListener('change', () => {
			this.showAll = showAllCheckbox.checked;
			renderList();
		});

		renderList();

		// Column headers
		const headerRow = contentEl.createDiv({cls: 'sidekick-agency-config-header'});
		headerRow.createSpan({text: 'Show', cls: 'sidekick-agency-config-col-label'});
		headerRow.createSpan({text: 'Service', cls: 'sidekick-agency-config-col-label sidekick-agency-config-col-grow'});
		headerRow.createSpan({text: 'Auto-on', cls: 'sidekick-agency-config-col-label'});
		// Insert header before the list
		listContainer.before(headerRow);

		// Buttons
		const btnRow = contentEl.createDiv({cls: 'sidekick-agency-config-buttons'});

		const saveBtn = btnRow.createEl('button', {cls: 'mod-cta', text: 'Save'});
		saveBtn.addEventListener('click', () => {
			void this.save();
		});

		const cancelBtn = btnRow.createEl('button', {text: 'Cancel'});
		cancelBtn.addEventListener('click', () => this.close());
	}

	private async save(): Promise<void> {
		// Build the config
		const services: string[] = [];
		if (!this.showAll) {
			for (const [name, checked] of this.selected) {
				if (checked) services.push(name);
			}
		}
		const enabled = [...this.autoEnabled].sort();

		// Generate agency.md content
		let yaml = '';
		if (!this.showAll && services.length > 0) {
			yaml += 'services:\n' + services.sort().map(s => `  - ${s}`).join('\n') + '\n';
		}
		if (enabled.length > 0) {
			yaml += 'enabled:\n' + enabled.map(s => `  - ${s}`).join('\n') + '\n';
		}
		const content = yaml ? `---\n${yaml}---\n` : '---\n---\n';

		// Write to file
		const filePath = normalizePath(`${this.toolsFolder}/agency.md`);
		const existing = this.app.vault.getAbstractFileByPath(filePath);
		if (existing && existing instanceof TFile) {
			await this.app.vault.modify(existing, content);
		} else {
			await this.app.vault.create(filePath, content);
		}

		this.close();
		this.onSave();
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
