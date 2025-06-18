# Vana CLI Development Guide

This guide covers local development workflow for the Vana CLI.

## Development Workflow

### 1. Initial Setup
```bash
# Install dependencies
npm install

# Install keytar native dependencies (if needed)
# On macOS: usually works out of the box
# On Linux: sudo apt-get install libsecret-1-dev
# On Windows: requires Visual Studio Build Tools
```

### 2. Local Development with npm link

The standard way to develop CLI tools locally is using `npm link`:

```bash
# Build and link the CLI globally
npm run dev

# This runs: npm run build && npm link
# Now you can use 'vana' command anywhere in your terminal
```

### 3. Test Your Changes
```bash
# Try the CLI commands
vana config init
vana config get
vana config set network moksha
vana stats refiner --id 45 --endpoint http://localhost:8000
```

### 4. Unlink When Done
```bash
# Remove the global link
npm run unlink

# Or manually
npm unlink -g
```

## Development Commands

| Command | Description |
|---------|-------------|
| `npm run build` | Build TypeScript to JavaScript |
| `npm run dev` | Build and link globally for testing |
| `npm run unlink` | Remove global link |
| `npm test` | Run tests once |
| `npm run test:watch` | Run tests in watch mode |
| `npm run lint` | Lint code |
| `npm run format` | Format code |
| `npm run check` | Run all checks (lint + format) |

## File Structure

```
src/
├── cli.ts                           # Main CLI entry point
├── commands/                        # Command implementations
│   ├── config/
│   │   ├── ConfigGet.command.ts
│   │   ├── ConfigSet.command.ts
│   │   └── ConfigInit.command.ts
│   └── stats/
│       └── RefinerStats.command.ts
├── sdk/                            # Business logic layer
│   ├── config/
│   │   └── config-manager.ts
│   └── query/
│       └── query-engine-client.ts
└── utils/                          # Shared utilities
    ├── formatting.ts               # Output formatting utilities
    └── messaging.ts                # Message handling and error patterns
```

## Adding New Commands

### 1. Create Command File
```typescript
// src/commands/group/NewCommand.command.ts
import { Command, Option } from 'clipanion';
import chalk from 'chalk';

export class NewCommand extends Command {
  static paths = [['group', 'action']];
  
  static usage = Command.Usage({
    category: 'Group',
    description: 'Description of what this command does',
    details: `
      Detailed usage information and examples.
    `
  });

  // Define options
  someOption = Option.String('--option', {
    description: 'Description of the option'
  });

  async execute(): Promise<number> {
    try {
      // Command implementation
      this.context.stdout.write(chalk.green('Success!\n'));
      return 0;
    } catch (error) {
      this.context.stderr.write(chalk.red(`Error: ${error}\n`));
      return 1;
    }
  }
}
```

### 2. Register Command
```typescript
// src/cli.ts
import { NewCommand } from './commands/group/NewCommand.command.js';

cli.register(NewCommand);
```

### 3. Test and Build
```bash
npm run dev
vana group action --option value
```

## Testing

### Unit Tests
```bash
# Run all tests
npm test

# Run tests in watch mode
npm run test:watch

# Run specific test file
npx vitest tests/config/ConfigManager.test.ts
```

### Integration Testing
```bash
# Build and link
npm run dev

# Test commands manually
vana config init
vana config get --secrets
vana stats refiner --help
```

## Debugging

### Enable Debug Logging
```bash
# Set debug environment variable
DEBUG=vana:* vana config get

# Or add debug statements in code
console.log('Debug info:', someVariable);
```

### Common Issues

**Keyring Access Errors**
```bash
# On Linux, install keyring service
sudo apt-get install gnome-keyring

# On macOS, ensure Keychain Access is working
# On Windows, Credential Manager should work automatically
```

**Permission Errors**
```bash
# Fix npm permissions
sudo chown -R $(whoami) ~/.npm
sudo chown -R $(whoami) /usr/local/lib/node_modules
```

**TypeScript Compilation Errors**
```bash
# Clean build
rm -rf dist/
npm run build
```

## Code Style

