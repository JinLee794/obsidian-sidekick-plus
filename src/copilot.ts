import {CopilotClient, CopilotSession, approveAll, defineTool} from '@github/copilot-sdk';
import type {
	ConnectionState,
	CustomAgentConfig,
	ModelInfo,
	SessionConfig,
	SessionMetadata,
	SessionListFilter,
	GetAuthStatusResponse,
	AssistantMessageEvent,
	MCPServerConfig,
	SessionEvent,
	SessionEventType,
	MessageOptions,
	PermissionRequest,
	PermissionRequestResult,
	PermissionHandler,
	CommandDefinition,
	CommandHandler,
	CommandContext,
	Tool,
} from '@github/copilot-sdk';
import type {ProviderConfig, UserInputHandler, UserInputRequest, UserInputResponse, ReasoningEffort} from '@github/copilot-sdk/dist/types';
import {buildSpawnEnv, EXE_SUFFIX, IS_WINDOWS, PATH_SEP, getDefaultBinDirs} from './platformEnv';

// Available at runtime in the esbuild CJS bundle.
const nodeRequire = typeof globalThis.require === 'function' ? globalThis.require : undefined;
declare const __dirname: string;
declare const process: {
	platform: string;
	arch: string;
	env: Record<string, string | undefined>;
	cwd(): string;
};

/**
 * Use PowerShell's `Get-Command` to locate an executable on Windows.
 *
 * `Get-Command` searches PATH, App Paths registry keys, PowerShell aliases,
 * and other discovery sources that neither `where.exe` nor a manual PATH
 * scan will find — making it the most thorough discovery mechanism on Windows.
 *
 * Falls back to `where.exe` when PowerShell is unavailable.
 * Returns the fully-qualified path or `undefined`.
 *
 * @internal Exported for testing.
 */
export async function resolveCommandViaPowerShell(name: string): Promise<string | undefined> {
	if (!IS_WINDOWS) return undefined;
	const fs = nodeRequire?.('node:fs/promises') as typeof import('node:fs/promises') ?? await import('node:fs/promises');
	const {execFile} = nodeRequire?.('node:child_process') as typeof import('node:child_process') ?? await import('node:child_process');
	const {promisify} = nodeRequire?.('node:util') as typeof import('node:util') ?? await import('node:util');
	const execFileAsync = promisify(execFile);

	// Try PowerShell 5.1 (ships with Windows 10+) first, then pwsh (PS 7+).
	for (const shell of ['powershell.exe', 'pwsh.exe']) {
		try {
			const {stdout} = await execFileAsync(shell, [
				'-NoProfile', '-NoLogo', '-NonInteractive', '-Command',
				`Get-Command '${name}' -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Source`,
			], {
				timeout: 8000,
				env: buildSpawnEnv(),
				windowsHide: true,
			});
			const resolved = stdout.trim().split(/\r?\n/)[0]?.trim();
			if (resolved && resolved.length > 0) {
				try { await fs.access(resolved); return resolved; } catch { /* stale */ }
			}
		} catch { /* shell not available or command not found */ }
	}

	// Last resort: where.exe (lighter weight, but less thorough)
	try {
		const {stdout} = await execFileAsync('where.exe', [name], {
			timeout: 5000,
			env: buildSpawnEnv(),
		});
		const firstLine = stdout.trim().split(/\r?\n/)[0]?.trim();
		if (firstLine && firstLine.length > 0) {
			try { await fs.access(firstLine); return firstLine; } catch { /* stale */ }
		}
	} catch { /* where.exe failed */ }

	return undefined;
}

