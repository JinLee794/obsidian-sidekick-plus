// Minimal Obsidian stubs for testing
export function normalizePath(p: string) { return p; }
export class TFile { path = ''; }
export class TFolder { children: unknown[] = []; }
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export class Notice { constructor(_msg: string) {} }
export class Modal { open() {} close() {} }
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export class PluginSettingTab { constructor(..._args: unknown[]) {} }
export class Setting {
	setName() { return this; }
	setDesc() { return this; }
	addToggle() { return this; }
	addDropdown() { return this; }
	addText() { return this; }
}
export function setIcon() {}
export function addIcon() {}
export class Component {}
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export class ItemView { constructor(..._args: unknown[]) {} }
export class WorkspaceLeaf {}
export class MarkdownView {}
