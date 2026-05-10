#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, copyFileSync } from "node:fs";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const SCRIPT_DIR = path.dirname(__filename);
const CONFIG_FILE = path.join(SCRIPT_DIR, ".deploy-local.conf");
const PLUGIN_ID = "sidekick-plus";
const REQUIRED_ARTIFACTS = ["main.js", "manifest.json", "styles.css"];

function trimTrailingSeparators(inputPath) {
  const normalized = path.normalize(inputPath);
  const root = path.parse(normalized).root;
  let value = normalized;

  while (value.length > root.length && /[\\/]$/.test(value)) {
    value = value.slice(0, -1);
  }

  return value;
}

function expandVaultPath(rawPath) {
  const homeDir = os.homedir();
  let expanded = rawPath.trim();

  expanded = expanded.replace(/^~(?=$|[\\/])/, homeDir);
  expanded = expanded.replace(/\$\{([^}]+)\}/g, (_, name) => process.env[name] ?? "");
  expanded = expanded.replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_, name) => process.env[name] ?? "");
  expanded = expanded.replace(/%([^%]+)%/g, (_, name) => process.env[name] ?? "");

  return trimTrailingSeparators(expanded);
}

function parseArgs(argv) {
  const args = { vault: undefined, help: false };

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];

    if (current === "--help" || current === "-h") {
      args.help = true;
      continue;
    }

    if (current === "--vault" || current === "-v") {
      args.vault = argv[index + 1];
      index += 1;
      continue;
    }

    if (current.startsWith("--vault=")) {
      args.vault = current.slice("--vault=".length);
      continue;
    }

    throw new Error(`Unknown argument: ${current}`);
  }

  if ((argv.includes("--vault") || argv.includes("-v")) && !args.vault) {
    throw new Error("Missing value for --vault");
  }

  return args;
}

async function resolveVaultPath(cliVaultArg) {
  if (cliVaultArg) {
    return expandVaultPath(cliVaultArg);
  }

  if (existsSync(CONFIG_FILE)) {
    const savedPath = readFileSync(CONFIG_FILE, "utf8").trim();
    if (savedPath) {
      return savedPath;
    }
  }

  console.log("No saved vault path found.");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  try {
    const userInput = await rl.question("Enter the path to your Obsidian vault: ");
    return expandVaultPath(userInput);
  } finally {
    rl.close();
  }
}

async function validateVaultPath(vaultPath) {
  const obsidianDir = path.join(vaultPath, ".obsidian");

  try {
    await access(obsidianDir, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function saveVaultPathIfChanged(vaultPath) {
  const currentValue = existsSync(CONFIG_FILE) ? readFileSync(CONFIG_FILE, "utf8").trim() : "";

  if (currentValue !== vaultPath) {
    writeFileSync(CONFIG_FILE, `${vaultPath}\n`, "utf8");
    console.log("Vault path saved to .deploy-local.conf");
  }
}

function runBuild() {
  const isWindows = process.platform === "win32";
  const result = spawnSync("npm", ["run", "build"], {
    stdio: "inherit",
    cwd: SCRIPT_DIR,
    shell: isWindows,
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error("Build failed.");
  }
}

function copyArtifacts(pluginDir) {
  mkdirSync(pluginDir, { recursive: true });

  for (const artifact of REQUIRED_ARTIFACTS) {
    const source = path.join(SCRIPT_DIR, artifact);
    const target = path.join(pluginDir, artifact);

    if (!existsSync(source)) {
      throw new Error(`Missing build artifact: ${artifact}`);
    }

    copyFileSync(source, target);
  }

  // Copy the platform-specific native Copilot binary so the plugin can spawn
  // it after deployment (the node_modules tree is not copied to the vault).
  const ext = process.platform === "win32" ? ".exe" : "";
  const nativePkg = `@github/copilot-${process.platform}-${process.arch}`;
  const nativeSrc = path.join(SCRIPT_DIR, "node_modules", nativePkg, `copilot${ext}`);
  const nativeDst = path.join(pluginDir, `copilot${ext}`);
  if (existsSync(nativeSrc)) {
    try {
      copyFileSync(nativeSrc, nativeDst);
      console.log(`Copied native binary: copilot${ext}`);
    } catch (copyErr) {
      if (copyErr.code === 'EBUSY' || copyErr.code === 'EPERM') {
        console.warn(`Native binary is locked (Obsidian is running) — skipping copy. Existing binary will be used.`);
      } else {
        throw copyErr;
      }
    }
  } else {
    console.warn(`Native binary not found at ${nativeSrc} — plugin will rely on system PATH.`);
  }
}

function tryReloadPlugin() {
  const isWindows = process.platform === "win32";
  
  // Try to reload plugin via CLI if available
  // (Gracefully fails if Obsidian CLI is not installed)
  try {
    const result = spawnSync("obsidian", ["plugin:reload", `id=${PLUGIN_ID}`], {
      stdio: "pipe",
      cwd: SCRIPT_DIR,
      shell: false,
      timeout: 5000,
    });

    if (result.status === 0) {
      console.log("Plugin reloaded");
    }
  } catch {
    // Obsidian CLI not available, skip reload
  }
}

function printHelp() {
  console.log("Usage: node deploy-local.mjs [--vault <path>]");
  console.log("");
  console.log("Options:");
  console.log("  --vault, -v   Obsidian vault path (skips interactive prompt)");
  console.log("  --help,  -h   Show this help message");
}

async function main() {
  // Suppress Node deprecation warnings about shell argument passing
  // (all inputs are controlled, no security risk)
  const originalWarning = process.emitWarning;
  process.emitWarning = function(warning, ...args) {
    if (String(warning).includes("DEP0190")) return;
    return originalWarning.call(process, warning, ...args);
  };

  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printHelp();
    return;
  }

  const vaultPath = await resolveVaultPath(args.vault);

  if (!vaultPath || !(await validateVaultPath(vaultPath))) {
    console.error(`'${vaultPath}' is not a valid Obsidian vault (missing .obsidian directory).`);
    if (existsSync(CONFIG_FILE)) {
      rmSync(CONFIG_FILE, { force: true });
    }
    process.exit(1);
  }

  saveVaultPathIfChanged(vaultPath);

  const pluginDir = path.join(vaultPath, ".obsidian", "plugins", PLUGIN_ID);
  runBuild();
  copyArtifacts(pluginDir);

  console.log(`Deployed to ${pluginDir}`);
  tryReloadPlugin();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
