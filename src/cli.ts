#!/usr/bin/env node
import { Cli } from 'clipanion';
import { RefinerStatsCommand } from './commands/stats/RefinerStats.command.js';
import { ConfigGetCommand } from './commands/config/ConfigGet.command.js';
import { ConfigSetCommand } from './commands/config/ConfigSet.command.js';
import { ConfigInitCommand } from './commands/config/ConfigInit.command.js';

const [node, script, ...args] = process.argv;

const cli = new Cli({
  binaryLabel: 'Vana CLI',
  binaryName: 'vana',
  binaryVersion: '0.1.0'
});

// Register config commands
cli.register(ConfigGetCommand);
cli.register(ConfigSetCommand);
cli.register(ConfigInitCommand);

// Register stats commands
cli.register(RefinerStatsCommand);

await cli.runExit(args, { stdin: process.stdin, stdout: process.stdout });
