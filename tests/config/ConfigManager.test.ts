import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ConfigManager } from '../../src/sdk/config/config-manager.js';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('ConfigManager', () => {
  let configManager: ConfigManager;
  let testConfigDir: string;
  let originalConfigDir: string;

  beforeEach(async () => {
    // Create a temporary directory for testing
    testConfigDir = join(tmpdir(), `vana-cli-test-${Date.now()}`);
    await fs.mkdir(testConfigDir, { recursive: true });
    
    // Mock the config directory
    originalConfigDir = process.env.HOME || '';
    process.env.HOME = testConfigDir;
    
    configManager = ConfigManager.getInstance();
  });

  afterEach(async () => {
    // Restore original HOME
    if (originalConfigDir) {
      process.env.HOME = originalConfigDir;
    }
    
    // Clean up test directory
    try {
      await fs.rm(testConfigDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  it('should initialize with default configuration', async () => {
    await configManager.initialize();
    
    const config = await configManager.getUnprotectedConfig();
    
    expect(config.network).toBe('moksha');
    expect(config.rpc_endpoint).toBe('https://rpc.moksha.vana.org');
  });

  it('should set and get unprotected configuration values', async () => {
    await configManager.initialize();
    
    await configManager.setConfig('network', 'vana');
    await configManager.setConfig('rpc_endpoint', 'https://rpc.vana.org');
    
    const network = await configManager.getConfigValue('network');
    const rpcEndpoint = await configManager.getConfigValue('rpc_endpoint');
    
    expect(network).toBe('vana');
    expect(rpcEndpoint).toBe('https://rpc.vana.org');
  });

  it('should validate network values', async () => {
    await configManager.initialize();
    
    await expect(configManager.setConfig('network', 'invalid')).rejects.toThrow('Invalid network value');
  });

  it('should get configuration keys', () => {
    const keys = configManager.getConfigKeys();
    
    expect(keys.unprotected).toContain('network');
    expect(keys.unprotected).toContain('rpc_endpoint');
    expect(keys.protected).toContain('wallet_private_key');
  });

  it('should reset configuration to defaults', async () => {
    await configManager.initialize();
    
    // Set some custom values
    await configManager.setConfig('network', 'vana');
    await configManager.setConfig('rpc_endpoint', 'https://custom.rpc.org');
    
    // Reset
    await configManager.reset();
    
    // Verify defaults are restored
    const config = await configManager.getUnprotectedConfig();
    expect(config.network).toBe('moksha');
    expect(config.rpc_endpoint).toBe('https://rpc.moksha.vana.org');
  });

  it('should handle missing config file gracefully', async () => {
    // Don't initialize, just try to get config
    const config = await configManager.getUnprotectedConfig();
    
    // Should return defaults
    expect(config.network).toBe('moksha');
    expect(config.rpc_endpoint).toBe('https://rpc.moksha.vana.org');
  });
}); 