import { Command, Option } from 'clipanion';
import { QueryEngineClient } from '../../sdk/query/query-engine-client.js';
import { ConfigManager } from '../../sdk/config/config-manager.js';
import { formatTitle, formatConfigPair, maskSensitiveValue, Output } from '../../utils/formatting.js';
import { createMessageHandler, ErrorMessages, SuccessMessages, InfoMessages } from '../../utils/messaging.js';
import ora from 'ora';

// Constants
const TROUBLESHOOTING_STEPS = [
  'Verify the refiner ID exists',
  'Check your private key is correct',
  'Ensure the API URL is accessible',
  'Verify you have permission to view this refiner\'s stats'
];

/**
 * Command to get ingestion statistics for a specific refiner
 * 
 * Usage:
 *   vana stats refiner --id 45                    # Get basic stats
 *   vana stats refiner --id 45 --json             # JSON output
 *   vana stats refiner --id 45 --verbose          # Verbose output
 *   vana stats refiner --id 45 --include-raw      # Include raw response
 */
export class RefinerStatsCommand extends Command {
  static paths = [['stats', 'refiner']];

  static usage = Command.Usage({
    category: 'Stats',
    description: 'Get ingestion statistics for a specific refiner',
    details: `
      Retrieves comprehensive ingestion statistics for a refiner including:
      • File contributions and data rows
      • Query execution metrics
      • Error breakdowns by type
      • Table-specific row counts
      • Contributor and timing information
      
      Requires cryptographic authentication using your wallet private key.
    `,
    examples: [
      ['Get stats for refiner ID 45', 'vana stats refiner --id 45 --endpoint https://query-engine.api.com'],
      ['Get stats with private key override', 'vana stats refiner --id 45 --private-key 63... --endpoint https://query-engine.api.com'],
      ['Get stats in JSON format', 'vana stats refiner --id 45 --endpoint https://query-engine.api.com --json'],
      ['Get verbose stats with raw response', 'vana stats refiner --id 45 --endpoint https://query-engine.api.com --verbose --include-raw']
    ]
  });

  refinerId = Option.String('--id,-i', {
    description: 'Refiner ID to get statistics for',
    required: true
  });

  privateKey = Option.String('--private-key,-pk', {
    description: 'Private key for authentication (overrides config)'
  });

  endpoint = Option.String('--endpoint,-e', {
    description: 'Query Engine API URL (required - stats come from Query Engine, not RPC)'
  });

  json = Option.Boolean('--json,-j', false, {
    description: 'Output in JSON format'
  });

  verbose = Option.Boolean('--verbose,-v', false, {
    description: 'Show verbose output with additional details'
  });

  includeRaw = Option.Boolean('--include-raw', false, {
    description: 'Include raw API response in output'
  });

  async execute(): Promise<number> {
    const msg = createMessageHandler(this.context);
    
    try {
      // Validate and parse inputs
      const refinerIdNum = this.validateRefinerId(msg);
      if (refinerIdNum === null) return 1;

      // Get configuration and credentials
      const { privateKey, apiUrl } = await this.getConfiguration(msg);
      if (!privateKey || !apiUrl) return 1;

      // Show verbose info if requested
      if (this.verbose) {
        this.displayVerboseInfo(msg, refinerIdNum, apiUrl, privateKey);
      }

      // Fetch stats from API
      const stats = await this.fetchRefinerStats(msg, refinerIdNum, apiUrl, privateKey);
      if (!stats) {
        msg.write(Output.troubleshooting('Troubleshooting', TROUBLESHOOTING_STEPS));
        return 1;
      }

      // Display results
      this.displayResults(msg, stats);

      msg.success(SuccessMessages.operationComplete('Refiner stats retrieved'));
      
      if (this.verbose) {
        msg.warning('⚠️  Alpha software: Verify all data independently before making decisions');
      }
      
      return 0;

    } catch (error) {
      msg.error(ErrorMessages.unexpectedError(error));
      msg.write(Output.troubleshooting('Troubleshooting', TROUBLESHOOTING_STEPS));
      return 1;
    }
  }

