#!/usr/bin/env node
import { Cli, Builtins } from 'clipanion';
import { RefinerStatsCommand } from './commands/stats/RefinerStats.command.js';
import { ConfigGetCommand } from './commands/config/ConfigGet.command.js';
import { ConfigSetCommand } from './commands/config/ConfigSet.command.js';
import { ConfigInitCommand } from './commands/config/ConfigInit.command.js';
import chalk from 'chalk';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// Read version from package.json dynamically
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageJson = JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf-8'));

const [node, script, ...args] = process.argv;

// Show alpha warning for actual commands (not help, version, or empty)
if (args.length > 0 && 
    !args.includes('--help') && !args.includes('-h') &&
    !args.includes('--version') && !args.includes('-v')) {
  console.error(chalk.yellow('⚠️  ALPHA SOFTWARE - Use only for testing/development'));
  console.error(chalk.gray('   Not suitable for production use. Features may change without notice.\n'));
}

const cli = new Cli({
  binaryLabel: 'Vana CLI (Alpha)',
  binaryName: 'vana',
  binaryVersion: packageJson.version
});

// Register built-in commands (help, version)
cli.register(Builtins.HelpCommand);
cli.register(Builtins.VersionCommand);

// Register config commands
cli.register(ConfigGetCommand);
cli.register(ConfigSetCommand);
cli.register(ConfigInitCommand);

// Register stats commands
cli.register(RefinerStatsCommand);

await cli.runExit(args, { stdin: process.stdin, stdout: process.stdout });
