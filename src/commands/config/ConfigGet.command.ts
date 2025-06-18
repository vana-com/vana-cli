import { Command, Option } from 'clipanion';
import { ConfigManager } from '../../sdk/config/config-manager.js';
import { createMessageHandler, ErrorMessages, InfoMessages } from '../../utils/messaging.js';
import { formatTitle, Output, maskSensitiveValue, isSensitiveKey } from '../../utils/formatting.js';

/**
 * Command to get configuration values
 * 
 * Usage:
 *   vana config get [key]           # Get specific key or all keys
 *   vana config get --secrets       # Include protected values
 *   vana config get --json          # Output as JSON
 */
export class ConfigGetCommand extends Command {
  static paths = [['config', 'get']];

  static usage = Command.Usage({
    category: 'Configuration',
    description: 'Get configuration values',
    details: `
      Get configuration values from the Vana CLI config.
      
      By default, only unprotected values are shown.
      Use --secrets to include protected values from the keyring.

      Examples:
        $ vana config get                    # Show all unprotected config
        $ vana config get network           # Show specific key
        $ vana config get --secrets         # Show all config including secrets
        $ vana config get --json            # Output as JSON
    `
  });

  key = Option.String({ required: false });

  secrets = Option.Boolean('--secrets', false, {
    description: 'Include protected values from keyring'
  });

  json = Option.Boolean('--json', false, {
    description: 'Output as JSON'
  });

  async execute(): Promise<number> {
    const msg = createMessageHandler(this.context);
    
    try {
      const configManager = ConfigManager.getInstance();
      await configManager.initialize();

      if (this.key) {
        // Get specific key
        const value = await configManager.getConfigValue(this.key as any);
        
        if (value === undefined) {
          msg.error(ErrorMessages.configNotFound(this.key));
          return 1;
        }

        if (this.json) {
          // For JSON output, mask sensitive values if not showing secrets
          const outputValue = !this.secrets && isSensitiveKey(this.key) 
            ? maskSensitiveValue(this.key, value)
            : value;
          msg.write(JSON.stringify({ [this.key]: outputValue }, null, 2) + '\n');
        } else {
          // For regular output, always mask sensitive values unless --secrets is used
          const displayValue = !this.secrets && isSensitiveKey(this.key)
            ? maskSensitiveValue(this.key, value)
            : value;
          msg.log(`${this.key}: ${displayValue}`);
        }
      } else {
        // Get all configuration
        let config: any;
        
        if (this.secrets) {
          config = await configManager.getConfig();
        } else {
          config = await configManager.getUnprotectedConfig();
        }

        if (this.json) {
          // For JSON, mask sensitive values if not showing secrets
          const outputConfig = { ...config };
          if (!this.secrets) {
            for (const [key, value] of Object.entries(outputConfig)) {
              if (typeof value === 'string' && isSensitiveKey(key)) {
                outputConfig[key] = maskSensitiveValue(key, value);
              }
            }
          }
          msg.write(JSON.stringify(outputConfig, null, 2) + '\n');
        } else {
          this.displayConfig(config, msg, configManager);
        }
      }

      return 0;
    } catch (error) {
      msg.error(ErrorMessages.unexpectedError(error));
      return 1;
    }
  }

  /**
   * Display configuration in a formatted way
   */
  private displayConfig(config: Record<string, any>, msg: ReturnType<typeof createMessageHandler>, configManager: ConfigManager): void {
    msg.write(formatTitle('Vana CLI Configuration') + '\n');

    const keys = configManager.getConfigKeys();

    // Build unprotected config object
    const unprotectedConfig: Record<string, string | undefined> = {};
    for (const key of keys.unprotected) {
      unprotectedConfig[key] = config[key];
    }

    // Display unprotected config
    msg.write(Output.configSection(
      'Unprotected',
      'stored in ~/.vana/cli.config.toml',
      unprotectedConfig,
      { maskSensitive: false, showEmpty: false }
    ));

    // Display protected config if secrets flag is used
    if (this.secrets) {
      const protectedConfig: Record<string, string | undefined> = {};
      for (const key of keys.protected) {
        protectedConfig[key] = config[key];
      }

      msg.write(Output.configSection(
        'Protected',
        'stored in OS keyring',
        protectedConfig,
        { maskSensitive: true, showEmpty: true }
      ));
    } else {
      msg.info(InfoMessages.useSecretsFlag());
    }

    msg.info(InfoMessages.configLocation(configManager.getConfigPath()));
  }
} 