  /**
   * Validate and parse the refiner ID
   */
  private validateRefinerId(msg: ReturnType<typeof createMessageHandler>): number | null {
    const refinerIdNum = parseInt(this.refinerId);
    if (isNaN(refinerIdNum) || refinerIdNum < 0) {
      msg.error('Invalid refiner ID. Must be a non-negative number.');
      return null;
    }
    return refinerIdNum;
  }

  /**
   * Get configuration values (private key and API URL)
   */
  private async getConfiguration(msg: ReturnType<typeof createMessageHandler>): Promise<{ privateKey: string | null, apiUrl: string | null }> {
    const configManager = ConfigManager.getInstance();
    await configManager.initialize();

    // Get private key (from option or config)
    let privateKey = this.privateKey;
    if (!privateKey) {
      try {
        privateKey = await configManager.getConfigValue('wallet_private_key');
      } catch (error) {
        // Config value not found
      }
    }

    if (!privateKey) {
      msg.error('No private key provided.');
      msg.write(Output.examples('Set private key with', [
        'vana config set wallet_private_key 63...',
        'or use --private-key option'
      ]));
      return { privateKey: null, apiUrl: null };
    }

    // Get Query Engine API URL (from option only - no config fallback)
    let apiUrl = this.endpoint;

    if (!apiUrl) {
      msg.error('Query Engine API URL is required for refiner stats.');
      msg.info('Refiner stats are retrieved from the Query Engine API, not on-chain RPC.');
      msg.write(Output.examples('Provide Query Engine API URL with', [
        'vana stats refiner --id 45 --endpoint https://query-engine.api.com'
      ]));
      return { privateKey: null, apiUrl: null };
    }

    return { privateKey, apiUrl };
  }

  /**
   * Display verbose configuration information
   */
  private displayVerboseInfo(
    msg: ReturnType<typeof createMessageHandler>, 
    refinerIdNum: number, 
    apiUrl: string, 
    privateKey: string
  ): void {
    msg.write(formatTitle('🔍 Refiner Ingestion Stats') + '\n');
    msg.write(formatConfigPair('Refiner ID', refinerIdNum.toString()) + '\n');
    msg.write(formatConfigPair('API URL', apiUrl) + '\n');
    msg.write(formatConfigPair('Private Key', maskSensitiveValue('wallet_private_key', privateKey)) + '\n');
    msg.write('\n');
  }

