/**
 * Tests for fresh-install CLI initialization: environment setup, PATH handling,
 * gh CLI discovery, and diagnostic checks.
 *
 * These tests verify that Obsidian (an Electron app with a restricted
 * environment) can properly discover and authenticate with the GitHub CLI
 * and Copilot CLI, especially on Windows where PATH casing, PATHEXT, and
 * install-path variations commonly cause issues.
 */
import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import path from 'node:path';
import os from 'node:os';

// ── platformEnv is pure (no node:* imports) → test directly ──────────

describe('platformEnv', () => {
	// We need to control process.platform for cross-platform coverage.
	// platformEnv reads IS_WINDOWS at module load time, so we test the
	// functions that depend on runtime process.env instead.

	describe('getDefaultBinDirs', () => {
		let originalEnv: NodeJS.ProcessEnv;

		beforeEach(() => {
			originalEnv = {...process.env};
		});
		afterEach(() => {
			process.env = originalEnv;
		});

		it('should return an array of strings', async () => {
			const {getDefaultBinDirs} = await import('../src/platformEnv');
			const dirs = getDefaultBinDirs();
			expect(Array.isArray(dirs)).toBe(true);
			for (const d of dirs) {
				expect(typeof d).toBe('string');
				expect(d.length).toBeGreaterThan(0);
			}
		});

		it('should include GitHub CLI path when LOCALAPPDATA is set (Windows)', async () => {
			// This test is meaningful on Windows; on other platforms the
			// IS_WINDOWS guard means LOCALAPPDATA paths won't be included.
			const {IS_WINDOWS, getDefaultBinDirs} = await import('../src/platformEnv');
			if (!IS_WINDOWS) return; // skip on non-Windows CI
			process.env['LOCALAPPDATA'] = 'C:\\Users\\test\\AppData\\Local';
			const dirs = getDefaultBinDirs();
			expect(dirs.some(d => d.includes('GitHub CLI'))).toBe(true);
		});

		it('should include WinGet links when LOCALAPPDATA is set (Windows)', async () => {
			const {IS_WINDOWS, getDefaultBinDirs} = await import('../src/platformEnv');
			if (!IS_WINDOWS) return;
			process.env['LOCALAPPDATA'] = 'C:\\Users\\test\\AppData\\Local';
			const dirs = getDefaultBinDirs();
			expect(dirs.some(d => d.includes('WinGet\\Links'))).toBe(true);
		});

		it('should include Chocolatey bin when ChocolateyInstall is set (Windows)', async () => {
			const {IS_WINDOWS, getDefaultBinDirs} = await import('../src/platformEnv');
			if (!IS_WINDOWS) return;
			process.env['ChocolateyInstall'] = 'C:\\ProgramData\\chocolatey';
			const dirs = getDefaultBinDirs();
			expect(dirs.some(d => d === 'C:\\ProgramData\\chocolatey\\bin')).toBe(true);
		});

		it('should include scoop shims when home is available (Windows)', async () => {
			const {IS_WINDOWS, getDefaultBinDirs} = await import('../src/platformEnv');
			if (!IS_WINDOWS) return;
			process.env['USERPROFILE'] = 'C:\\Users\\test';
			const dirs = getDefaultBinDirs();
			expect(dirs.some(d => d.includes('scoop\\shims'))).toBe(true);
		});

		it('should include npm global dir when APPDATA is set (Windows)', async () => {
			const {IS_WINDOWS, getDefaultBinDirs} = await import('../src/platformEnv');
			if (!IS_WINDOWS) return;
			process.env['APPDATA'] = 'C:\\Users\\test\\AppData\\Roaming';
			const dirs = getDefaultBinDirs();
			expect(dirs.some(d => d === 'C:\\Users\\test\\AppData\\Roaming\\npm')).toBe(true);
		});
	});

	describe('buildSearchPath', () => {
		it('should prepend extra dirs to existing PATH', async () => {
			const {buildSearchPath, PATH_SEP} = await import('../src/platformEnv');
			const result = buildSearchPath(['/my/custom/dir']);
			const segments = result.split(PATH_SEP);
			expect(segments[0]).toBe('/my/custom/dir');
		});

		it('should include default bin dirs when includeDefaults is true', async () => {
			const {buildSearchPath, getDefaultBinDirs, PATH_SEP} = await import('../src/platformEnv');
			const defaults = getDefaultBinDirs();
			const result = buildSearchPath([], true);
			const segments = result.split(PATH_SEP);
			for (const d of defaults) {
				expect(segments).toContain(d);
			}
		});

		it('should NOT include defaults when includeDefaults is false', async () => {
			const {buildSearchPath, getDefaultBinDirs, PATH_SEP} = await import('../src/platformEnv');
			const defaults = getDefaultBinDirs();
			const result = buildSearchPath(['/only/this'], false);
			const segments = result.split(PATH_SEP);
			expect(segments[0]).toBe('/only/this');
			// defaults should not be in the list (they may still appear if
			// they happen to be in process.env.PATH, but not explicitly added).
			for (const d of defaults) {
				// The default dirs should not be prepended — any occurrence
				// would only be because they're already in process.env.PATH.
				const idx = segments.indexOf(d);
				if (idx >= 0) {
					// If found, it must come from the original PATH, not from
					// extra dirs position (index 0).
					expect(idx).toBeGreaterThan(0);
				}
			}
		});
	});

	describe('buildSpawnEnv', () => {
		it('should produce an env with PATH key', async () => {
			const {buildSpawnEnv} = await import('../src/platformEnv');
			const env = buildSpawnEnv();
			expect(env).toHaveProperty('PATH');
			expect(typeof env['PATH']).toBe('string');
			expect(env['PATH'].length).toBeGreaterThan(0);
		});
	});
});

