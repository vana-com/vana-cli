import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { RefinerStatsCommand } from '../../src/commands/stats/RefinerStats.command.js';
import { ConfigManager } from '../../src/sdk/config/config-manager.js';
import { QueryEngineClient } from '../../src/sdk/query/query-engine-client.js';
import { RefinementServiceClient } from '../../src/sdk/refine/refinement-service-client.js';
import { RefinerIngestionStatsResponse } from '../../src/sdk/query/dto/refiner-ingestion-stats-response.js';
import { RefinerExecutionStatsResponse } from '../../src/sdk/refine/dto/refiner-execution-stats-response.js';

// Mock external dependencies
vi.mock('../../src/sdk/config/config-manager.js');
vi.mock('../../src/sdk/query/query-engine-client.js');
vi.mock('../../src/sdk/refine/refinement-service-client.js');
vi.mock('ora', () => ({
  default: vi.fn(() => ({
    start: vi.fn().mockReturnThis(),
    succeed: vi.fn().mockReturnThis(),
    fail: vi.fn().mockReturnThis()
  }))
}));

// Mock the formatting utilities with all required functions
vi.mock('../../src/utils/formatting.js', () => ({
  formatTitle: (title: string) => `${title}\n${'─'.repeat(Math.min(title.length, 50))}`,
  formatConfigPair: (key: string, value: string) => `  ${key}: ${value}`,
  maskSensitiveValue: (key: string, value: string) => {
    if (key === 'wallet_private_key' && value.length > 10) {
      return value.substring(0, 6) + '...' + value.substring(value.length - 4);
    }
    return value;
  },
  formatError: (message: string) => `✗ ${message}`,
  formatSuccess: (message: string) => `✓ ${message}`,
  formatWarning: (message: string) => `⚠ ${message}`,
  formatInfo: (message: string) => `ℹ ${message}`,
  Output: {
    examples: (title: string, commands: string[]) => {
      let output = `\n${title}:\n`;
      for (const command of commands) {
        output += `  $ ${command}\n`;
      }
      return output;
    },
    troubleshooting: (title: string, steps: string[]) => {
      let output = `\n${title}:\n`;
      for (const step of steps) {
        output += `  • ${step}\n`;
      }
      return output;
    }
  }
}));

// Mock the messaging utilities
vi.mock('../../src/utils/messaging.js', () => ({
  createMessageHandler: vi.fn(() => ({
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
    log: vi.fn(),
    write: vi.fn()
  })),
  ErrorMessages: {
    unexpectedError: (error: unknown) => `Unexpected error: ${error instanceof Error ? error.message : String(error)}`
  },
  SuccessMessages: {
    operationComplete: (operation: string) => `${operation} completed successfully`
  },
  InfoMessages: {
    refinerStatsApiNote: () => 'Refiner stats are retrieved from the Query Engine API, not on-chain RPC.'
  }
}));