async function resolveCommandSourcesViaPowerShell(name: string): Promise<string[]> {
	if (!IS_WINDOWS) return [];
	const fs = nodeRequire?.('node:fs/promises') as typeof import('node:fs/promises') ?? await import('node:fs/promises');
	const {execFile} = nodeRequire?.('node:child_process') as typeof import('node:child_process') ?? await import('node:child_process');
	const {promisify} = nodeRequire?.('node:util') as typeof import('node:util') ?? await import('node:util');
	const execFileAsync = promisify(execFile);
	const sources: string[] = [];

	for (const shell of ['powershell.exe', 'pwsh.exe']) {
		try {
			const {stdout} = await execFileAsync(shell, [
				'-NoProfile', '-NoLogo', '-NonInteractive', '-Command',
				`Get-Command '${name}' -All -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source`,
			], {
				timeout: 8000,
				env: buildSpawnEnv(),
				windowsHide: true,
			});
			for (const line of stdout.trim().split(/\r?\n/)) {
				const source = line.trim();
				if (!source || sources.includes(source)) continue;
				try {
					await fs.access(source);
					sources.push(source);
				} catch { /* stale */ }
			}
			if (sources.length > 0) return sources;
		} catch { /* shell not available or command not found */ }
	}

	try {
		const {stdout} = await execFileAsync('where.exe', [name], {
			timeout: 5000,
			env: buildSpawnEnv(),
		});
		for (const line of stdout.trim().split(/\r?\n/)) {
			const source = line.trim();
			if (!source || sources.includes(source)) continue;
			try {
				await fs.access(source);
				sources.push(source);
			} catch { /* stale */ }
		}
	} catch { /* where.exe failed */ }

	return sources;
}

/**
 * npm installs Windows commands as .cmd/.ps1 shims. Electron cannot spawn
 * PowerShell shims reliably, and JavaScript entry points may be launched with
 * Obsidian's Electron executable instead of node.exe. Resolve a shim such as
 * `<prefix>/copilot.cmd` to the package's native `copilot.exe` when available,
 * falling back to the JavaScript loader for non-Electron callers.
 *
 * @internal Exported for testing.
 */
export async function resolveNpmCopilotLoaderFromCommand(commandPath: string): Promise<string | undefined> {
	const fs = nodeRequire?.('node:fs/promises') as typeof import('node:fs/promises') ?? await import('node:fs/promises');
	const path = nodeRequire?.('node:path') as typeof import('node:path') ?? await import('node:path');
	const ext = path.extname(commandPath).toLowerCase();
	if (!['.cmd', '.ps1', '.bat', ''].includes(ext)) return undefined;

	const commandDir = path.dirname(commandPath);
	const packageDirs = [path.join(commandDir, 'node_modules', '@github', 'copilot')];
	if (path.basename(commandDir).toLowerCase() === '.bin' && path.basename(path.dirname(commandDir)).toLowerCase() === 'node_modules') {
		packageDirs.push(path.join(path.dirname(commandDir), '@github', 'copilot'));
	}

	const candidates: string[] = [];
	for (const packageDir of packageDirs) {
		candidates.push(path.join(packageDir, 'node_modules', '@github', `copilot-${process.platform}-${process.arch}`, `copilot${EXE_SUFFIX}`));
		candidates.push(path.join(packageDir, 'npm-loader.js'));
	}

	for (const loader of candidates) {
		try {
			await fs.access(loader);
			return loader;
		} catch { /* not found */ }
	}
	return undefined;
}

/**
 * Search for the `gh` CLI binary on disk.
 *
 * On Windows the PATH inherited by Electron may be incomplete (especially
 * when launched from a shortcut or the Start menu). This function probes
 * well-known install locations before falling back to a PATH-based search,
 * then PowerShell's `Get-Command` as a final resort.
 *
 * Returns the fully-qualified path (e.g. `C:\Program Files\GitHub CLI\gh.exe`)
 * or `undefined` when the binary cannot be located.
 */
export async function resolveGhPath(): Promise<string | undefined> {
	const fs = nodeRequire?.('node:fs/promises') as typeof import('node:fs/promises') ?? await import('node:fs/promises');
	const path = nodeRequire?.('node:path') as typeof import('node:path') ?? await import('node:path');

	// 1. Probe well-known directories using getDefaultBinDirs() + PATH.
	const searchPath = buildSpawnEnv()['PATH'] || '';
	const dirs = searchPath.split(PATH_SEP).filter(Boolean);
	const suffixes = IS_WINDOWS ? ['.exe', '.cmd', ''] : [''];

	for (const dir of dirs) {
		for (const suffix of suffixes) {
			const candidate = path.join(dir, `gh${suffix}`);
			try {
				await fs.access(candidate);
				return candidate;
			} catch { /* not found */ }
		}
	}

	// 2. On Windows, use PowerShell Get-Command / where.exe as fallback.
	if (IS_WINDOWS) {
		const found = await resolveCommandViaPowerShell('gh');
		if (found) return found;
	}

	return undefined;
}

