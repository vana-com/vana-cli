import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { RefinerStatsCommand } from '../../src/commands/stats/RefinerStats.command.js';
import { ConfigManager } from '../../src/sdk/config/config-manager.js';
import { QueryEngineClient } from '../../src/sdk/query/query-engine-client.js';
import { RefinerIngestionStatsResponse } from '../../src/sdk/query/dto/refiner-ingestion-stats-response.js';

// Mock external dependencies
vi.mock('../../src/sdk/config/config-manager.js');
vi.mock('../../src/sdk/query/query-engine-client.js');
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
  }
}));

describe('RefinerStatsCommand', () => {
  let command: RefinerStatsCommand;
  let mockConfigManager: any;
  let mockQueryClient: any;
  let mockMessageHandler: any;

  const mockStatsResponse: RefinerIngestionStatsResponse = {
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
      Object.defineProperty(command, 'endpoint', { value: 'https://api.example.com', writable: true });
      Object.defineProperty(command, 'privateKey', { value: undefined, writable: true });
      Object.defineProperty(command, 'verbose', { value: false, writable: true });
      Object.defineProperty(command, 'json', { value: false, writable: true });
      Object.defineProperty(command, 'includeRaw', { value: false, writable: true });
      
      mockConfigManager.getConfigValue.mockResolvedValue('0xabcdef1234567890');
      mockQueryClient.getRefinerIngestionStats.mockResolvedValue(mockStatsResponse);
      
      const result = await command.execute();
      
      expect(result).toBe(0);
      expect(mockQueryClient.getRefinerIngestionStats).toHaveBeenCalledWith(45, '0xabcdef1234567890');
    });

    it('should use provided endpoint successfully', async () => {
      Object.defineProperty(command, 'refinerId', { value: '45', writable: true });
      Object.defineProperty(command, 'privateKey', { value: '0x1234567890abcdef', writable: true });
      Object.defineProperty(command, 'endpoint', { value: 'https://query-engine.api.com', writable: true });
      Object.defineProperty(command, 'verbose', { value: false, writable: true });
      Object.defineProperty(command, 'json', { value: false, writable: true });
      Object.defineProperty(command, 'includeRaw', { value: false, writable: true });
      
      mockQueryClient.getRefinerIngestionStats.mockResolvedValue(mockStatsResponse);
      
      const result = await command.execute();
      
      expect(result).toBe(0);
      expect(QueryEngineClient).toHaveBeenCalledWith('https://query-engine.api.com');
    });

    it('should fail when no query engine endpoint is provided', async () => {
      Object.defineProperty(command, 'refinerId', { value: '45', writable: true });
      Object.defineProperty(command, 'privateKey', { value: '0x1234567890abcdef', writable: true });
      Object.defineProperty(command, 'endpoint', { value: undefined, writable: true });
      Object.defineProperty(command, 'verbose', { value: false, writable: true });
      Object.defineProperty(command, 'json', { value: false, writable: true });
      Object.defineProperty(command, 'includeRaw', { value: false, writable: true });
      
      const result = await command.execute();
      
      expect(result).toBe(1);
      expect(mockMessageHandler.error).toHaveBeenCalledWith('Query Engine API URL is required for refiner stats.');
      expect(mockMessageHandler.info).toHaveBeenCalledWith('Refiner stats are retrieved from the Query Engine API, not on-chain RPC.');
    });

    it('should fail when no private key is available', async () => {
      Object.defineProperty(command, 'refinerId', { value: '45', writable: true });
      Object.defineProperty(command, 'endpoint', { value: 'https://api.example.com', writable: true });
      Object.defineProperty(command, 'privateKey', { value: undefined, writable: true });
      
      mockConfigManager.getConfigValue.mockRejectedValue(new Error('Config not found'));
      
      const result = await command.execute();
      
      expect(result).toBe(1);
      expect(mockMessageHandler.error).toHaveBeenCalledWith('No private key provided.');
      expect(mockMessageHandler.write).toHaveBeenCalledWith(expect.stringContaining('Set private key with'));
    });
  });

  describe('Output Formats', () => {
    beforeEach(() => {
      Object.defineProperty(command, 'refinerId', { value: '45', writable: true });
      Object.defineProperty(command, 'privateKey', { value: '0x1234567890abcdef', writable: true });
      Object.defineProperty(command, 'endpoint', { value: 'https://api.example.com', writable: true });
      Object.defineProperty(command, 'verbose', { value: false, writable: true });
      Object.defineProperty(command, 'includeRaw', { value: false, writable: true });
      mockQueryClient.getRefinerIngestionStats.mockResolvedValue(mockStatsResponse);
    });

    it('should output JSON when --json flag is set', async () => {
      Object.defineProperty(command, 'json', { value: true, writable: true });
      
      const result = await command.execute();
      
      expect(result).toBe(0);
      expect(mockMessageHandler.write).toHaveBeenCalledWith(
        expect.stringContaining(JSON.stringify(mockStatsResponse, null, 2))
      );
    });

    it('should output formatted content by default', async () => {
      Object.defineProperty(command, 'json', { value: false, writable: true });
      
      const result = await command.execute();
      
      expect(result).toBe(0);
      expect(mockMessageHandler.write).toHaveBeenCalledWith(
        expect.stringContaining('📊 Refiner 45 - Ingestion Statistics')
      );
    });
  });

  describe('API Integration', () => {
    beforeEach(() => {
      Object.defineProperty(command, 'refinerId', { value: '45', writable: true });
      Object.defineProperty(command, 'privateKey', { value: '0x1234567890abcdef', writable: true });
      Object.defineProperty(command, 'endpoint', { value: 'https://api.example.com', writable: true });
      Object.defineProperty(command, 'verbose', { value: false, writable: true });
      Object.defineProperty(command, 'json', { value: false, writable: true });
      Object.defineProperty(command, 'includeRaw', { value: false, writable: true });
    });

    it('should successfully fetch and display stats', async () => {
      mockQueryClient.getRefinerIngestionStats.mockResolvedValue(mockStatsResponse);
      
      const result = await command.execute();
      
      expect(result).toBe(0);
      expect(mockQueryClient.getRefinerIngestionStats).toHaveBeenCalledWith(45, '0x1234567890abcdef');
      expect(mockMessageHandler.success).toHaveBeenCalledWith('Refiner stats retrieved completed successfully');
    });

    it('should handle API errors gracefully', async () => {
      const apiError = new Error('Network timeout');
      mockQueryClient.getRefinerIngestionStats.mockRejectedValue(apiError);
      
      const result = await command.execute();
      
      expect(result).toBe(1);
      expect(mockMessageHandler.error).toHaveBeenCalledWith('Failed to fetch refiner stats: Network timeout');
    });

    it('should provide troubleshooting tips on error', async () => {
      mockQueryClient.getRefinerIngestionStats.mockRejectedValue(new Error('API Error'));
      
      const result = await command.execute();
      
      expect(result).toBe(1);
      expect(mockMessageHandler.write).toHaveBeenCalledWith(expect.stringContaining('Troubleshooting:'));
      expect(mockMessageHandler.write).toHaveBeenCalledWith(expect.stringContaining('Verify the refiner ID exists'));
    });
  });

  describe('Verbose Mode', () => {
    it('should display verbose information when --verbose flag is set', async () => {
      Object.defineProperty(command, 'refinerId', { value: '45', writable: true });
      Object.defineProperty(command, 'privateKey', { value: '0x1234567890abcdef123456', writable: true });
      Object.defineProperty(command, 'endpoint', { value: 'https://api.example.com', writable: true });
      Object.defineProperty(command, 'verbose', { value: true, writable: true });
      Object.defineProperty(command, 'json', { value: false, writable: true });
      Object.defineProperty(command, 'includeRaw', { value: false, writable: true });
      
      mockQueryClient.getRefinerIngestionStats.mockResolvedValue(mockStatsResponse);
      
      const result = await command.execute();
      
      expect(result).toBe(0);
      expect(mockMessageHandler.write).toHaveBeenCalledWith(expect.stringContaining('🔍 Refiner Ingestion Stats'));
      expect(mockMessageHandler.write).toHaveBeenCalledWith(expect.stringContaining('Refiner ID: 45'));
      expect(mockMessageHandler.write).toHaveBeenCalledWith(expect.stringContaining('Private Key: 0x1234...3456'));
    });
  });

  describe('Command Structure', () => {
    it('should have correct command paths', () => {
      expect(RefinerStatsCommand.paths).toEqual([['stats', 'refiner']]);
    });

    it('should have proper usage information', () => {
      expect(RefinerStatsCommand.usage).toBeDefined();
      expect(RefinerStatsCommand.usage.description).toContain('ingestion statistics');
    });
  });
}); 