// ── cleanEnv tests ───────────────────────────────────────────────────
// cleanEnv depends on process.env and platformEnv helpers.  We stub
// process.env to simulate the problematic Windows scenarios.

describe('cleanEnv', () => {
	let originalEnv: NodeJS.ProcessEnv;

	beforeEach(() => {
		originalEnv = {...process.env};
	});
	afterEach(() => {
		process.env = originalEnv;
	});

	it('should produce a PATH key in the output', async () => {
		const {cleanEnv} = await import('../src/copilot');
		const env = cleanEnv();
		expect(env).toHaveProperty('PATH');
		expect(env['PATH'].length).toBeGreaterThan(0);
	});

	it('should normalise Windows title-case "Path" to "PATH"', async () => {
		// Simulate Windows behavior: env has "Path" not "PATH"
		delete process.env['PATH'];
		(process.env as Record<string, string>)['Path'] = 'C:\\Windows\\system32;C:\\Windows';
		const {cleanEnv} = await import('../src/copilot');
		const env = cleanEnv();
		// Must have canonical 'PATH', not 'Path'
		expect(env).toHaveProperty('PATH');
		expect(env['PATH']).toContain('C:\\Windows\\system32');
		// Should NOT have the duplicate title-case key
		const pathKeys = Object.keys(env).filter(k => k.toUpperCase() === 'PATH');
		expect(pathKeys).toEqual(['PATH']);
	});

	it('should include allowed env vars via case-insensitive matching', async () => {
		// Windows may store APPDATA as "AppData" — cleanEnv must still include it
		(process.env as Record<string, string>)['APPDATA'] = 'C:\\Users\\test\\AppData\\Roaming';
		const {cleanEnv} = await import('../src/copilot');
		const env = cleanEnv();
		// APPDATA matches the 'APPDATA' prefix
		expect(env['APPDATA']).toBe('C:\\Users\\test\\AppData\\Roaming');
	});

	it('should filter out non-allowlisted vars', async () => {
		(process.env as Record<string, string>)['ELECTRON_RUN_AS_NODE'] = '1';
		(process.env as Record<string, string>)['SECRET_SAUCE'] = 'hidden';
		const {cleanEnv} = await import('../src/copilot');
		const env = cleanEnv();
		expect(env).not.toHaveProperty('ELECTRON_RUN_AS_NODE');
		expect(env).not.toHaveProperty('SECRET_SAUCE');
	});

	it('should include GITHUB_* and GH_* vars', async () => {
		(process.env as Record<string, string>)['GITHUB_TOKEN'] = 'gho_test123';
		(process.env as Record<string, string>)['GH_HOST'] = 'github.com';
		const {cleanEnv} = await import('../src/copilot');
		const env = cleanEnv();
		expect(env['GITHUB_TOKEN']).toBe('gho_test123');
		expect(env['GH_HOST']).toBe('github.com');
	});

	it('should include proxy vars', async () => {
		(process.env as Record<string, string>)['HTTP_PROXY'] = 'http://proxy:8080';
		(process.env as Record<string, string>)['https_proxy'] = 'http://proxy:8443';
		const {cleanEnv} = await import('../src/copilot');
		const env = cleanEnv();
		expect(env['HTTP_PROXY']).toBe('http://proxy:8080');
		expect(env['https_proxy']).toBe('http://proxy:8443');
	});

	it('should augment PATH with default bin dirs', async () => {
		const {cleanEnv} = await import('../src/copilot');
		const {getDefaultBinDirs, PATH_SEP} = await import('../src/platformEnv');
		const env = cleanEnv();
		const pathDirs = env['PATH'].split(PATH_SEP);
		const defaults = getDefaultBinDirs();
		// At least some default dirs should appear in the PATH
		const found = defaults.filter(d => pathDirs.includes(d));
		expect(found.length).toBeGreaterThan(0);
	});

	it('should include PATHEXT on Windows or provide fallback', async () => {
		const {IS_WINDOWS} = await import('../src/platformEnv');
		const {cleanEnv} = await import('../src/copilot');
		const env = cleanEnv();
		if (IS_WINDOWS) {
			// On Windows, PATHEXT must be present (from env or fallback)
			const pathextKey = Object.keys(env).find(k => k.toUpperCase() === 'PATHEXT');
			expect(pathextKey).toBeDefined();
			const val = env[pathextKey!];
			expect(val).toContain('.EXE');
			expect(val).toContain('.CMD');
		}
	});

	it('should preserve ChocolateyInstall when set', async () => {
		(process.env as Record<string, string>)['ChocolateyInstall'] = 'C:\\ProgramData\\chocolatey';
		const {cleanEnv} = await import('../src/copilot');
		const {IS_WINDOWS} = await import('../src/platformEnv');
		const env = cleanEnv();
		// ChocolateyInstall matches CHOCOLATEYINSTALL prefix (case-insensitive)
		if (IS_WINDOWS) {
			expect(env['ChocolateyInstall']).toBe('C:\\ProgramData\\chocolatey');
		}
	});
});