/**
 * Try to obtain a GitHub token from `gh auth token`.
 * Returns the token string, or undefined if `gh` is not available
 * or the user is not logged in.
 */
export async function resolveGhToken(): Promise<string | undefined> {
	const {execFile} = nodeRequire?.('node:child_process') as typeof import('node:child_process') ?? await import('node:child_process');
	const {promisify} = nodeRequire?.('node:util') as typeof import('node:util') ?? await import('node:util');
	const execFileAsync = promisify(execFile);

	// Try to use a resolved full path so we don't depend on PATH alone.
	const ghResolved = await resolveGhPath();
	const ghBin = ghResolved ?? `gh${EXE_SUFFIX}`;
	// Only use shell when falling back to a bare name (needed for .cmd
	// shim resolution on Windows).  With a full path, execFile works
	// directly and avoids space-in-path issues like "C:\Program Files\...".
	const useShell = IS_WINDOWS && !ghResolved;

	try {
		const {stdout} = await execFileAsync(ghBin, ['auth', 'token'], {
			timeout: 5000,
			env: buildSpawnEnv(),
			shell: useShell,
		});
		const token = stdout.trim();
		return token.length > 0 ? token : undefined;
	} catch {
		return undefined;
	}
}

/** Diagnostic result for a single check. */
export interface DiagnosticCheck {
	label: string;
	ok: boolean;
	detail: string;
}

/**
 * Run a series of diagnostics to verify that the GitHub CLI and Copilot CLI
 * are properly discoverable and authenticated.
 *
 * Each check is independent; failures in one don't block others.
 * The returned array always contains results for every check, in a fixed order.
 */
export async function diagnoseSetup(pluginDir: string, cliPath?: string): Promise<DiagnosticCheck[]> {
	const checks: DiagnosticCheck[] = [];
	const {execFile} = nodeRequire?.('node:child_process') as typeof import('node:child_process') ?? await import('node:child_process');
	const {promisify} = nodeRequire?.('node:util') as typeof import('node:util') ?? await import('node:util');
	const execFileAsync = promisify(execFile);

	// ── 1. GitHub CLI location ─────────────────────────────
	let ghPath: string | undefined;
	try {
		ghPath = await resolveGhPath();
		if (ghPath) {
			checks.push({label: 'GitHub CLI found', ok: true, detail: ghPath});
		} else {
			checks.push({label: 'GitHub CLI found', ok: false, detail: 'gh not found. Install from https://cli.github.com and restart Obsidian.'});
		}
	} catch (e) {
		checks.push({label: 'GitHub CLI found', ok: false, detail: `Error searching for gh: ${String(e)}`});
	}

	// ── 2. GitHub CLI version ──────────────────────────────
	if (ghPath) {
		try {
			const {stdout} = await execFileAsync(ghPath, ['--version'], {
				timeout: 5000,
				env: buildSpawnEnv(),
			});
			checks.push({label: 'GitHub CLI version', ok: true, detail: stdout.trim().split(/\r?\n/)[0] ?? 'unknown'});
		} catch (e) {
			checks.push({label: 'GitHub CLI version', ok: false, detail: `Failed to run gh --version: ${String(e)}`});
		}
	} else {
		checks.push({label: 'GitHub CLI version', ok: false, detail: 'Skipped (gh not found)'});
	}

	// ── 3. GitHub CLI auth status ──────────────────────────
	if (ghPath) {
		try {
			const {stdout} = await execFileAsync(ghPath, ['auth', 'status'], {
				timeout: 10000,
				env: buildSpawnEnv(),
			});
			const firstLine = stdout.trim().split(/\r?\n/)[0] ?? '';
			checks.push({label: 'GitHub CLI authenticated', ok: true, detail: firstLine});
		} catch (e) {
			const msg = e instanceof Error ? (e as Error & {stderr?: string}).stderr || e.message : String(e);
			checks.push({label: 'GitHub CLI authenticated', ok: false, detail: `Not authenticated. Run "gh auth login" in a terminal. ${msg}`});
		}
	} else {
		checks.push({label: 'GitHub CLI authenticated', ok: false, detail: 'Skipped (gh not found)'});
	}

	// ── 4. gh auth token retrieval ─────────────────────────
	try {
		const token = await resolveGhToken();
		if (token) {
			checks.push({label: 'GitHub token retrieval', ok: true, detail: `Token obtained (${token.length} chars)`});
		} else {
			checks.push({label: 'GitHub token retrieval', ok: false, detail: 'gh auth token returned empty. Run "gh auth login" to authenticate.'});
		}
	} catch (e) {
		checks.push({label: 'GitHub token retrieval', ok: false, detail: `Error: ${String(e)}`});
	}

	// ── 5. Copilot CLI binary ──────────────────────────────
	try {
		const resolvedCli = cliPath || await resolveDefaultCliPath(pluginDir);
		if (resolvedCli) {
			checks.push({label: 'Copilot CLI binary', ok: true, detail: resolvedCli});
		} else {
			checks.push({label: 'Copilot CLI binary', ok: false, detail: 'Not found locally; SDK will attempt PATH discovery.'});
		}
	} catch (e) {
		checks.push({label: 'Copilot CLI binary', ok: false, detail: `Error: ${String(e)}`});
	}

	// ── 6. PATH sanity ─────────────────────────────────────
	const env = cleanEnv();
	const pathVal = env['PATH'] || '';
	const pathDirs = pathVal.split(PATH_SEP).filter(Boolean);
	checks.push({
		label: 'Subprocess PATH',
		ok: pathDirs.length > 3,
		detail: `${pathDirs.length} dirs. First: ${pathDirs[0] ?? '(empty)'}`,
	});

	return checks;
}

