import { BaseContext } from 'clipanion';
import { formatError, formatSuccess, formatWarning, formatInfo } from './formatting.js';

/**
 * Centralized messaging utilities for consistent CLI communication
 */

export interface MessageContext {
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
}

/**
 * Message handler for consistent output
 */
export class MessageHandler {
  constructor(private context: MessageContext) {}

  /**
   * Write success message to stdout
   */
  success(message: string): void {
    this.context.stdout.write(formatSuccess(message) + '\n');
  }

  /**
   * Write error message to stderr
   */
  error(message: string): void {
    this.context.stderr.write(formatError(message) + '\n');
  }

  /**
   * Write warning message to stderr
   */
  warning(message: string): void {
    this.context.stderr.write(formatWarning(message) + '\n');
  }

  /**
   * Write info message to stdout
   */
  info(message: string): void {
    this.context.stdout.write(formatInfo(message) + '\n');
  }

  /**
   * Write plain message to stdout
   */
  log(message: string): void {
    this.context.stdout.write(message + '\n');
  }

  /**
   * Write raw content to stdout (no newline)
   */
  write(content: string): void {
    this.context.stdout.write(content);
  }
}

/**
 * Standard error messages with consistent formatting
 */
export const ErrorMessages = {
  configNotFound: (key: string) => `Configuration key '${key}' not found`,
  invalidValue: (key: string, value: string, expected?: string) => 
    `Invalid value '${value}' for '${key}'${expected ? `. Expected: ${expected}` : ''}`,
  missingRequired: (field: string) => `Missing required field: ${field}`,
  keyringAccess: (operation: string) => `Failed to ${operation} keyring. Ensure your system keyring is accessible`,
  fileAccess: (path: string, operation: string) => `Failed to ${operation} file: ${path}`,
  networkError: (endpoint: string) => `Network error connecting to: ${endpoint}`,
  authenticationFailed: (reason?: string) => `Authentication failed${reason ? `: ${reason}` : ''}`,
  permissionDenied: (resource: string) => `Permission denied accessing: ${resource}`,
  unexpectedError: (error: unknown) => `Unexpected error: ${error instanceof Error ? error.message : String(error)}`
};

/**
 * Standard success messages
 */
export const SuccessMessages = {
  configSet: (key: string, location: string) => `Set ${key} in ${location}`,
  configInitialized: () => 'Configuration initialized',
  configReset: () => 'Configuration reset to defaults',
  operationComplete: (operation: string) => `${operation} completed successfully`
};

/**
 * Standard warning messages
 */
export const WarningMessages = {
  secretsCleared: () => 'Protected values (like private keys) have been cleared',
  keyringUnavailable: () => 'OS keyring unavailable, secrets cannot be stored securely',
  deprecatedOption: (old: string, replacement: string) => `Option '${old}' is deprecated, use '${replacement}' instead`,
  experimentalFeature: (feature: string) => `${feature} is experimental and may change in future versions`
};

/**
 * Standard info messages
 */
export const InfoMessages = {
  configLocation: (path: string) => `Config file: ${path}`,
  useSecretsFlag: () => 'Use --secrets to view protected values',
  interactiveMode: () => 'Interactive mode requires a prompt library like inquirer',
  nextSteps: {
    setPrivateKey: () => 'Set your wallet private key: vana config set wallet_private_key 63...',
    viewConfig: () => 'View all settings: vana config get',
    viewSecrets: () => 'View with secrets: vana config get --secrets'
  }
};

/**
 * Helper to create MessageHandler from Clipanion context
 */
export function createMessageHandler(context: BaseContext): MessageHandler {
  return new MessageHandler({
    stdout: context.stdout,
    stderr: context.stderr
  });
}

/**
 * Common error handling patterns
 */
export const ErrorHandlers = {
  /**
   * Handle keyring errors with helpful messages
   */
  keyring: (handler: MessageHandler, operation: string, error: unknown) => {
    handler.error(ErrorMessages.keyringAccess(operation));
    
    if (process.platform === 'linux') {
      handler.info('On Linux, ensure you have a keyring service running:');
      handler.info('  sudo apt-get install gnome-keyring');
    } else if (process.platform === 'win32') {
      handler.info('On Windows, ensure Credential Manager is accessible');
    } else if (process.platform === 'darwin') {
      handler.info('On macOS, ensure Keychain Access is working');
    }
    
    if (error instanceof Error) {
      handler.info(`Details: ${error.message}`);
    }
  },

  /**
   * Handle configuration errors
   */
  config: (handler: MessageHandler, error: unknown) => {
    if (error instanceof Error) {
      if (error.message.includes('Invalid network')) {
        handler.error(error.message);
        handler.info('Valid networks: vana, moksha');
      } else if (error.message.includes('not found')) {
        handler.error(error.message);
        handler.info('Use "vana config get" to see available keys');
      } else {
        handler.error(ErrorMessages.unexpectedError(error));
      }
    } else {
      handler.error(ErrorMessages.unexpectedError(error));
    }
  },

  /**
   * Handle network/API errors
   */
  network: (handler: MessageHandler, endpoint: string, error: unknown) => {
    handler.error(ErrorMessages.networkError(endpoint));
    handler.info('Check your network connection and endpoint URL');
    
    if (error instanceof Error && error.message.includes('ENOTFOUND')) {
      handler.info('DNS resolution failed - verify the hostname');
    } else if (error instanceof Error && error.message.includes('ECONNREFUSED')) {
      handler.info('Connection refused - verify the service is running');
    }
  }
}; 