/**
 * Tests for Fix #2: No manual agent triage — SDK handles routing.
 *
 * Validates that:
 * - The triageRequest() method no longer exists on the prototype
 * - The agentTriage setting controls the `infer` flag on customAgents
 * - Prompt templates no longer inject "Do not invoke any skills" text
 */
import {describe, it, expect} from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const sessionConfigSource = fs.readFileSync(
	path.resolve(__dirname, '../src/view/sessionConfig.ts'), 'utf-8'
);
const chatSessionSource = fs.readFileSync(
	path.resolve(__dirname, '../src/view/chatSession.ts'), 'utf-8'
);

describe('Fix #2: No manual agent triage', () => {

	it('triageRequest method should be removed from sessionConfig.ts', () => {
		expect(sessionConfigSource).not.toContain('proto.triageRequest');
		expect(sessionConfigSource).not.toContain('triagePrompt');
		expect(sessionConfigSource).not.toContain('Respond with ONLY the agent name');
	});

	it('chatSession.ts should not call triageRequest', () => {
		expect(chatSessionSource).not.toContain('triageRequest(');
		expect(chatSessionSource).not.toContain('await this.triageRequest');
	});

	it('chatSession.ts should not have the blocking triage block', () => {
		// The old pattern: "if (this.plugin.settings.agentTriage && ..."
		expect(chatSessionSource).not.toContain('settings.agentTriage');
	});

	it('agentTriage setting should control infer flag', () => {
		// sessionConfig.ts should reference agentTriage for the infer property
		expect(sessionConfigSource).toContain('this.plugin.settings.agentTriage');
		expect(sessionConfigSource).toContain('infer: allowInfer');
	});

	it('subagent.selected handler should update triageAgentForSession', () => {
		// The SDK routing event should feed back into the UI label
		expect(chatSessionSource).toContain("subagent.selected");
		expect(chatSessionSource).toContain('this.triageAgentForSession = event.data.agentName');
	});
});

describe('Fix #2b: Prompt template — no hacky skill suppression text', () => {

	it('should NOT inject "Do not invoke any skills" in prompt templates', () => {
		expect(chatSessionSource).not.toContain('Do not invoke any skills');
	});

	it('should still set skipSkills flag for prompt templates', () => {
		expect(chatSessionSource).toContain('const skipSkills = !!usedPrompt');
	});

	it('should prepend prompt content without skill suppression text', () => {
		// Check for the absence of the old verbose version
		expect(chatSessionSource).not.toContain('Respond directly based on the instructions above');
	});
});
