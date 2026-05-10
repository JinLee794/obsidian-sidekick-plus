import tseslint from 'typescript-eslint';
import globals from "globals";
import { globalIgnores } from "eslint/config";
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Known brand names / acronyms that should NOT be lowercased. */
const ALLOWED_UPPERCASE = new Set([
	'Sidekick', 'Copilot', 'Markdown', 'GitHub', 'URL', 'API', 'LLM',
	'MCP', 'CLI', 'JSON', 'YAML', 'HTML', 'CSS', 'UI', 'ID',
	'Settings', 'Community', 'Enter', 'Tools',
]);

/**
 * Check whether a string literal is in sentence case.
 * Sentence case = first letter uppercase, remaining words lowercase
 * unless they are brand names or acronyms.
 */
function isSentenceCase(text: string): boolean {
	// Skip very short strings, template-like strings, paths, URLs, placeholders
	if (text.length < 2) return true;
	const trimmed = text.trim();
	// Skip single-word strings (badge text, status labels)
	if (!/\s/.test(trimmed)) return true;
	// Skip strings starting with non-letter characters (bullets, "+", symbols)
	if (/^[^a-zA-Z]/.test(trimmed)) return true;
	// Skip pure placeholder-style strings (ghp_…, sk-…, model-id, localhost:)
	if (/^(ghp_|sk-|token|model-|localhost)/i.test(trimmed)) return true;
	// Skip strings that start with a known brand/product followed by ':'
	const brandPrefixMatch = trimmed.match(/^(\w+):/);
	if (brandPrefixMatch && ALLOWED_UPPERCASE.has(brandPrefixMatch[1])) return true;
	// Allow "e.g." prefix (with optional comma) — strip it and check the rest
	let checkText = trimmed;
	if (/^e\.g\.[,;:]?\s*/i.test(checkText)) {
		checkText = checkText.replace(/^e\.g\.[,;:]?\s*/i, '').trim();
		if (!checkText) return true;
		// The remainder after "e.g." may start lowercase (it's an example list)
	} else if (/^[a-z]/.test(trimmed)) {
		return false; // must start uppercase
	}
	// Split into sentences (after . ! ? …) and check each independently
	const sentences = checkText.split(/(?<=[.!?\u2026])\s+/);
	for (const sentence of sentences) {
		const words = sentence.split(/\s+/);
		// Start from word index 1 for the first sentence, 0th word of subsequent sentences is ok (new sentence)
		const startIdx = sentence === sentences[0] ? 1 : 1;
		for (let i = startIdx; i < words.length; i++) {
			// Split hyphenated words and check each part
			const parts = words[i].split('-');
			for (const part of parts) {
				const clean = part.replace(/[^a-zA-Z]/g, '');
				if (!clean) continue;
				if (ALLOWED_UPPERCASE.has(clean)) continue;
				// If word starts uppercase and is not an allowed name, flag it
				if (/^[A-Z]/.test(clean) && !/^[A-Z]+$/.test(clean)) return false;
			}
		}
	}
	return true;
}