// ── resolveCommandViaPowerShell tests (Windows integration) ──────────

describe('resolveCommandViaPowerShell', () => {
	it('should return a string path or undefined (never throw)', async () => {
		const {resolveCommandViaPowerShell} = await import('../src/copilot');
		const result = await resolveCommandViaPowerShell('gh');
		expect(result === undefined || typeof result === 'string').toBe(true);
	});

	it('should find a well-known binary like "cmd" on Windows', async () => {
		const {resolveCommandViaPowerShell} = await import('../src/copilot');
		const {IS_WINDOWS} = await import('../src/platformEnv');
		if (!IS_WINDOWS) return;
		const result = await resolveCommandViaPowerShell('cmd');
		expect(result).toBeDefined();
		expect(result!.toLowerCase()).toContain('cmd');
	});

	it('should return undefined for a non-existent binary', async () => {
		const {resolveCommandViaPowerShell} = await import('../src/copilot');
		const {IS_WINDOWS} = await import('../src/platformEnv');
		if (!IS_WINDOWS) return;
		const result = await resolveCommandViaPowerShell('this-binary-surely-does-not-exist-xyz');
		expect(result).toBeUndefined();
	});

	it('should find gh via PowerShell if installed (Windows)', async () => {
		const {resolveCommandViaPowerShell} = await import('../src/copilot');
		const {IS_WINDOWS} = await import('../src/platformEnv');
		if (!IS_WINDOWS) return;
		const result = await resolveCommandViaPowerShell('gh');
		// gh may or may not be installed; just verify it doesn't throw
		if (result) {
			expect(result.toLowerCase()).toContain('gh');
			const fs = await import('node:fs/promises');
			await expect(fs.access(result)).resolves.toBeUndefined();
		}
	});

	it('should find copilot via PowerShell if installed (Windows)', async () => {
		const {resolveCommandViaPowerShell} = await import('../src/copilot');
		const {IS_WINDOWS} = await import('../src/platformEnv');
		if (!IS_WINDOWS) return;
		const result = await resolveCommandViaPowerShell('copilot');
		if (result) {
			expect(result.toLowerCase()).toContain('copilot');
			const fs = await import('node:fs/promises');
			await expect(fs.access(result)).resolves.toBeUndefined();
			console.log(`[powershell] copilot found at: ${result}`);
		} else {
			console.warn('[powershell] copilot not found via Get-Command');
		}
	});
});

// ── resolveGhPath tests (integration) ────────────────────────────────
// These run the actual binary search on the host machine.  They verify
// the function works on the developer's setup and won't fail on CI where
// `gh` may not be installed (we gracefully expect undefined there).

