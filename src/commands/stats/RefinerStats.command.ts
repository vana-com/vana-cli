import { Command, Option } from 'clipanion';
import { QueryEngineClient } from '../../sdk/query/query-engine-client.js';
import { RefinementServiceClient } from '../../sdk/refine/refinement-service-client.js';
import { RefinerIngestionStatsResponse } from '../../sdk/query/dto/refiner-ingestion-stats-response.js';
import { RefinerExecutionStatsResponse } from '../../sdk/refine/dto/refiner-execution-stats-response.js';
import { ConfigManager } from '../../sdk/config/config-manager.js';
import { formatTitle, formatConfigPair, maskSensitiveValue, Output } from '../../utils/formatting.js';
import { createMessageHandler, ErrorMessages, SuccessMessages, InfoMessages } from '../../utils/messaging.js';
import ora from 'ora';

// Constants
const TROUBLESHOOTING_STEPS = [
  'Verify the refiner ID exists',
  'Check your private key is correct',
  'Ensure the API URLs are accessible',
  'Verify you have permission to view this refiner\'s stats'
];

/**
 * Combined stats from both services
 */
interface CombinedRefinerStats {
  refiner_id: number;
  ingestion_stats?: RefinerIngestionStatsResponse;
  execution_stats?: RefinerExecutionStatsResponse;
  ingestion_error?: string;
  execution_error?: string;
}

