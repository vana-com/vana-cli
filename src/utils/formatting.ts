import chalk from 'chalk';

/**
 * Centralized formatting utilities for consistent CLI output
 */

/**
 * Mask sensitive values for display
 */
export function maskSensitiveValue(key: string, value: string): string {
  if (key === 'wallet_private_key' && value) {
    // Show first 6 chars (including 0x) and last 4 chars
    if (value.length > 10) {
      return value.substring(0, 6) + '...' + value.substring(value.length - 4);
    }
    // For shorter values, just show first 4 and last 2
    return value.substring(0, 4) + '...' + value.substring(value.length - 2);
  }
  return value;
}

/**
 * Check if a key contains sensitive data
 */
export function isSensitiveKey(key: string): boolean {
  const sensitiveKeys = ['wallet_private_key', 'private_key', 'secret', 'password', 'token'];
  return sensitiveKeys.some(sensitiveKey => key.toLowerCase().includes(sensitiveKey));
}

/**
 * Format configuration key-value pair for display
 */
export function formatConfigPair(key: string, value: string | undefined, options: {
  maskSensitive?: boolean;
  indent?: number;
} = {}): string {
  const { maskSensitive = false, indent = 2 } = options;
  const indentStr = ' '.repeat(indent);
  
  if (value === undefined) {
    return `${indentStr}${chalk.cyan(key)}: ${chalk.gray('(not set)')}`;
  }
  
  const displayValue = maskSensitive && isSensitiveKey(key) 
    ? maskSensitiveValue(key, value)
    : value;
    
  return `${indentStr}${chalk.cyan(key)}: ${displayValue}`;
}

/**
 * Format section header
 */
export function formatSectionHeader(title: string, description?: string): string {
  let output = chalk.blue.bold(`\n${title}:`);
  if (description) {
    output += chalk.gray(` (${description})`);
  }
  return output;
}

/**
 * Format main title with separator
 */
export function formatTitle(title: string): string {
  return chalk.bold(title) + '\n' + '─'.repeat(Math.min(title.length, 50));
}

/**
 * Format success message
 */
export function formatSuccess(message: string): string {
  return chalk.green(`✓ ${message}`);
}

/**
 * Format error message
 */
export function formatError(message: string): string {
  return chalk.red(`✗ ${message}`);
}

/**
 * Format warning message
 */
export function formatWarning(message: string): string {
  return chalk.yellow(`⚠ ${message}`);
}

/**
 * Format info message
 */
export function formatInfo(message: string): string {
  return chalk.blue(`ℹ ${message}`);
}

/**
 * Format help text
 */
export function formatHelp(message: string): string {
  return chalk.gray(message);
}

/**
 * Format command example
 */
export function formatExample(command: string): string {
  return chalk.gray(`  $ ${command}`);
}

/**
 * Common output patterns
 */
export const Output = {
  /**
   * Display key-value configuration
   */
  configSection(title: string, description: string, items: Record<string, string | undefined>, options: {
    maskSensitive?: boolean;
    showEmpty?: boolean;
  } = {}) {
    const { maskSensitive = false, showEmpty = true } = options;
    
    let output = formatSectionHeader(title, description) + '\n';
    
    for (const [key, value] of Object.entries(items)) {
      if (value !== undefined || showEmpty) {
        output += formatConfigPair(key, value, { maskSensitive }) + '\n';
      }
    }
    
    return output;
  },

  /**
   * Display a list of examples
   */
  examples(title: string, commands: string[]) {
    let output = formatSectionHeader(title) + '\n';
    for (const command of commands) {
      output += formatExample(command) + '\n';
    }
    return output;
  },

  /**
   * Display next steps
   */
  nextSteps(steps: string[]) {
    let output = formatSectionHeader('Next steps') + '\n';
    for (const step of steps) {
      output += formatHelp(`  • ${step}`) + '\n';
    }
    return output;
  },

  /**
   * Display troubleshooting steps
   */
  troubleshooting(title: string, steps: string[]) {
    let output = formatSectionHeader(title) + '\n';
    for (const step of steps) {
      output += formatHelp(`  • ${step}`) + '\n';
    }
    return output;
  }
}; 