  /**
   * Fetch refiner stats from the API
   */
  private async fetchRefinerStats(
    msg: ReturnType<typeof createMessageHandler>,
    refinerIdNum: number,
    apiUrl: string,
    privateKey: string
  ): Promise<any | null> {
    const client = new QueryEngineClient(apiUrl);
    const spinner = ora(`Fetching ingestion stats for refiner ${refinerIdNum}...`).start();
    
    try {
      const stats = await client.getRefinerIngestionStats(refinerIdNum, privateKey);
      spinner.succeed();
      return stats;
    } catch (error) {
      spinner.fail();
      msg.error(`Failed to fetch refiner stats: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  /**
   * Display the results based on output format
   */
  private displayResults(msg: ReturnType<typeof createMessageHandler>, stats: any): void {
    if (this.json) {
      msg.write(JSON.stringify(stats, null, 2) + '\n');
    } else {
      this.displayFormattedStats(msg, stats);
    }

    if (this.includeRaw && !this.json) {
      msg.write('\n' + formatTitle('📄 Raw API Response') + '\n');
      msg.write(JSON.stringify(stats, null, 2) + '\n');
    }
  }

  /**
   * Display stats in a formatted, human-readable way
   */
  private displayFormattedStats(msg: ReturnType<typeof createMessageHandler>, stats: any): void {
    // Main header
    msg.write(formatTitle(`📊 Refiner ${stats.refiner_id} - Ingestion Statistics`) + '\n\n');
    
    // Data ingestion section
    this.displayDataIngestionStats(msg, stats);
    
    // Query execution section
    this.displayQueryExecutionStats(msg, stats);
    
    // Query errors breakdown
    this.displayQueryErrorsBreakdown(msg, stats);
    
    // Rows per table
    this.displayRowsPerTable(msg, stats);
    
    // Technical details (verbose only)
    if (this.verbose) {
      this.displayTechnicalDetails(msg, stats);
    }
  }

  /**
   * Display data ingestion statistics
   */
  private displayDataIngestionStats(msg: ReturnType<typeof createMessageHandler>, stats: any): void {
    msg.write(formatTitle('📁 Data Ingestion') + '\n');
    msg.write(formatConfigPair('File Contributions', stats.total_file_contributions.toLocaleString()) + '\n');
    msg.write(formatConfigPair('Total Data Rows', stats.total_data_rows.toLocaleString()) + '\n');
    msg.write(formatConfigPair('Unique Contributors', stats.unique_contributors.toLocaleString()) + '\n');
    
    if (stats.first_ingestion_at) {
      msg.write(formatConfigPair('First Ingestion', new Date(stats.first_ingestion_at).toLocaleString()) + '\n');
    }
    if (stats.last_ingestion_at) {
      msg.write(formatConfigPair('Last Ingestion', new Date(stats.last_ingestion_at).toLocaleString()) + '\n');
    }
    if (stats.ingestion_period_days) {
      msg.write(formatConfigPair('Ingestion Period', `${stats.ingestion_period_days.toFixed(1)} days`) + '\n');
    }
    msg.write(formatConfigPair('Avg Rate/Hour', stats.average_ingestion_rate_per_hour.toFixed(2)) + '\n');
  }

  /**
   * Display query execution statistics
   */
  private displayQueryExecutionStats(msg: ReturnType<typeof createMessageHandler>, stats: any): void {
    msg.write('\n' + formatTitle('🔍 Query Execution') + '\n');
    msg.write(formatConfigPair('Total Queries', stats.total_queries_executed.toLocaleString()) + '\n');
    msg.write(formatConfigPair('Successful', stats.successful_queries.toLocaleString()) + '\n');
    msg.write(formatConfigPair('Failed', stats.failed_queries.toLocaleString()) + '\n');
    
    if (stats.total_queries_executed > 0) {
      const successRate = ((stats.successful_queries / stats.total_queries_executed) * 100).toFixed(1);
      msg.write(formatConfigPair('Success Rate', `${successRate}%`) + '\n');
    }
  }

  /**
   * Display query errors breakdown
   */
  private displayQueryErrorsBreakdown(msg: ReturnType<typeof createMessageHandler>, stats: any): void {
    if (Object.keys(stats.query_errors_by_type).length === 0) return;

    msg.write('\n' + formatTitle('❌ Query Errors by Type') + '\n');
    Object.entries(stats.query_errors_by_type)
      .sort(([,a], [,b]) => (b as number) - (a as number))
      .forEach(([errorType, count]) => {
        msg.write(formatConfigPair(errorType, (count as number).toLocaleString()) + '\n');
      });
  }

  /**
   * Display rows per table breakdown
   */
  private displayRowsPerTable(msg: ReturnType<typeof createMessageHandler>, stats: any): void {
    if (Object.keys(stats.rows_per_table).length === 0) return;

    msg.write('\n' + formatTitle('📋 Rows per Table') + '\n');
    Object.entries(stats.rows_per_table)
      .sort(([,a], [,b]) => (b as number) - (a as number))
      .forEach(([tableName, rowCount]) => {
        msg.write(formatConfigPair(tableName, (rowCount as number).toLocaleString()) + '\n');
      });
  }

  /**
   * Display technical details (verbose mode only)
   */
  private displayTechnicalDetails(msg: ReturnType<typeof createMessageHandler>, stats: any): void {
    msg.write('\n' + formatTitle('🔧 Technical Details') + '\n');
    if (stats.last_processed_block) {
      msg.write(formatConfigPair('Last Processed Block', stats.last_processed_block.toLocaleString()) + '\n');
    }
  }
}
