import { Command, Option } from 'clipanion';
import { ConfigManager } from '../../sdk/config/config-manager.js';
import { createMessageHandler, ErrorMessages, SuccessMessages, InfoMessages } from '../../utils/messaging.js';
import { formatTitle, Output } from '../../utils/formatting.js';
import ora from 'ora';

/**
 * Command to set configuration values
 * 
 * Usage:
 *   vana config set <key> <value>    # Set a configuration value
 *   vana config set --interactive    # Interactive configuration setup
 */
export class ConfigSetCommand extends Command {
  static paths = [['config', 'set']];

  static usage = Command.Usage({
    category: 'Configuration',
    description: 'Set configuration values',
    details: `
      Set configuration values for the Vana CLI.
      
      Unprotected values are stored in ~/.vana/cli.config.toml
      Protected values (like private keys) are stored securely in the OS keyring.

      Available keys:
        - network (vana|moksha)
        - rpc_endpoint (string)
        - wallet_private_key (string, stored in keyring)

      Examples:
        $ vana config set network moksha
        $ vana config set rpc_endpoint https://rpc.moksha.vana.org
        $ vana config set wallet_private_key 0x1234...
        $ vana config set --interactive
    `
  });

  key = Option.String({ required: false });
  value = Option.String({ required: false });

  interactive = Option.Boolean('--interactive', false, {
    description: 'Interactive configuration setup'
  });

  quiet = Option.Boolean('--quiet', false, {
    description: 'Suppress output messages'
  });

  async execute(): Promise<number> {
    const msg = createMessageHandler(this.context);
    
    try {
      const configManager = ConfigManager.getInstance();
      await configManager.initialize();

      if (this.interactive) {
        return await this.runInteractiveSetup(configManager, msg);
      }

      if (!this.key || !this.value) {
        msg.error(ErrorMessages.missingRequired('key and value'));
        msg.info('Usage: vana config set <key> <value>');
        msg.info('Or use: vana config set --interactive');
        return 1;
      }

      const spinner = ora('Setting configuration...').start();

      try {
        await configManager.setConfig(this.key as any, this.value);
        spinner.succeed();

        if (!this.quiet) {
          const isProtected = this.isProtectedKey(this.key);
          const location = isProtected ? 'OS keyring' : '~/.vana/cli.config.toml';
          msg.success(SuccessMessages.configSet(this.key, location));
        }

        return 0;
      } catch (error) {
        spinner.fail();
        throw error;
      }
    } catch (error) {
      msg.error(ErrorMessages.unexpectedError(error));
      return 1;
    }
  }

  /**
   * Run interactive configuration setup
   */
  private async runInteractiveSetup(configManager: ConfigManager, msg: ReturnType<typeof createMessageHandler>): Promise<number> {
    msg.write(formatTitle('🔧 Vana CLI Interactive Configuration') + '\n\n');

    try {
      // Get current config
      const currentConfig = await configManager.getConfig();

      // Show current configuration
      const unprotectedConfig = {
        network: currentConfig.network,
        rpc_endpoint: currentConfig.rpc_endpoint
      };
      
      const protectedConfig = {
        wallet_private_key: currentConfig.wallet_private_key
      };

      msg.write(Output.configSection(
        'Current Configuration',
        'unprotected values',
        unprotectedConfig,
        { maskSensitive: false, showEmpty: true }
      ));

      msg.write(Output.configSection(
        'Protected Configuration',
        'stored in keyring',
        protectedConfig,
        { maskSensitive: true, showEmpty: true }
      ));

      // For now, we'll just show what would be configured
      // In a real implementation, you'd use a proper prompt library
      msg.warning(InfoMessages.interactiveMode());
      msg.info('Use: vana config set <key> <value> to set individual values');

      msg.write(Output.examples('Example commands', [
        'vana config set network moksha',
        'vana config set rpc_endpoint https://rpc.moksha.vana.org',
        'vana config set wallet_private_key 63...'
      ]));

      return 0;
    } catch (error) {
      msg.error(ErrorMessages.unexpectedError(error));
      return 1;
    }
  }

  /**
   * Check if a key should be stored in the keyring
   */
  private isProtectedKey(key: string): boolean {
    return key === 'wallet_private_key';
  }
} 