/**
 * Resolve the platform-specific Copilot native binary.
 *
 * Search order:
 *   1. `<pluginDir>/copilot[.exe]`  — flat copy deployed alongside main.js
 *   2. `<pluginDir>/node_modules/@github/copilot/npm-loader.js` — JS entry point
 *   3. `<pluginDir>/node_modules/@github/copilot-<platform>-<arch>/copilot[.exe]` — dev checkout
 *   4. (Windows) npm-installed native Copilot binary resolved from shims
 *   5. (Windows) PowerShell `Get-Command copilot` / `where.exe copilot` — executable or JS only
 *
 * `pluginDir` must be the absolute path of the plugin folder on disk
 * (obtained from the Obsidian Plugin instance — NOT from __dirname, which
 * resolves to Electron's renderer directory inside electron.asar).
 *
 * Returns an empty string when neither is found so the caller will omit
 * cliPath and let the SDK discover the binary from PATH.
 */
async function resolveDefaultCliPath(pluginDir: string): Promise<string> {
	// Lazy-load Node.js builtins so the module can be imported on mobile
	const path = nodeRequire?.('node:path') as typeof import('node:path') ?? await import('node:path');
	const fs = nodeRequire?.('node:fs/promises') as typeof import('node:fs/promises') ?? await import('node:fs/promises');
	const ext = process.platform === 'win32' ? '.exe' : '';

	if (pluginDir) {
		// 1. Flat copy next to main.js (deployed plugin)
		const flatBin = path.join(pluginDir, `copilot${ext}`);
		try {
			await fs.access(flatBin);
			return flatBin;
		} catch { /* not found */ }

		// 2. JS entry point bundled in the @github/copilot package.
		const bundledLoader = path.join(pluginDir, 'node_modules', '@github', 'copilot', 'npm-loader.js');
		try {
			await fs.access(bundledLoader);
			return bundledLoader;
		} catch { /* not found */ }

		// 3. node_modules structure (dev checkout)
		const nativePkg = `@github/copilot-${process.platform}-${process.arch}`;
		const nativeBin = path.join(pluginDir, 'node_modules', nativePkg, `copilot${ext}`);
		try {
			await fs.access(nativeBin);
			return nativeBin;
		} catch { /* not found */ }
	}

	// 4. System-wide search via PowerShell / where.exe (Windows)
	if (IS_WINDOWS) {
		const found = await resolveCommandSourcesViaPowerShell('copilot');
		for (const source of found) {
			const loader = await resolveNpmCopilotLoaderFromCommand(source);
			if (loader) return loader;
		}
		for (const source of found) {
			const sourceExt = path.extname(source).toLowerCase();
			if (sourceExt === '.exe' || sourceExt === '.js') return source;
		}
	}

	// Not found — caller will omit cliPath so the SDK uses PATH.
	return '';
}

