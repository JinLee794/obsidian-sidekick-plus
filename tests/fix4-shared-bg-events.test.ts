/**
 * Tests for Fix #4: Shared background event handler (bgEvents.ts).
 *
 * These are real unit tests — bgEvents.registerBackgroundEvents is a pure
 * function that takes a mock session, a BackgroundSession state object,
 * and callbacks. We can test it fully with mocks.
 */
import {describe, it, expect, vi, beforeEach} from 'vitest';
import {registerBackgroundEvents} from '../src/view/bgEvents';
import type {BgEventCallbacks} from '../src/view/bgEvents';
import type {BackgroundSession} from '../src/view/types';

// ── Mock session that captures event registrations ──

type EventHandler = (event: {data: Record<string, unknown>}) => void;

function createMockSession() {
	const handlers = new Map<string, EventHandler>();
	return {
		on(eventName: string, handler: EventHandler) {
			handlers.set(eventName, handler);
			return () => { handlers.delete(eventName); };
		},
		emit(eventName: string, data: Record<string, unknown> = {}) {
			const handler = handlers.get(eventName);
			if (handler) handler({data});
		},
		handlers,
	};
}

function createMockBg(): BackgroundSession {
	return {
		sessionId: 'test-session',
		session: null as unknown as BackgroundSession['session'],
		messages: [],
		isStreaming: true,
		streamingContent: '',
		savedDom: null,
		unsubscribers: [],
		turnStartTime: 0,
		turnToolsUsed: [],
		turnSkillsUsed: [],
		turnUsage: null,
		activeToolCalls: new Map(),
		streamingComponent: null,
		streamingBodyEl: null,
		streamingWrapperEl: null,
		toolCallsContainer: null,
		sessionInputTokens: 0,
	};
}