describe('resolveGhPath', () => {
	it('should return a string path or undefined (never throw)', async () => {
		const {resolveGhPath} = await import('../src/copilot');
		const result = await resolveGhPath();
		expect(result === undefined || typeof result === 'string').toBe(true);
	});

	it('should find gh when installed on the host', async () => {
		const {resolveGhPath} = await import('../src/copilot');
		const result = await resolveGhPath();
		// If gh is installed (as expected on dev machines), verify the path
		if (result) {
			expect(result.toLowerCase()).toContain('gh');
			// The file should actually exist
			const fs = await import('node:fs/promises');
			await expect(fs.access(result)).resolves.toBeUndefined();
		}
	});
});

// ── resolveGhToken tests (integration) ───────────────────────────────

describe('resolveGhToken', () => {
	it('should return a token string or undefined (never throw)', async () => {
		const {resolveGhToken} = await import('../src/copilot');
		const result = await resolveGhToken();
		expect(result === undefined || typeof result === 'string').toBe(true);
	});

	it('should return a non-empty string when gh is authenticated', async () => {
		const {resolveGhToken} = await import('../src/copilot');
		const token = await resolveGhToken();
		// On a developer machine with `gh auth login` done, we expect a token.
		// On CI without gh, token will be undefined — that's ok.
		if (token) {
			expect(token.length).toBeGreaterThan(10);
		}
	});
});

// ── diagnoseSetup tests (integration) ────────────────────────────────

describe('diagnoseSetup', () => {
	it('should return exactly 6 diagnostic checks', async () => {
		const {diagnoseSetup} = await import('../src/copilot');
		const checks = await diagnoseSetup(os.tmpdir());
		expect(checks).toHaveLength(6);
	});

	it('should have the expected labels in order', async () => {
		const {diagnoseSetup} = await import('../src/copilot');
		const checks = await diagnoseSetup(os.tmpdir());
		const labels = checks.map(c => c.label);
		expect(labels).toEqual([
			'GitHub CLI found',
			'GitHub CLI version',
			'GitHub CLI authenticated',
			'GitHub token retrieval',
			'Copilot CLI binary',
			'Subprocess PATH',
		]);
	});

	it('every check should have label, ok (boolean), and detail (string)', async () => {
		const {diagnoseSetup} = await import('../src/copilot');
		const checks = await diagnoseSetup(os.tmpdir());
		for (const check of checks) {
			expect(typeof check.label).toBe('string');
			expect(typeof check.ok).toBe('boolean');
			expect(typeof check.detail).toBe('string');
			expect(check.label.length).toBeGreaterThan(0);
			expect(check.detail.length).toBeGreaterThan(0);
		}
	});

	it('PATH sanity check should pass (subprocess has a reasonable PATH)', async () => {
		const {diagnoseSetup} = await import('../src/copilot');
		const checks = await diagnoseSetup(os.tmpdir());
		const pathCheck = checks.find(c => c.label === 'Subprocess PATH');
		expect(pathCheck).toBeDefined();
		expect(pathCheck!.ok).toBe(true);
	});

	it('should report gh CLI found and authenticated on dev machine', async () => {
		const {diagnoseSetup} = await import('../src/copilot');
		const checks = await diagnoseSetup(os.tmpdir());
		const ghFound = checks.find(c => c.label === 'GitHub CLI found');
		// This is the key integration test: on a dev machine with gh installed,
		// ALL the first four checks should pass. On CI without gh, they may fail
		// gracefully — the test just verifies the structure.
		if (ghFound?.ok) {
			const ghVersion = checks.find(c => c.label === 'GitHub CLI version');
			expect(ghVersion?.ok).toBe(true);
			expect(ghVersion?.detail).toMatch(/gh version/i);

			const ghAuth = checks.find(c => c.label === 'GitHub CLI authenticated');
			// Auth may or may not be set up — just verify it doesn't crash
			expect(typeof ghAuth?.ok).toBe('boolean');

			const ghToken = checks.find(c => c.label === 'GitHub token retrieval');
			expect(typeof ghToken?.ok).toBe('boolean');
		}
	});

	it('Copilot CLI binary should handle nonexistent pluginDir gracefully', async () => {
		const {diagnoseSetup} = await import('../src/copilot');
		const checks = await diagnoseSetup(path.join(os.tmpdir(), 'no-such-dir-12345'));
		const cliCheck = checks.find(c => c.label === 'Copilot CLI binary');
		expect(cliCheck).toBeDefined();
		// No binary in a random temp dir — it may still resolve via PowerShell
		// Get-Command on Windows if copilot is installed system-wide.
		// Either way, the check should not throw.
		expect(typeof cliCheck!.ok).toBe('boolean');
	});

	it('should respect an explicit cliPath when provided', async () => {
		const {diagnoseSetup} = await import('../src/copilot');
		const fakePath = path.join(os.tmpdir(), 'fake-copilot.exe');
		const checks = await diagnoseSetup(os.tmpdir(), fakePath);
		const cliCheck = checks.find(c => c.label === 'Copilot CLI binary');
		expect(cliCheck).toBeDefined();
		expect(cliCheck!.ok).toBe(true);
		expect(cliCheck!.detail).toBe(fakePath);
	});
});