### Guidelines
- Use ESM imports/exports
- Prefer `async/await` over Promises
- Keep commands under 100 lines
- Add JSDoc comments for public APIs
- Use `chalk` for colored output
- Use `ora` for spinners
- Provide `--json` and `--quiet` flags where appropriate

### Example Command Structure
```typescript
import { Command, Option } from 'clipanion';
import { createMessageHandler, ErrorMessages } from '../../utils/messaging.js';
import { formatTitle, Output } from '../../utils/formatting.js';

export class ExampleCommand extends Command {
  // Static configuration
  static paths = [['group', 'action']];
  static usage = Command.Usage({...});

  // Options
  option1 = Option.String('--option1', {...});
  json = Option.Boolean('--json', false, {...});
  quiet = Option.Boolean('--quiet', false, {...});

  // Implementation
  async execute(): Promise<number> {
    const msg = createMessageHandler(this.context);
    
    try {
      // 1. Validate inputs
      if (!this.option1) {
        msg.error(ErrorMessages.missingRequired('option1'));
        return 1;
      }

      // 2. Call SDK functions
      const result = await someSDKFunction();

      // 3. Format output
      if (this.json) {
        msg.write(JSON.stringify(result, null, 2) + '\n');
      } else {
        msg.success('Operation completed successfully');
        msg.write(Output.configSection('Results', 'data', result));
      }

      // 4. Return 0 for success
      return 0;
    } catch (error) {
      // Handle errors and return 1
      msg.error(ErrorMessages.unexpectedError(error));
      return 1;
    }
  }
}
```

## Centralized Utilities

### Formatting (`src/utils/formatting.ts`)

Provides consistent output formatting across all commands:

```typescript
import { formatTitle, Output, maskSensitiveValue } from '../../utils/formatting.js';

// Format titles with separators
msg.write(formatTitle('Configuration Settings') + '\n');

// Display key-value sections
msg.write(Output.configSection(
  'Database Settings',
  'stored in config file',
  { host: 'localhost', port: '5432', password: 'secret123' },
  { maskSensitive: true, showEmpty: false }
));

// Display examples
msg.write(Output.examples('Usage Examples', [
  'vana config set host localhost',
  'vana config get --secrets'
]));

// Mask sensitive values
const maskedKey = maskSensitiveValue('wallet_private_key', '0x1234567890abcdef...');
// Returns: "0x1234...cdef"
```

### Messaging (`src/utils/messaging.ts`)

Provides consistent messaging and error handling:

```typescript
import { createMessageHandler, ErrorMessages, SuccessMessages } from '../../utils/messaging.js';

const msg = createMessageHandler(this.context);

// Standard message types
msg.success('Configuration saved successfully');
msg.error('Failed to connect to server');
msg.warning('This feature is experimental');
msg.info('Use --help for more information');

// Pre-defined error messages
msg.error(ErrorMessages.configNotFound('network'));
msg.error(ErrorMessages.invalidValue('network', 'invalid', 'vana|moksha'));
msg.error(ErrorMessages.keyringAccess('store'));

// Success messages
msg.success(SuccessMessages.configSet('network', 'config file'));
```

## Publishing

### Pre-publish Checklist
- [ ] All tests pass
- [ ] Code is linted and formatted
- [ ] Version number updated in package.json
- [ ] CHANGELOG.md updated
- [ ] README.md updated

### Publish to npm
```bash
# Build for production
npm run build

# Test the built version
npm pack
npm install -g ./vana-cli-1.0.0.tgz

# Publish to npm
npm publish
```

### Local Testing of Published Package
```bash
# Install from npm
npm install -g vana-cli

# Test commands
vana --help
vana config init
```

## Troubleshooting

### Common Development Issues

**Command not found after npm link**
```bash
# Check if link was created
ls -la $(npm bin -g)/vana

# Re-run link
npm unlink -g && npm run dev
```

**Module resolution errors**
```bash
# Ensure .js extensions in imports
import { Something } from './file.js'; // ✅
import { Something } from './file';    // ❌
```

**Keytar installation issues**
```bash
# Clear npm cache
npm cache clean --force

# Reinstall with rebuild
npm install --rebuild
```

For more help, check the main README.md or open an issue on GitHub. 