describe('RefinerStatsCommand', () => {
  let command: RefinerStatsCommand;
  let mockConfigManager: any;
  let mockQueryClient: any;
  let mockRefinementClient: any;
  let mockMessageHandler: any;

  const mockIngestionStatsResponse: RefinerIngestionStatsResponse = {
    refiner_id: 45,
    total_file_contributions: 234,
    total_data_rows: 15420,
    first_ingestion_at: "2024-01-15T10:30:00Z",
    last_ingestion_at: "2024-01-20T14:45:00Z",
    total_queries_executed: 87,
    successful_queries: 82,
    failed_queries: 5,
    query_errors_by_type: {
      "SQL_VALIDATION_ERROR": 3,
      "PERMISSION_ERROR": 2
    },
    average_ingestion_rate_per_hour: 2.1,
    ingestion_period_days: 5.18,
    unique_contributors: 234,
    rows_per_table: {
      "users": 5420,
      "posts": 8000,
      "comments": 2000
    },
    last_processed_block: 2945678
  };

  const mockExecutionStatsResponse: RefinerExecutionStatsResponse = {
    refiner_id: 45,
    total_jobs: 150,
    successful_jobs: 142,
    failed_jobs: 8,
    processing_jobs: 0,
    submitted_jobs: 2,
    first_job_at: "2024-01-10T08:00:00Z",
    last_job_at: "2024-01-25T16:30:00Z",
    average_processing_time_seconds: 45.2,
    success_rate: 0.947,
    jobs_per_hour: 4.1,
    processing_period_days: 15.35,
    error_types: {
      "CONTAINER_EXECUTION_ERROR": 5,
      "FILE_DOWNLOAD_FAILED": 3
    },
    recent_errors: [
      {
        error: "Container execution failed",
        timestamp: "2024-01-25T15:00:00Z",
        job_id: "job_123"
      },
      {
        error: "File download timeout",
        timestamp: "2024-01-25T14:30:00Z",
        job_id: "job_124"
      }
    ]
  };

  beforeEach(async () => {
    // Reset mocks
    vi.clearAllMocks();
    
    // Setup ConfigManager mock
    mockConfigManager = {
      initialize: vi.fn(),
      getConfig: vi.fn(),
      getConfigValue: vi.fn()
    };
    vi.mocked(ConfigManager.getInstance).mockReturnValue(mockConfigManager);

    // Setup QueryEngineClient mock
    mockQueryClient = {
      getRefinerIngestionStats: vi.fn()
    };
    vi.mocked(QueryEngineClient).mockImplementation(() => mockQueryClient);

    // Setup RefinementServiceClient mock
    mockRefinementClient = {
      getRefinerExecutionStats: vi.fn()
    };
    vi.mocked(RefinementServiceClient).mockImplementation(() => mockRefinementClient);

    // Setup message handler mock
    mockMessageHandler = {
      success: vi.fn(),
      error: vi.fn(),
      warning: vi.fn(),
      info: vi.fn(),
      log: vi.fn(),
      write: vi.fn()
    };
    
    const { createMessageHandler } = await import('../../src/utils/messaging.js');
    vi.mocked(createMessageHandler).mockReturnValue(mockMessageHandler);

    // Create command instance with mock context
    command = new RefinerStatsCommand();
    command.context = {
      stdout: { write: vi.fn() },
      stderr: { write: vi.fn() }
    } as any;
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe('Parameter Validation', () => {
    it('should reject invalid refiner ID', async () => {
      // Directly set the property to simulate Clipanion parsing
      Object.defineProperty(command, 'refinerId', { value: 'invalid', writable: true });
      
      const result = await command.execute();
      
      expect(result).toBe(1);
      expect(mockMessageHandler.error).toHaveBeenCalledWith('Invalid refiner ID. Must be a non-negative number.');
    });

    it('should reject negative refiner ID', async () => {
      Object.defineProperty(command, 'refinerId', { value: '-1', writable: true });
      
      const result = await command.execute();
      
      expect(result).toBe(1);
      expect(mockMessageHandler.error).toHaveBeenCalledWith('Invalid refiner ID. Must be a non-negative number.');
    });
  });

  describe('Configuration Integration', () => {
    it('should use private key from config when not provided', async () => {
      Object.defineProperty(command, 'refinerId', { value: '45', writable: true });
      Object.defineProperty(command, 'queryEndpoint', { value: 'https://query.api.com', writable: true });
      Object.defineProperty(command, 'refineEndpoint', { value: 'https://refine.api.com', writable: true });
      Object.defineProperty(command, 'privateKey', { value: undefined, writable: true });
      Object.defineProperty(command, 'verbose', { value: false, writable: true });
      Object.defineProperty(command, 'json', { value: false, writable: true });
      Object.defineProperty(command, 'includeRaw', { value: false, writable: true });
      
      mockConfigManager.getConfigValue.mockImplementation((key: string) => {
        if (key === 'wallet_private_key') return Promise.resolve('0xabcdef1234567890');
        return Promise.reject(new Error('Config not found'));
      });
      mockQueryClient.getRefinerIngestionStats.mockResolvedValue(mockIngestionStatsResponse);
      mockRefinementClient.getRefinerExecutionStats.mockResolvedValue(mockExecutionStatsResponse);
      
      const result = await command.execute();
      
      expect(result).toBe(0);
      expect(mockQueryClient.getRefinerIngestionStats).toHaveBeenCalledWith(45, '0xabcdef1234567890');
      expect(mockRefinementClient.getRefinerExecutionStats).toHaveBeenCalledWith(45, '0xabcdef1234567890');
    });

    it('should use configured endpoints when options not provided', async () => {
      Object.defineProperty(command, 'refinerId', { value: '45', writable: true });
      Object.defineProperty(command, 'privateKey', { value: '0x1234567890abcdef', writable: true });
      Object.defineProperty(command, 'queryEndpoint', { value: undefined, writable: true });
      Object.defineProperty(command, 'refineEndpoint', { value: undefined, writable: true });
      Object.defineProperty(command, 'verbose', { value: false, writable: true });
      Object.defineProperty(command, 'json', { value: false, writable: true });
      Object.defineProperty(command, 'includeRaw', { value: false, writable: true });
      
      mockConfigManager.getConfigValue.mockImplementation((key: string) => {
        if (key === 'query_engine_endpoint') return Promise.resolve('https://query-config.api.com');
        if (key === 'refinement_service_endpoint') return Promise.resolve('https://refine-config.api.com');
        return Promise.reject(new Error('Config not found'));
      });
      mockQueryClient.getRefinerIngestionStats.mockResolvedValue(mockIngestionStatsResponse);
      mockRefinementClient.getRefinerExecutionStats.mockResolvedValue(mockExecutionStatsResponse);
      
      const result = await command.execute();
      
      expect(result).toBe(0);
      expect(QueryEngineClient).toHaveBeenCalledWith('https://query-config.api.com');
      expect(RefinementServiceClient).toHaveBeenCalledWith('https://refine-config.api.com');
    });

    it('should work with only query engine endpoint', async () => {
      Object.defineProperty(command, 'refinerId', { value: '45', writable: true });
      Object.defineProperty(command, 'privateKey', { value: '0x1234567890abcdef', writable: true });
      Object.defineProperty(command, 'queryEndpoint', { value: 'https://query.api.com', writable: true });
      Object.defineProperty(command, 'refineEndpoint', { value: undefined, writable: true });
      Object.defineProperty(command, 'verbose', { value: false, writable: true });
      Object.defineProperty(command, 'json', { value: false, writable: true });
      Object.defineProperty(command, 'includeRaw', { value: false, writable: true });
      
      mockConfigManager.getConfigValue.mockRejectedValue(new Error('Config not found'));
      mockQueryClient.getRefinerIngestionStats.mockResolvedValue(mockIngestionStatsResponse);
      
      const result = await command.execute();
      
      expect(result).toBe(0);
      expect(QueryEngineClient).toHaveBeenCalledWith('https://query.api.com');
      expect(RefinementServiceClient).not.toHaveBeenCalled();
    });

    it('should work with only refinement service endpoint', async () => {
      Object.defineProperty(command, 'refinerId', { value: '45', writable: true });
      Object.defineProperty(command, 'privateKey', { value: '0x1234567890abcdef', writable: true });
      Object.defineProperty(command, 'queryEndpoint', { value: undefined, writable: true });
      Object.defineProperty(command, 'refineEndpoint', { value: 'https://refine.api.com', writable: true });
      Object.defineProperty(command, 'verbose', { value: false, writable: true });
      Object.defineProperty(command, 'json', { value: false, writable: true });
      Object.defineProperty(command, 'includeRaw', { value: false, writable: true });
      
      mockConfigManager.getConfigValue.mockRejectedValue(new Error('Config not found'));
      mockRefinementClient.getRefinerExecutionStats.mockResolvedValue(mockExecutionStatsResponse);
      
      const result = await command.execute();
      
      expect(result).toBe(0);
      expect(RefinementServiceClient).toHaveBeenCalledWith('https://refine.api.com');
      expect(QueryEngineClient).not.toHaveBeenCalled();
    });

    it('should fail when no endpoints are provided', async () => {
      Object.defineProperty(command, 'refinerId', { value: '45', writable: true });
      Object.defineProperty(command, 'privateKey', { value: '0x1234567890abcdef', writable: true });
      Object.defineProperty(command, 'queryEndpoint', { value: undefined, writable: true });
      Object.defineProperty(command, 'refineEndpoint', { value: undefined, writable: true });
      
      mockConfigManager.getConfigValue.mockRejectedValue(new Error('Config not found'));
      
      const result = await command.execute();
      
      expect(result).toBe(1);
      expect(mockMessageHandler.error).toHaveBeenCalledWith('At least one API endpoint is required (Query Engine or Refinement Service).');
    });

    it('should fail when no private key is available', async () => {
      Object.defineProperty(command, 'refinerId', { value: '45', writable: true });
      Object.defineProperty(command, 'queryEndpoint', { value: 'https://query.api.com', writable: true });
      Object.defineProperty(command, 'privateKey', { value: undefined, writable: true });
      
      mockConfigManager.getConfigValue.mockRejectedValue(new Error('Config not found'));
      
      const result = await command.execute();
      
      expect(result).toBe(1);
      expect(mockMessageHandler.error).toHaveBeenCalledWith('No private key provided.');
    });
  });

  describe('Combined Stats Functionality', () => {
    beforeEach(() => {
      Object.defineProperty(command, 'refinerId', { value: '45', writable: true });
      Object.defineProperty(command, 'privateKey', { value: '0x1234567890abcdef', writable: true });
      Object.defineProperty(command, 'queryEndpoint', { value: 'https://query.api.com', writable: true });
      Object.defineProperty(command, 'refineEndpoint', { value: 'https://refine.api.com', writable: true });
      Object.defineProperty(command, 'verbose', { value: false, writable: true });
      Object.defineProperty(command, 'json', { value: false, writable: true });
      Object.defineProperty(command, 'includeRaw', { value: false, writable: true });
    });

    it('should successfully fetch both ingestion and execution stats', async () => {
      mockQueryClient.getRefinerIngestionStats.mockResolvedValue(mockIngestionStatsResponse);
      mockRefinementClient.getRefinerExecutionStats.mockResolvedValue(mockExecutionStatsResponse);
      
      const result = await command.execute();
      
      expect(result).toBe(0);
      expect(mockQueryClient.getRefinerIngestionStats).toHaveBeenCalledWith(45, '0x1234567890abcdef');
      expect(mockRefinementClient.getRefinerExecutionStats).toHaveBeenCalledWith(45, '0x1234567890abcdef');
      expect(mockMessageHandler.success).toHaveBeenCalledWith('Refiner stats retrieved completed successfully');
    });

    it('should handle partial failures gracefully', async () => {
      mockQueryClient.getRefinerIngestionStats.mockResolvedValue(mockIngestionStatsResponse);
      mockRefinementClient.getRefinerExecutionStats.mockRejectedValue(new Error('Service unavailable'));
      
      const result = await command.execute();
      
      expect(result).toBe(0);
      expect(mockMessageHandler.warning).toHaveBeenCalledWith('Refinement Service: Service unavailable');
      expect(mockMessageHandler.success).toHaveBeenCalledWith('Refiner stats retrieved completed successfully');
    });

    it('should handle no data from either service', async () => {
      mockQueryClient.getRefinerIngestionStats.mockRejectedValue(new Error('No data found'));
      mockRefinementClient.getRefinerExecutionStats.mockRejectedValue(new Error('No data found'));
      
      const result = await command.execute();
      
      expect(result).toBe(0);
      expect(mockMessageHandler.warning).toHaveBeenCalledWith('No data found for this refiner in either service');
    });
  });

  describe('Output Formats', () => {
    beforeEach(() => {
      Object.defineProperty(command, 'refinerId', { value: '45', writable: true });
      Object.defineProperty(command, 'privateKey', { value: '0x1234567890abcdef', writable: true });
      Object.defineProperty(command, 'queryEndpoint', { value: 'https://query.api.com', writable: true });
      Object.defineProperty(command, 'refineEndpoint', { value: 'https://refine.api.com', writable: true });
      Object.defineProperty(command, 'verbose', { value: false, writable: true });
      Object.defineProperty(command, 'includeRaw', { value: false, writable: true });
      mockQueryClient.getRefinerIngestionStats.mockResolvedValue(mockIngestionStatsResponse);
      mockRefinementClient.getRefinerExecutionStats.mockResolvedValue(mockExecutionStatsResponse);
    });

    it('should output JSON when --json flag is set', async () => {
      Object.defineProperty(command, 'json', { value: true, writable: true });
      
      const result = await command.execute();
      
      expect(result).toBe(0);
      // Check that JSON output is written
      expect(mockMessageHandler.write).toHaveBeenCalledWith(
        expect.stringContaining('"refiner_id": 45')
      );
      expect(mockMessageHandler.write).toHaveBeenCalledWith(
        expect.stringContaining('"ingestion_stats"')
      );
      expect(mockMessageHandler.write).toHaveBeenCalledWith(
        expect.stringContaining('"execution_stats"')
      );
    });

    it('should output formatted content by default', async () => {
      Object.defineProperty(command, 'json', { value: false, writable: true });
      
      const result = await command.execute();
      
      expect(result).toBe(0);
      expect(mockMessageHandler.write).toHaveBeenCalledWith(
        expect.stringContaining('📊 Refiner 45 - Comprehensive Statistics')
      );
      expect(mockMessageHandler.write).toHaveBeenCalledWith(
        expect.stringContaining('⚙️  Refiner Execution (Refinement Service)')
      );
      expect(mockMessageHandler.write).toHaveBeenCalledWith(
        expect.stringContaining('📁 Data Ingestion')
      );
    });

    it('should include raw response when --include-raw flag is set', async () => {
      Object.defineProperty(command, 'includeRaw', { value: true, writable: true });
      Object.defineProperty(command, 'json', { value: false, writable: true });
      
      const result = await command.execute();
      
      expect(result).toBe(0);
      expect(mockMessageHandler.write).toHaveBeenCalledWith(
        expect.stringContaining('📄 Raw API Responses')
      );
    });
  });

  describe('Execution Stats Display', () => {
    it('should display execution stats correctly', async () => {
      Object.defineProperty(command, 'refinerId', { value: '45', writable: true });
      Object.defineProperty(command, 'privateKey', { value: '0x1234567890abcdef', writable: true });
      Object.defineProperty(command, 'refineEndpoint', { value: 'https://refine.api.com', writable: true });
      Object.defineProperty(command, 'verbose', { value: false, writable: true });
      Object.defineProperty(command, 'json', { value: false, writable: true });
      Object.defineProperty(command, 'includeRaw', { value: false, writable: true });
      
      mockRefinementClient.getRefinerExecutionStats.mockResolvedValue(mockExecutionStatsResponse);
      
      const result = await command.execute();
      
      expect(result).toBe(0);
      expect(mockMessageHandler.write).toHaveBeenCalledWith(
        expect.stringContaining('⚙️  Refiner Execution (Refinement Service)')
      );
      expect(mockMessageHandler.write).toHaveBeenCalledWith(
        expect.stringContaining('Total Jobs: 150')
      );
      expect(mockMessageHandler.write).toHaveBeenCalledWith(
        expect.stringContaining('Successful: 142')
      );
      expect(mockMessageHandler.write).toHaveBeenCalledWith(
        expect.stringContaining('Failed: 8')
      );
      expect(mockMessageHandler.write).toHaveBeenCalledWith(
        expect.stringContaining('Success Rate: 94.7%')
      );
    });

    it('should display execution error types', async () => {
      Object.defineProperty(command, 'refinerId', { value: '45', writable: true });
      Object.defineProperty(command, 'privateKey', { value: '0x1234567890abcdef', writable: true });
      Object.defineProperty(command, 'refineEndpoint', { value: 'https://refine.api.com', writable: true });
      Object.defineProperty(command, 'verbose', { value: false, writable: true });
      Object.defineProperty(command, 'json', { value: false, writable: true });
      Object.defineProperty(command, 'includeRaw', { value: false, writable: true });
      
      mockRefinementClient.getRefinerExecutionStats.mockResolvedValue(mockExecutionStatsResponse);
      
      const result = await command.execute();
      
      expect(result).toBe(0);
      expect(mockMessageHandler.write).toHaveBeenCalledWith(
        expect.stringContaining('❌ Error Analysis')
      );
      expect(mockMessageHandler.write).toHaveBeenCalledWith(
        expect.stringContaining('Execution Errors:')
      );
      expect(mockMessageHandler.write).toHaveBeenCalledWith(
        expect.stringContaining('CONTAINER_EXECUTION_ERROR: 5')
      );
      expect(mockMessageHandler.write).toHaveBeenCalledWith(
        expect.stringContaining('FILE_DOWNLOAD_FAILED: 3')
      );
    });

    it('should display recent execution errors', async () => {
      Object.defineProperty(command, 'refinerId', { value: '45', writable: true });
      Object.defineProperty(command, 'privateKey', { value: '0x1234567890abcdef', writable: true });
      Object.defineProperty(command, 'refineEndpoint', { value: 'https://refine.api.com', writable: true });
      Object.defineProperty(command, 'verbose', { value: false, writable: true });
      Object.defineProperty(command, 'json', { value: false, writable: true });
      Object.defineProperty(command, 'includeRaw', { value: false, writable: true });
      
      mockRefinementClient.getRefinerExecutionStats.mockResolvedValue(mockExecutionStatsResponse);
      
      const result = await command.execute();
      
      expect(result).toBe(0);
      expect(mockMessageHandler.write).toHaveBeenCalledWith(
        expect.stringContaining('Recent Execution Errors:')
      );
      expect(mockMessageHandler.write).toHaveBeenCalledWith(
        expect.stringContaining('Container execution failed')
      );
      expect(mockMessageHandler.write).toHaveBeenCalledWith(
        expect.stringContaining('job_123')
      );
    });
  });

  describe('Verbose Mode', () => {
    it('should display verbose information when --verbose flag is set', async () => {
      Object.defineProperty(command, 'refinerId', { value: '45', writable: true });
      Object.defineProperty(command, 'privateKey', { value: '0x1234567890abcdef123456', writable: true });
      Object.defineProperty(command, 'queryEndpoint', { value: 'https://query.api.com', writable: true });
      Object.defineProperty(command, 'refineEndpoint', { value: 'https://refine.api.com', writable: true });
      Object.defineProperty(command, 'verbose', { value: true, writable: true });
      Object.defineProperty(command, 'json', { value: false, writable: true });
      Object.defineProperty(command, 'includeRaw', { value: false, writable: true });
      
      mockQueryClient.getRefinerIngestionStats.mockResolvedValue(mockIngestionStatsResponse);
      mockRefinementClient.getRefinerExecutionStats.mockResolvedValue(mockExecutionStatsResponse);
      
      const result = await command.execute();
      
      expect(result).toBe(0);
      expect(mockMessageHandler.write).toHaveBeenCalledWith(
        expect.stringContaining('🔍 Comprehensive Refiner Statistics')
      );
      expect(mockMessageHandler.write).toHaveBeenCalledWith(
        expect.stringContaining('Refiner ID: 45')
      );
      expect(mockMessageHandler.write).toHaveBeenCalledWith(
        expect.stringContaining('Private Key: 0x1234...3456')
      );
      expect(mockMessageHandler.write).toHaveBeenCalledWith(
        expect.stringContaining('🔧 Technical Details')
      );
    });
  });

  describe('Command Structure', () => {
    it('should have correct command paths', () => {
      expect(RefinerStatsCommand.paths).toEqual([['stats', 'refiner']]);
    });

    it('should have proper usage information', () => {
      expect(RefinerStatsCommand.usage).toBeDefined();
      expect(RefinerStatsCommand.usage.description).toContain('comprehensive statistics');
    });
  });
}); 