/**
 * Command to get comprehensive statistics for a specific refiner
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
    description: 'Get comprehensive statistics for a specific refiner',
    details: `
      Retrieves comprehensive statistics for a refiner from both services:
      
      Query Engine Stats:
      • File contributions and data rows
      • Query execution metrics
      • Error breakdowns by type
      • Table-specific row counts
      • Contributor and timing information
      
      Refinement Service Stats:
      • Job processing metrics
      • Success/failure rates
      • Processing times
      • Error analysis
      • Recent activity
      
      Requires cryptographic authentication using your wallet private key.
    `,
    examples: [
      ['Get stats for refiner ID 45', 'vana stats refiner --id 45'],
      ['Get stats with custom endpoints', 'vana stats refiner --id 45 --query-endpoint https://query-engine.api.com --refine-endpoint https://refine.api.com'],
      ['Get stats with private key override', 'vana stats refiner --id 45 --private-key 63...'],
      ['Get stats in JSON format', 'vana stats refiner --id 45 --json'],
      ['Get verbose stats with raw response', 'vana stats refiner --id 45 --verbose --include-raw']
    ]
  });

  refinerId = Option.String('--id,-i', {
    description: 'Refiner ID to get statistics for',
    required: true
  });

  privateKey = Option.String('--private-key,-pk', {
    description: 'Private key for authentication (overrides config)'
  });

  queryEndpoint = Option.String('--query-endpoint,-qe', {
    description: 'Query Engine API URL (optional if configured via config)'
  });

  refineEndpoint = Option.String('--refine-endpoint,-re', {
    description: 'Refinement Service API URL (optional if configured via config)'
  });

  json = Option.Boolean('--json,-j', false, {
    description: 'Output in JSON format'
  });

  verbose = Option.Boolean('--verbose,-v', false, {
    description: 'Show verbose output with additional details'
  });

  includeRaw = Option.Boolean('--include-raw', false, {
    description: 'Include raw API responses in output'
  });

  async execute(): Promise<number> {
    const msg = createMessageHandler(this.context);
    
    try {
      // Validate and parse inputs
      const refinerIdNum = this.validateRefinerId(msg);
      if (refinerIdNum === null) return 1;

      // Get configuration and credentials
      const { privateKey, queryApiUrl, refineApiUrl } = await this.getConfiguration(msg);
      if (!privateKey) return 1;

      // Show verbose info if requested
      if (this.verbose) {
        this.displayVerboseInfo(msg, refinerIdNum, privateKey, queryApiUrl, refineApiUrl);
      }

      // Fetch stats from both services
      const combinedStats = await this.fetchCombinedStats(msg, refinerIdNum, privateKey, queryApiUrl, refineApiUrl);
      
      // Check if we have any data
      if (!combinedStats.ingestion_stats && !combinedStats.execution_stats) {
        msg.warning('No data found for this refiner in either service');
        this.displayNoDataMessage(msg, refinerIdNum, combinedStats);
        return 0;
      }

      // Display results
      this.displayResults(msg, combinedStats);

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
   * Get configuration values (private key and API URLs)
   */
  private async getConfiguration(msg: ReturnType<typeof createMessageHandler>): Promise<{ 
    privateKey?: string, 
    queryApiUrl?: string, 
    refineApiUrl?: string 
  }> {
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
      return { privateKey: undefined, queryApiUrl: undefined, refineApiUrl: undefined };
    }

    // Get Query Engine API URL (from option or config)
    let queryApiUrl = this.queryEndpoint;
    if (!queryApiUrl) {
      try {
        queryApiUrl = await configManager.getConfigValue('query_engine_endpoint');
      } catch (error) {
        // Config value not found
      }
    }

    // Get Refinement Service API URL (from option or config)
    let refineApiUrl = this.refineEndpoint;
    if (!refineApiUrl) {
      try {
        refineApiUrl = await configManager.getConfigValue('refinement_service_endpoint');
      } catch (error) {
        // Config value not found
      }
    }

    // At least one endpoint should be available
    if (!queryApiUrl && !refineApiUrl) {
      msg.error('At least one API endpoint is required (Query Engine or Refinement Service).');
      msg.write(Output.examples('Set API endpoints with', [
        'vana config set query_engine_endpoint https://query-engine.api.com',
        'vana config set refinement_service_endpoint https://refine.api.com',
        'or use --query-endpoint and --refine-endpoint options'
      ]));
      return { privateKey: undefined, queryApiUrl: undefined, refineApiUrl: undefined };
    }

    return { privateKey, queryApiUrl, refineApiUrl };
  }

  /**
   * Display verbose configuration information
   */
  private displayVerboseInfo(
    msg: ReturnType<typeof createMessageHandler>, 
    refinerIdNum: number, 
    privateKey: string,
    queryApiUrl?: string,
    refineApiUrl?: string,
  ): void {
    msg.write(formatTitle('🔍 Comprehensive Refiner Statistics') + '\n');
    msg.write(formatConfigPair('Refiner ID', refinerIdNum.toString()) + '\n');
    msg.write(formatConfigPair('Query Engine API', queryApiUrl || 'Not configured') + '\n');
    msg.write(formatConfigPair('Refinement Service API', refineApiUrl || 'Not configured') + '\n');
    msg.write(formatConfigPair('Private Key', maskSensitiveValue('wallet_private_key', privateKey)) + '\n');
    msg.write('\n');
  }

  /**
   * Fetch stats from both services
   */
  private async fetchCombinedStats(
    msg: ReturnType<typeof createMessageHandler>,
    refinerIdNum: number,
    privateKey: string,
    queryApiUrl?: string,
    refineApiUrl?: string
  ): Promise<CombinedRefinerStats> {
    const results: CombinedRefinerStats = {
      refiner_id: refinerIdNum,
      ingestion_stats: undefined,
      execution_stats: undefined
    };

    // Fetch ingestion stats if query engine URL is available
    if (queryApiUrl) {
      const spinner = ora(`Fetching ingestion stats from query engine...`).start();
      try {
        const queryClient = new QueryEngineClient(queryApiUrl);
        results.ingestion_stats = await queryClient.getRefinerIngestionStats(refinerIdNum, privateKey);
        spinner.succeed('Ingestion stats retrieved');
      } catch (error) {
        spinner.fail('Failed to fetch ingestion stats');
        results.ingestion_error = error instanceof Error ? error.message : String(error);
        msg.warning(`Query Engine: ${results.ingestion_error}`);
      }
    }

    // Fetch execution stats if refinement service URL is available
    if (refineApiUrl) {
      const spinner = ora(`Fetching execution stats from refinement service...`).start();
      try {
        const refineClient = new RefinementServiceClient(refineApiUrl);
        results.execution_stats = await refineClient.getRefinerExecutionStats(refinerIdNum, privateKey);
        spinner.succeed('Execution stats retrieved');
      } catch (error) {
        spinner.fail('Failed to fetch execution stats');
        results.execution_error = error instanceof Error ? error.message : String(error);
        msg.warning(`Refinement Service: ${results.execution_error}`);
      }
    }

    return results;
  }

  /**
   * Display message when no data is found
   */
  private displayNoDataMessage(
    msg: ReturnType<typeof createMessageHandler>,
    refinerIdNum: number,
    combinedStats: CombinedRefinerStats
  ): void {
    msg.write(formatTitle(`📊 Refiner ${refinerIdNum} - No Data Found`) + '\n\n');
    
    msg.write('🔍 Data Availability:\n');
    
    if (combinedStats.ingestion_error) {
      msg.write(`  Query Engine: ❌ ${combinedStats.ingestion_error}\n`);
    } else if (combinedStats.ingestion_stats) {
      msg.write(`  Query Engine: ✅ Connected (no data ingested)\n`);
    } else {
      msg.write(`  Query Engine: ⚪ Not configured\n`);
    }
    
    if (combinedStats.execution_error) {
      msg.write(`  Refinement Service: ❌ ${combinedStats.execution_error}\n`);
    } else if (combinedStats.execution_stats) {
      msg.write(`  Refinement Service: ✅ Connected (no jobs processed)\n`);
    } else {
      msg.write(`  Refinement Service: ⚪ Not configured\n`);
    }
    
    msg.write('\n💡 This could mean:\n');
    msg.write('  • The refiner ID doesn\'t exist\n');
    msg.write('  • The refiner hasn\'t processed any data or jobs yet\n');
    msg.write('  • You don\'t have permission to view this refiner\'s stats\n');
    msg.write('  • One or both services are not configured\n');
  }

  /**
   * Display the results based on output format
   */
  private displayResults(msg: ReturnType<typeof createMessageHandler>, combinedStats: CombinedRefinerStats): void {
    if (this.json) {
      msg.write(JSON.stringify(combinedStats, null, 2) + '\n');
    } else {
      this.displayFormattedStats(msg, combinedStats);
    }

    if (this.includeRaw && !this.json) {
      msg.write('\n' + formatTitle('📄 Raw API Responses') + '\n');
      msg.write(JSON.stringify(combinedStats, null, 2) + '\n');
    }
  }

  /**
   * Display stats in a formatted, human-readable way
   */
  private displayFormattedStats(msg: ReturnType<typeof createMessageHandler>, combinedStats: CombinedRefinerStats): void {
    // Main header
    msg.write(formatTitle(`📊 Refiner ${combinedStats.refiner_id} - Comprehensive Statistics`) + '\n\n');
    
    // Job execution section
    if (combinedStats.execution_stats) {
      this.displayJobExecutionStats(msg, combinedStats.execution_stats);
    } else {
      msg.write('\n' + formatTitle('⚙️  Refiner Execution (Refinement Service)') + '\n');
      msg.write('⚪ No execution data available\n');
      if (combinedStats.execution_error) {
        msg.write(`❌ Error: ${combinedStats.execution_error}\n`);
      }
    }

    // Data ingestion section
    if (combinedStats.ingestion_stats) {
      this.displayDataIngestionStats(msg, combinedStats.ingestion_stats);
    } else {
      msg.write(formatTitle('📁 Data Ingestion') + '\n');
      msg.write('⚪ No ingestion data available\n');
      if (combinedStats.ingestion_error) {
        msg.write(`❌ Error: ${combinedStats.ingestion_error}\n`);
      }
    }
    
    // Query execution section (from ingestion stats)
    if (combinedStats.ingestion_stats) {
      this.displayQueryExecutionStats(msg, combinedStats.ingestion_stats);
    }
    
    // Combined error analysis
    this.displayCombinedErrorAnalysis(msg, combinedStats);
    
    // Technical details (verbose only)
    if (this.verbose) {
      this.displayTechnicalDetails(msg, combinedStats);
    }
  }

  /**
   * Display data ingestion statistics
   */
  private displayDataIngestionStats(msg: ReturnType<typeof createMessageHandler>, stats: RefinerIngestionStatsResponse): void {
    msg.write(formatTitle('📁 Data Ingestion') + '\n');
    
    if (stats.total_file_contributions === 0) {
      msg.write('⚪ No data has been ingested yet\n');
      return;
    }
    
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
    
    // Rows per table
    if (Object.keys(stats.rows_per_table).length > 0) {
      msg.write('\n' + formatTitle('📋 Rows per Table') + '\n');
      Object.entries(stats.rows_per_table)
        .sort(([,a], [,b]) => (b as number) - (a as number))
        .forEach(([tableName, rowCount]) => {
          msg.write(formatConfigPair(tableName, (rowCount as number).toLocaleString()) + '\n');
        });
    }
  }

  /**
   * Display job execution statistics
   */
  private displayJobExecutionStats(msg: ReturnType<typeof createMessageHandler>, stats: RefinerExecutionStatsResponse): void {
    msg.write(formatTitle('⚙️  Refiner Execution (Refinement Service)') + '\n');
    
    if (stats.total_jobs === 0) {
      msg.write('⚪ No jobs have been processed yet\n');
      return;
    }
    
    msg.write(formatConfigPair('Total Jobs', stats.total_jobs.toLocaleString()) + '\n');
    msg.write(formatConfigPair('Successful', stats.successful_jobs.toLocaleString()) + '\n');
    msg.write(formatConfigPair('Failed', stats.failed_jobs.toLocaleString()) + '\n');
    msg.write(formatConfigPair('Currently Processing', stats.processing_jobs.toLocaleString()) + '\n');
    msg.write(formatConfigPair('In Queue', stats.submitted_jobs.toLocaleString()) + '\n');
    
    if (stats.total_jobs > 0) {
      const successRate = (stats.success_rate * 100).toFixed(1);
      msg.write(formatConfigPair('Success Rate', `${successRate}%`) + '\n');
    }
    
    if (stats.average_processing_time_seconds > 0) {
      msg.write(formatConfigPair('Avg Processing Time', `${stats.average_processing_time_seconds.toFixed(1)}s`) + '\n');
    }
    
    if (stats.jobs_per_hour > 0) {
      msg.write(formatConfigPair('Jobs per Hour', stats.jobs_per_hour.toFixed(2)) + '\n');
    }
    
    if (stats.first_job_at) {
      msg.write(formatConfigPair('First Job', new Date(stats.first_job_at).toLocaleString()) + '\n');
    }
    if (stats.last_job_at) {
      msg.write(formatConfigPair('Last Job', new Date(stats.last_job_at).toLocaleString()) + '\n');
    }
    if (stats.processing_period_days) {
      msg.write(formatConfigPair('Processing Period', `${stats.processing_period_days.toFixed(1)} days`) + '\n');
    }
    msg.write('\n');
  }

  /**
   * Display query execution statistics
   */
  private displayQueryExecutionStats(msg: ReturnType<typeof createMessageHandler>, stats: RefinerIngestionStatsResponse): void {
    if (stats.total_queries_executed === 0) {
      return; // Skip if no queries
    }
    
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
   * Display combined error analysis
   */
  private displayCombinedErrorAnalysis(msg: ReturnType<typeof createMessageHandler>, combinedStats: CombinedRefinerStats): void {
    const hasQueryErrors = combinedStats.ingestion_stats && Object.keys(combinedStats.ingestion_stats.query_errors_by_type).length > 0;
    const hasExecutionErrors = combinedStats.execution_stats && Object.keys(combinedStats.execution_stats.error_types).length > 0;
    
    if (!hasQueryErrors && !hasExecutionErrors) {
      return; // No errors to display
    }
    
    msg.write('\n' + formatTitle('❌ Error Analysis') + '\n');
    
    if (hasQueryErrors) {
      msg.write('Query Errors:\n');
      Object.entries(combinedStats.ingestion_stats!.query_errors_by_type)
        .sort(([,a], [,b]) => (b as number) - (a as number))
        .forEach(([errorType, count]) => {
          msg.write(`  ${formatConfigPair(errorType, (count as number).toLocaleString())}\n`);
        });
    }
    
    if (hasExecutionErrors) {
      msg.write('Execution Errors:\n');
      Object.entries(combinedStats.execution_stats!.error_types)
        .sort(([,a], [,b]) => (b as number) - (a as number))
        .forEach(([errorType, count]) => {
          msg.write(`  ${formatConfigPair(errorType, (count as number).toLocaleString())}\n`);
        });
    }
    
    // Recent errors from execution stats
    if (combinedStats.execution_stats && combinedStats.execution_stats.recent_errors.length > 0) {
      msg.write('\nRecent Execution Errors:\n');
      combinedStats.execution_stats.recent_errors.slice(0, 3).forEach((error, index) => {
        msg.write(`  ${index + 1}. ${error.error}\n`);
        msg.write(`     ${new Date(error.timestamp).toLocaleString()}\n`);
        if (error.job_id) {
          msg.write(`     Job ID: ${error.job_id}\n`);
        }
      });
    }
  }

  /**
   * Display technical details (verbose mode only)
   */
  private displayTechnicalDetails(msg: ReturnType<typeof createMessageHandler>, combinedStats: CombinedRefinerStats): void {
    msg.write('\n' + formatTitle('🔧 Technical Details') + '\n');
    
    if (combinedStats.ingestion_stats?.last_processed_block) {
      msg.write(formatConfigPair('Last Processed Block', combinedStats.ingestion_stats.last_processed_block.toLocaleString()) + '\n');
    }
    
    if (combinedStats.execution_stats) {
      msg.write(formatConfigPair('Service Status', 'Connected') + '\n');
    }
    
    if (combinedStats.ingestion_stats) {
      msg.write(formatConfigPair('Query Engine Status', 'Connected') + '\n');
    }
  }
}