describe('Fix #4: registerBackgroundEvents', () => {
	let session: ReturnType<typeof createMockSession>;
	let bg: BackgroundSession;
	let callbacks: BgEventCallbacks;

	beforeEach(() => {
		session = createMockSession();
		bg = createMockBg();
		callbacks = {
			onSessionFinished: vi.fn(),
			onToolDiscovered: vi.fn(),
			onSessionEvent: vi.fn(),
			removeChild: vi.fn(),
		};
		registerBackgroundEvents(session as unknown as BackgroundSession['session'], bg, callbacks);
	});

	it('should register unsubscribers on bg.unsubscribers', () => {
		expect(bg.unsubscribers.length).toBeGreaterThan(0);
	});

	describe('assistant.turn_start', () => {
		it('should set turnStartTime on first call', () => {
			session.emit('assistant.turn_start');
			expect(bg.turnStartTime).toBeGreaterThan(0);
		});

		it('should not overwrite turnStartTime on subsequent calls', () => {
			session.emit('assistant.turn_start');
			const first = bg.turnStartTime;
			session.emit('assistant.turn_start');
			expect(bg.turnStartTime).toBe(first);
		});
	});

	describe('assistant.message_delta', () => {
		it('should accumulate streaming content', () => {
			session.emit('assistant.message_delta', {deltaContent: 'Hello '});
			session.emit('assistant.message_delta', {deltaContent: 'world'});
			expect(bg.streamingContent).toBe('Hello world');
		});
	});

	describe('assistant.usage', () => {
		it('should initialize turnUsage on first event', () => {
			session.emit('assistant.usage', {
				inputTokens: 100, outputTokens: 50,
				cacheReadTokens: 10, cacheWriteTokens: 5,
				model: 'gpt-4',
			});
			expect(bg.turnUsage).toEqual({
				inputTokens: 100, outputTokens: 50,
				cacheReadTokens: 10, cacheWriteTokens: 5,
				model: 'gpt-4',
			});
		});

		it('should accumulate across multiple usage events', () => {
			session.emit('assistant.usage', {inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0});
			session.emit('assistant.usage', {inputTokens: 200, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0});
			expect(bg.turnUsage!.inputTokens).toBe(300);
			expect(bg.turnUsage!.outputTokens).toBe(150);
		});
	});

	describe('session.idle', () => {
		it('should push accumulated content to messages', () => {
			bg.streamingContent = 'Final response';
			session.emit('session.idle');
			expect(bg.messages).toHaveLength(1);
			expect(bg.messages[0]!.role).toBe('assistant');
			expect(bg.messages[0]!.content).toBe('Final response');
		});

		it('should not push empty content', () => {
			bg.streamingContent = '';
			session.emit('session.idle');
			expect(bg.messages).toHaveLength(0);
		});

		it('should reset all turn state', () => {
			bg.streamingContent = 'content';
			bg.turnStartTime = 12345;
			bg.turnToolsUsed = ['tool1'];
			bg.turnSkillsUsed = ['skill1'];
			bg.turnUsage = {inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0};
			bg.isStreaming = true;

			session.emit('session.idle');

			expect(bg.streamingContent).toBe('');
			expect(bg.turnStartTime).toBe(0);
			expect(bg.turnToolsUsed).toEqual([]);
			expect(bg.turnSkillsUsed).toEqual([]);
			expect(bg.turnUsage).toBeNull();
			expect(bg.isStreaming).toBe(false);
		});

		it('should call onSessionFinished callback', () => {
			session.emit('session.idle');
			expect(callbacks.onSessionFinished).toHaveBeenCalledOnce();
		});

		it('should call removeChild if streamingComponent exists', () => {
			const fakeComponent = {id: 'comp'};
			bg.streamingComponent = fakeComponent as unknown as BackgroundSession['streamingComponent'];
			session.emit('session.idle');
			expect(callbacks.removeChild).toHaveBeenCalledWith(fakeComponent);
		});
	});

	describe('session.error', () => {
		it('should push error message', () => {
			session.emit('session.error', {message: 'Connection lost'});
			expect(bg.messages).toHaveLength(1);
			expect(bg.messages[0]!.content).toBe('Error: Connection lost');
			expect(bg.messages[0]!.role).toBe('info');
		});

		it('should reset streaming state', () => {
			bg.isStreaming = true;
			bg.streamingContent = 'partial';
			session.emit('session.error', {message: 'fail'});
			expect(bg.isStreaming).toBe(false);
			expect(bg.streamingContent).toBe('');
		});

		it('should call onSessionFinished callback', () => {
			session.emit('session.error', {message: 'fail'});
			expect(callbacks.onSessionFinished).toHaveBeenCalledOnce();
		});
	});

	describe('tool.execution_start', () => {
		it('should track tool name', () => {
			session.emit('tool.execution_start', {toolName: 'search', toolCallId: '1'});
			expect(bg.turnToolsUsed).toEqual(['search']);
		});

		it('should call onToolDiscovered when MCP server present', () => {
			session.emit('tool.execution_start', {
				toolName: 'mail:ListMessages',
				toolCallId: '2',
				mcpServerName: 'm365',
			});
			expect(callbacks.onToolDiscovered).toHaveBeenCalledWith('m365', 'mail:ListMessages');
		});

		it('should NOT call onToolDiscovered when no MCP server', () => {
			session.emit('tool.execution_start', {toolName: 'bash', toolCallId: '3'});
			expect(callbacks.onToolDiscovered).not.toHaveBeenCalled();
		});
	});

	describe('skill.invoked', () => {
		it('should track skill name', () => {
			session.emit('skill.invoked', {name: 'ascii-art'});
			expect(bg.turnSkillsUsed).toEqual(['ascii-art']);
		});

		it('should accumulate multiple skills', () => {
			session.emit('skill.invoked', {name: 'ascii-art'});
			session.emit('skill.invoked', {name: 'code-review'});
			expect(bg.turnSkillsUsed).toEqual(['ascii-art', 'code-review']);
		});
	});

	describe('session.info / session.warning', () => {
		it('should forward info events to callback', () => {
			session.emit('session.info', {infoType: 'mcp_connected', message: 'OK'});
			expect(callbacks.onSessionEvent).toHaveBeenCalledWith('mcp_connected', 'OK', 'info');
		});

		it('should forward warning events to callback', () => {
			session.emit('session.warning', {warningType: 'mcp_slow', message: 'Timeout'});
			expect(callbacks.onSessionEvent).toHaveBeenCalledWith('mcp_slow', 'Timeout', 'warning');
		});
	});

	describe('unsubscribers', () => {
		it('should return working unsubscribe functions', () => {
			for (const unsub of bg.unsubscribers) unsub();
			expect(session.handlers.size).toBe(0);
		});
	});
});

describe('Fix #4: sidekickView + sessionSidebar no longer copy-paste events', () => {
	// Source-level checks to ensure the old copy-pasted blocks are gone

	it('sidekickView.ts should use registerBgEvents, not inline handlers', async () => {
		const fs = await import('node:fs');
		const path = await import('node:path');
		const source = fs.readFileSync(
			path.resolve(__dirname, '../src/sidekickView.ts'), 'utf-8'
		);
		// Should import and call the shared utility
		expect(source).toContain("import {registerBackgroundEvents as registerBgEvents}");
		expect(source).toContain('registerBgEvents(');
		// Should NOT have inline session.on calls in registerBackgroundEvents
		const methodBody = source.slice(
			source.indexOf('registerBackgroundEvents(bg:'),
			source.indexOf('}', source.indexOf('registerBackgroundEvents(bg:') + 200)
		);
		expect(methodBody).not.toContain("session.on('assistant.");
	});

	it('sessionSidebar.ts should use registerBgEvents, not inline handlers', async () => {
		const fs = await import('node:fs');
		const path = await import('node:path');
		const source = fs.readFileSync(
			path.resolve(__dirname, '../src/view/sessionSidebar.ts'), 'utf-8'
		);
		expect(source).toContain("import {registerBackgroundEvents as registerBgEvents}");
		expect(source).toContain('registerBgEvents(');
		// registerBackgroundEvents body should be small (< 15 lines)
		const start = source.indexOf('proto.registerBackgroundEvents = function');
		const end = source.indexOf('};', start);
		const body = source.slice(start, end);
		const lineCount = body.split('\n').length;
		expect(lineCount).toBeLessThan(15);
	});
});