/**
 * Build a clean environment for the Copilot CLI subprocess.
 * Uses an allowlist of safe, well-known environment variables
 * to avoid leaking sensitive or Electron-specific values.
 *
 * On macOS/Linux, augments PATH with common binary directories that
 * Electron apps launched from Finder don't inherit from the shell.
 * This ensures the Copilot CLI can find tools like `gh` for authentication.
 *
 * @internal Exported for testing only.
 */
export function cleanEnv(): Record<string, string> {
	const ALLOWED_PREFIXES = [
		'PATH', 'HOME', 'USERPROFILE', 'TMPDIR', 'TEMP', 'TMP',
		'LANG', 'LC_', 'SHELL', 'TERM', 'COLORTERM',
		'USER', 'USERNAME', 'LOGNAME', 'HOSTNAME',
		'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PROGRAMFILES',
		'APPDATA', 'LOCALAPPDATA', 'HOMEDRIVE', 'HOMEPATH',
		'XDG_', 'DISPLAY', 'WAYLAND_DISPLAY',
		'NODE_', 'NPM_', 'NVM_',
		'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY',
		'http_proxy', 'https_proxy', 'no_proxy', 'all_proxy',
		'GITHUB_', 'GH_', 'COPILOT_',
		'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS',
		'PATHEXT', 'CHOCOLATEYINSTALL',
	];
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value === undefined) continue;
		// Case-insensitive match: Windows stores PATH as 'Path' but we
		// need it to pass the allowlist regardless of casing.
		const upper = key.toUpperCase();
		if (ALLOWED_PREFIXES.some(prefix => upper === prefix || upper.startsWith(prefix))) {
			env[key] = value;
		}
	}

	// Ensure we have a canonical PATH key.  On Windows the original env key
	// may be "Path" (title-case).  Normalise to "PATH" so child processes
	// and subsequent lookups always find it.
	const pathKey = Object.keys(env).find(k => k.toUpperCase() === 'PATH');
	const currentPath = (pathKey ? env[pathKey] : '') || '';

	// GUI-launched Electron apps inherit only a minimal PATH (especially on
	// macOS where Finder-launched apps see /usr/bin:/bin:/usr/sbin:/sbin).
	// Augment it so the Copilot CLI subprocess can find `gh`, `az`, etc.
	const extraDirs = getDefaultBinDirs();
	const existingDirs = new Set(currentPath.split(PATH_SEP));
	const missing = extraDirs.filter(d => !existingDirs.has(d));
	const finalPath = [...missing, currentPath].filter(Boolean).join(PATH_SEP);

	// Remove any original case-variant and write a canonical 'PATH'.
	if (pathKey && pathKey !== 'PATH') delete env[pathKey];
	env['PATH'] = finalPath;

	// Windows: ensure PATHEXT is present so .cmd/.exe resolution works.
	if (IS_WINDOWS && !Object.keys(env).some(k => k.toUpperCase() === 'PATHEXT')) {
		env['PATHEXT'] = '.COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC;.PS1';
	}

	return env;
}

/**
 * Manages the CopilotClient lifecycle and provides high-level methods
 * for interacting with the Copilot SDK from within Obsidian.
 */
export class CopilotService {
	private client: CopilotClient | null = null;
	private readonly cliPath: string | undefined;
	private readonly pluginDir: string;
	private readonly cliUrl: string | undefined;
	private readonly githubToken: string | undefined;
	private readonly useLoggedInUser: boolean | undefined;

	constructor(opts?: {
		cliPath?: string;
		/** Absolute path of the plugin folder on disk (from Plugin.manifest + vault adapter). */
		pluginDir?: string;
		cliUrl?: string;
		githubToken?: string;
		useLoggedInUser?: boolean;
	}) {
		this.cliPath = opts?.cliPath;
		this.pluginDir = opts?.pluginDir ?? '';
		this.cliUrl = opts?.cliUrl;
		this.githubToken = opts?.githubToken;
		this.useLoggedInUser = opts?.useLoggedInUser;
	}