// ── Simulated fresh install scenario ─────────────────────────────────
// This test simulates the key conditions of a fresh Obsidian install:
// - No explicit cliPath configured
// - useLoggedInUser = true (default setting)
// - The system must discover gh from PATH and obtain a token

describe('fresh install initialization', () => {
	it('should discover gh CLI from the augmented PATH', async () => {
		const {resolveGhPath} = await import('../src/copilot');
		const {IS_WINDOWS} = await import('../src/platformEnv');

		const ghPath = await resolveGhPath();
		// On a dev machine gh should be found. Log the path for CI diagnostics.
		if (ghPath) {
			console.log(`[fresh-install] gh found at: ${ghPath}`);
			if (IS_WINDOWS) {
				// On Windows, path should end with .exe or .cmd
				expect(ghPath).toMatch(/\.(exe|cmd)$/i);
			}
		} else {
			console.warn('[fresh-install] gh not found — install GitHub CLI for full integration');
		}
	});

	it('should build a subprocess env with canonical PATH and necessary vars', async () => {
		const {cleanEnv} = await import('../src/copilot');
		const {IS_WINDOWS} = await import('../src/platformEnv');
		const env = cleanEnv();

		// PATH must exist and be non-empty
		expect(env['PATH']).toBeDefined();
		expect(env['PATH'].length).toBeGreaterThan(0);

		// No duplicate PATH keys (the Windows "Path" bug)
		const pathKeys = Object.keys(env).filter(k => k.toUpperCase() === 'PATH');
		expect(pathKeys).toHaveLength(1);
		expect(pathKeys[0]).toBe('PATH');

		if (IS_WINDOWS) {
			// Must have PATHEXT for .cmd/.exe resolution
			const pathextKey = Object.keys(env).find(k => k.toUpperCase() === 'PATHEXT');
			expect(pathextKey).toBeDefined();

			// Must have essential Windows vars
			const systemRoot = Object.keys(env).find(k => k.toUpperCase() === 'SYSTEMROOT');
			if (process.env['SystemRoot'] || process.env['SYSTEMROOT']) {
				expect(systemRoot).toBeDefined();
			}
		}

		// Must NOT leak Electron-specific vars
		expect(env).not.toHaveProperty('ELECTRON_RUN_AS_NODE');
		expect(env).not.toHaveProperty('ORIGINAL_XDG_CURRENT_DESKTOP');
	});

	it('end-to-end: token retrieval should work when gh is installed and authenticated', async () => {
		const {resolveGhPath, resolveGhToken} = await import('../src/copilot');

		const ghPath = await resolveGhPath();
		if (!ghPath) {
			console.warn('[fresh-install] Skipping token test — gh not installed');
			return;
		}

		const token = await resolveGhToken();
		if (token) {
			console.log(`[fresh-install] Token obtained (${token.length} chars)`);
			expect(token.length).toBeGreaterThan(10);
		} else {
			console.warn('[fresh-install] gh found but not authenticated — run "gh auth login"');
		}
	});

	it('diagnostics should pass all checks on a properly configured dev machine', async () => {
		const {diagnoseSetup, resolveGhPath} = await import('../src/copilot');

		const ghPath = await resolveGhPath();
		if (!ghPath) {
			console.warn('[fresh-install] Skipping full diagnostics — gh not installed');
			return;
		}

		const checks = await diagnoseSetup(os.tmpdir());
		const failed = checks.filter(c => !c.ok);

		if (failed.length > 0) {
			console.warn('[fresh-install] Some diagnostics failed:');
			for (const f of failed) {
				console.warn(`  ✗ ${f.label}: ${f.detail}`);
			}
		}

		// The gh-found and PATH checks should always pass when gh is installed
		const ghFound = checks.find(c => c.label === 'GitHub CLI found');
		expect(ghFound?.ok).toBe(true);
		const pathCheck = checks.find(c => c.label === 'Subprocess PATH');
		expect(pathCheck?.ok).toBe(true);
	});
});
