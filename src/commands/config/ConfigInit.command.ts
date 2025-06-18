import { Command, Option } from 'clipanion';
import { ConfigManager } from '../../sdk/config/config-manager.js';
import { createMessageHandler, ErrorMessages, SuccessMessages, WarningMessages, InfoMessages } from '../../utils/messaging.js';
import { formatTitle, Output } from '../../utils/formatting.js';
import ora from 'ora';

/**
 * Command to initialize configuration with defaults
 * 
 * Usage:
 *   vana config init                 # Initialize with defaults
 *   vana config init --reset         # Reset to defaults
 */
export class ConfigInitCommand extends Command {
  static paths = [['config', 'init']];

  static usage = Command.Usage({
    category: 'Configuration',
    description: 'Initialize configuration with defaults',
    details: `
      Initialize the Vana CLI configuration with default values.
      
      Default configuration:
        - network: moksha
        - rpc_endpoint: https://rpc.moksha.vana.org
      
      This creates ~/.vana/cli.config.toml with the default settings.
      Protected values (like private keys) are not set by init.

      Examples:
        $ vana config init               # Initialize with defaults
        $ vana config init --reset       # Reset existing config to defaults
    `
  });

  reset = Option.Boolean('--reset', false, {
    description: 'Reset existing configuration to defaults'
  });

  quiet = Option.Boolean('--quiet', false, {
    description: 'Suppress output messages'
  });

  async execute(): Promise<number> {
    const msg = createMessageHandler(this.context);
    
    try {
      const configManager = ConfigManager.getInstance();
      
      if (this.reset) {
        const spinner = ora('Resetting configuration to defaults...').start();
        
        try {
          await configManager.reset();
          spinner.succeed();
          
          if (!this.quiet) {
            msg.success(SuccessMessages.configReset());
            msg.warning(WarningMessages.secretsCleared());
          }
        } catch (error) {
          spinner.fail();
          throw error;
        }
      } else {
        const spinner = ora('Initializing configuration...').start();
        
        try {
          await configManager.initialize();
          spinner.succeed();
          
          if (!this.quiet) {
            msg.success(SuccessMessages.configInitialized());
            msg.warning('⚠️  This is alpha software - only use for testing/development');
          }
        } catch (error) {
          spinner.fail();
          throw error;
        }
      }

      if (!this.quiet) {
        // Show the current configuration
        const config = await configManager.getUnprotectedConfig();
        
        msg.write('\n' + formatTitle('Current Configuration') + '\n');
        
        const configRecord: Record<string, string | undefined> = {
          network: config.network,
          rpc_endpoint: config.rpc_endpoint
        };
        
        msg.write(Output.configSection(
          'Configuration',
          'unprotected values',
          configRecord,
          { maskSensitive: false, showEmpty: true }
        ));
        
        msg.info(InfoMessages.configLocation(configManager.getConfigPath()));
        
        msg.write(Output.nextSteps([
          InfoMessages.nextSteps.setPrivateKey(),
          InfoMessages.nextSteps.viewConfig(),
          InfoMessages.nextSteps.viewSecrets()
        ]));
      }

      return 0;
    } catch (error) {
      msg.error(ErrorMessages.unexpectedError(error));
      return 1;
    }
  }
} 