	private async createClient(): Promise<CopilotClient> {
		if (this.cliUrl) {
			// Remote mode — connect to existing server
			return new CopilotClient({
				cliUrl: this.cliUrl,
				...(this.githubToken ? {gitHubToken: this.githubToken} : {}),
			});
		}
		// Local mode — spawn CLI process
		const cliPath = this.cliPath || await resolveDefaultCliPath(this.pluginDir);
		const os = nodeRequire?.('node:os') as typeof import('node:os') ?? await import('node:os');
		return new CopilotClient({
			...(cliPath ? {cliPath} : {}),
			cwd: os.homedir(),
			env: cleanEnv(),
			...(this.githubToken ? {gitHubToken: this.githubToken} : {}),
			...(this.useLoggedInUser !== undefined ? {useLoggedInUser: this.useLoggedInUser} : {}),
		});
	}

	/**
	 * Ensure the client is started and connected.
	 * If the client is in a broken state, recreates it before starting.
	 */
	async ensureConnected(): Promise<void> {
		if (!this.client) {
			this.client = await this.createClient();
		}
		const state = this.client.getState();
		if (state === 'connected') {
			return;
		}
		if (state === 'error') {
			// Previous client is broken — tear it down and recreate.
			try { await this.client.forceStop(); } catch { /* ignore */ }
			this.client = await this.createClient();
		}
		await this.client.start();
	}

	/** Current connection state. */
	getState(): ConnectionState {
		return this.client?.getState() ?? 'disconnected';
	}

	// ── Authentication ──────────────────────────────────────────────

	/** Check the current authentication status against the Copilot backend. */
	async getAuthStatus(): Promise<GetAuthStatusResponse> {
		await this.ensureConnected();
		return await this.client!.getAuthStatus();
	}

	// ── Models ──────────────────────────────────────────────────────

	/** List available models with capabilities, policy and billing info. */
	async listModels(): Promise<ModelInfo[]> {
		await this.ensureConnected();
		return await this.client!.listModels();
	}

	// ── Tools ───────────────────────────────────────────────────────

	/**
	 * List all tools known to the Copilot CLI, including MCP tools from active sessions.
	 * MCP tools have a `namespacedName` like "serverName/toolName".
	 */
	async listTools(model?: string): Promise<Array<{name: string; namespacedName?: string; description: string}>> {
		await this.ensureConnected();
		const result = await this.client!.rpc.tools.list({model});
		return result.tools;
	}

	// ── Sessions ────────────────────────────────────────────────────

	/**
	 * Create a new conversation session.
	 *
	 * @param config - Session configuration (model, tools, system message, etc.)
	 * @returns The newly created CopilotSession.
	 */
	async createSession(config: SessionConfig): Promise<CopilotSession> {
		await this.ensureConnected();
		return await this.client!.createSession({clientName: 'obsidian-sidekick', ...config});
	}

	/**
	 * Resume an existing session by its ID.
	 *
	 * @param sessionId - ID of the session to resume.
	 * @param config - Optional overrides (model, tools, etc.).
	 */
	async resumeSession(
		sessionId: string,
		config: Omit<SessionConfig, 'clientName'>,
	): Promise<CopilotSession> {
		await this.ensureConnected();
		return await this.client!.resumeSession(sessionId, {
			clientName: 'obsidian-sidekick',
			...config,
		});
	}

	/** List all persisted sessions, optionally filtered. */
	async listSessions(filter?: SessionListFilter): Promise<SessionMetadata[]> {
		await this.ensureConnected();
		return await this.client!.listSessions(filter);
	}

	/** Permanently delete a session and its data. */
	async deleteSession(sessionId: string): Promise<void> {
		await this.ensureConnected();
		return await this.client!.deleteSession(sessionId);
	}

	/** Get the most recently updated session ID, if any. */
	async getLastSessionId(): Promise<string | undefined> {
		await this.ensureConnected();
		return await this.client!.getLastSessionId();
	}