export default tseslint.config(
	...tseslint.configs.recommended,
	{
		files: ['src/**/*.ts'],
		plugins: {
			'sidekick-custom': {
				rules: {
					'ui-sentence-case': {
						meta: {
							type: 'suggestion',
							docs: { description: 'Enforce sentence case for UI text in setTitle, setText, setPlaceholder, Notice, createEl, createSpan, createDiv, and attr title/placeholder' },
							messages: {
								notSentenceCase: 'UI text "{{text}}" should use sentence case.',
							},
							schema: [],
						},
						create(context: { report: (opts: { node: unknown; messageId: string; data: Record<string, string> }) => void }) {
							const UI_METHODS = new Set(['setTitle', 'setText', 'setPlaceholder', 'setName', 'setDesc']);
							const CREATE_METHODS = new Set(['createEl', 'createSpan', 'createDiv']);
							const ATTR_TEXT_KEYS = new Set(['title', 'placeholder']);

							/** Report a Literal node if its value is not sentence case. */
							function checkLiteral(node: { type?: string; value?: unknown }) {
								if (node?.type === 'Literal' && typeof node.value === 'string' && !isSentenceCase(node.value)) {
									context.report({ node: node as unknown as never, messageId: 'notSentenceCase', data: { text: node.value } });
								}
							}

							/** Find a Property node by key name inside an ObjectExpression. */
							function findProp(obj: { type?: string; properties?: Array<{ key?: { name?: string; value?: string }; value?: unknown }> }, key: string) {
								if (obj?.type !== 'ObjectExpression') return undefined;
								return obj.properties?.find(
									(p: { key?: { name?: string; value?: string } }) =>
										(p.key?.name === key) || (p.key?.value === key)
								);
							}

							return {
								// .setTitle('Text'), .setText('Text'), etc.
								CallExpression(node: {
									callee?: { type?: string; property?: { name?: string }; name?: string };
									arguments?: Array<{ type?: string; value?: unknown; properties?: unknown[] }>;
								}) {
									const callee = node.callee;
									const args = node.arguments;

									// --- .setTitle / .setText / .setPlaceholder / .setName / .setDesc ---
									if (
										callee?.type === 'MemberExpression' &&
										typeof callee.property?.name === 'string' &&
										UI_METHODS.has(callee.property.name)
									) {
										const arg = args?.[0];
										checkLiteral(arg as { type?: string; value?: unknown });
									}

									// --- .createEl / .createSpan / .createDiv with {text: '...'} ---
									if (
										callee?.type === 'MemberExpression' &&
										typeof callee.property?.name === 'string' &&
										CREATE_METHODS.has(callee.property.name)
									) {
										// Options object is 1st arg for createSpan/createDiv, 2nd arg for createEl
										const optsArg = callee.property.name === 'createEl' ? args?.[1] : args?.[0];
										if (optsArg?.type === 'ObjectExpression') {
											const textProp = findProp(optsArg as Parameters<typeof findProp>[0], 'text');
											if (textProp) checkLiteral(textProp.value as { type?: string; value?: unknown });

											// Also check attr: {title: '...', placeholder: '...'}
											const attrProp = findProp(optsArg as Parameters<typeof findProp>[0], 'attr');
											if (attrProp?.value && (attrProp.value as { type?: string }).type === 'ObjectExpression') {
												const attrObj = attrProp.value as Parameters<typeof findProp>[0];
												for (const key of ATTR_TEXT_KEYS) {
													const kp = findProp(attrObj, key);
													if (kp) checkLiteral(kp.value as { type?: string; value?: unknown });
												}
											}
										}
									}

									// --- new Notice('Text') via CallExpression for `Notice(...)` ---
									if (
										callee?.type === 'Identifier' &&
										(callee as unknown as { name: string }).name === 'Notice'
									) {
										const arg = args?.[0];
										checkLiteral(arg as { type?: string; value?: unknown });
									}
								},
								// new Notice('Text') via NewExpression
								NewExpression(node: { callee?: { type?: string; name?: string }; arguments?: Array<{ type?: string; value?: unknown }> }) {
									if (
										node.callee?.type === 'Identifier' &&
										node.callee.name === 'Notice'
									) {
										const arg = node.arguments?.[0];
										checkLiteral(arg as { type?: string; value?: unknown });
									}
								},
							};
						},
					},
				},
			},
		},
		rules: {
			'sidekick-custom/ui-sentence-case': 'error',
			'@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
		},
		languageOptions: {
			globals: {
				...globals.browser,
			},
			parserOptions: {
				projectService: {
					allowDefaultProject: [
						'eslint.config.js',
						'manifest.json'
					]
				},
				tsconfigRootDir: __dirname,
				extraFileExtensions: ['.json']
			},
		},
	},
	globalIgnores([
		"node_modules",
		"dist",
		"esbuild.config.mjs",
		"eslint.config.js",
		"version-bump.mjs",
		"versions.json",
		"main.js",
	]),
);