	// ── Convenience: one-shot chat ──────────────────────────────────

	/**
	 * Send a single prompt and wait for the assistant's response.
	 * Creates a temporary session, sends the message, waits for idle,
	 * then disconnect the session.
	 *
	 * @param prompt - The user prompt.
	 * @param model  - Model to use (e.g. "gpt-5", "claude-sonnet-4.5").
	 * @param systemMessage - Optional system message content to append.
	 * @param customAgents - Optional custom agent configs.
	 * @returns The assistant's final message content, or undefined.
	 */
	async chat(options: {
		prompt: string;
		model?: string;
		systemMessage?: string;
		customAgents?: CustomAgentConfig[];
		onPermissionRequest?: PermissionHandler;
		onUserInputRequest?: UserInputHandler;
		attachments?: MessageOptions['attachments'];
	}): Promise<string | undefined> {
		const session = await this.createSession({
			model: options.model,
			onPermissionRequest: options.onPermissionRequest ?? approveAll,
			...(options.onUserInputRequest ? {onUserInputRequest: options.onUserInputRequest} : {}),
			customAgents: options.customAgents,
			...(options.systemMessage
				? {systemMessage: {mode: 'append' as const, content: options.systemMessage}}
				: {}),
		});
		try {
			const response: AssistantMessageEvent | undefined =
				await session.sendAndWait({
					prompt: options.prompt,
					...(options.attachments && options.attachments.length > 0 ? {attachments: options.attachments} : {}),
				});
			return response?.data.content;
		} finally {
			await session.disconnect();
		}
	}

	/**
	 * Send a single prompt, wait for the response, and keep the session alive.
	 * Like chat() but the session is NOT disconnected, so it persists in the
	 * session list and can be resumed later.
	 *
	 * @returns Object containing the assistant's response content and the sessionId.
	 */
	async inlineChat(options: {
		prompt: string;
		model?: string;
		systemMessage?: string;
		customAgents?: CustomAgentConfig[];
		onPermissionRequest?: PermissionHandler;
		onUserInputRequest?: UserInputHandler;
		attachments?: MessageOptions['attachments'];
	}): Promise<{content: string | undefined; sessionId: string}> {
		const session = await this.createSession({
			model: options.model,
			onPermissionRequest: options.onPermissionRequest ?? approveAll,
			...(options.onUserInputRequest ? {onUserInputRequest: options.onUserInputRequest} : {}),
			customAgents: options.customAgents,
			...(options.systemMessage
				? {systemMessage: {mode: 'append' as const, content: options.systemMessage}}
				: {}),
		});
		const response: AssistantMessageEvent | undefined =
			await session.sendAndWait({
				prompt: options.prompt,
				...(options.attachments && options.attachments.length > 0 ? {attachments: options.attachments} : {}),
			});
		return {content: response?.data.content, sessionId: session.sessionId};
	}

	// ── Health ───────────────────────────────────────────────────────

	/** Ping the Copilot CLI server to verify connectivity. */
	async ping(): Promise<{message: string; timestamp: number}> {
		await this.ensureConnected();
		return await this.client!.ping();
	}

	// ── Lifecycle ───────────────────────────────────────────────────

	/**
	 * Gracefully stop the client. Falls back to forceStop on errors.
	 * Call this from the plugin's `onunload()`.
	 */
	async stop(): Promise<void> {
		if (!this.client) return;
		const errors = await this.client.stop();
		if (errors.length > 0) {
			console.error('Copilot service stop errors:', errors);
			await this.client.forceStop();
		}
	}
}

export {approveAll, defineTool};

export type {
	CopilotSession,
	ModelInfo,
	SessionMetadata,
	ConnectionState,
	GetAuthStatusResponse,
	CustomAgentConfig,
	AssistantMessageEvent,
	SessionConfig,
	MCPServerConfig,
	SessionEvent,
	SessionEventType,
	MessageOptions,
	PermissionRequest,
	PermissionRequestResult,
	PermissionHandler,
	CommandDefinition,
	CommandHandler,
	CommandContext,
	Tool,
	UserInputHandler,
	UserInputRequest,
	UserInputResponse,
	SessionListFilter,
	ProviderConfig,
	ReasoningEffort,
};
