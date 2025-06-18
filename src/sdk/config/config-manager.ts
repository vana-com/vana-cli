import { promises as fs } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import keytar from 'keytar';

/**
 * Configuration keys that are stored in the TOML file (unprotected)
 */
export interface UnprotectedConfig {
  network: 'vana' | 'moksha';
  rpc_endpoint: string;
  query_engine_endpoint: string;
}

/**
 * Configuration keys that are stored in the OS keyring (protected)
 */
export interface ProtectedConfig {
  wallet_private_key?: string;
}

/**
 * Complete configuration interface
 */
export interface VanaConfig extends UnprotectedConfig, ProtectedConfig {}

/**
 * Default configuration values
 */
const DEFAULT_CONFIG: UnprotectedConfig = {
  network: 'moksha',
  rpc_endpoint: 'https://rpc.moksha.vana.org',
  query_engine_endpoint: 'https://54531900daaa8493797db8d07d6bfbfc77f75b4b-8000.dstack-prod5.phala.network'
};

const KEYRING_SERVICE = 'vana';
const CONFIG_DIR = join(homedir(), '.vana');
const CONFIG_FILE = join(CONFIG_DIR, 'cli.config.toml');

/**
 * Configuration manager for the Vana CLI
 * 
 * Handles both unprotected config (stored in TOML file) and protected secrets 
 * (stored in OS keyring using keytar)
 */
export class ConfigManager {
  private static instance: ConfigManager;
  private unprotectedConfig: UnprotectedConfig | null = null;

  private constructor() {}

  /**
   * Get singleton instance of ConfigManager
   */
  static getInstance(): ConfigManager {
    if (!ConfigManager.instance) {
      ConfigManager.instance = new ConfigManager();
    }
    return ConfigManager.instance;
  }

  /**
   * Initialize configuration directory and file with defaults if they don't exist
   */
  async initialize(): Promise<void> {
    try {
      await fs.mkdir(CONFIG_DIR, { recursive: true });
      
      // Check if config file exists
      try {
        await fs.access(CONFIG_FILE);
      } catch {
        // Config file doesn't exist, create with defaults
        await this.writeUnprotectedConfig(DEFAULT_CONFIG);
      }
    } catch (error) {
      throw new Error(`Failed to initialize config: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Get the complete configuration (unprotected + protected)
   */
  async getConfig(): Promise<VanaConfig> {
    const unprotected = await this.getUnprotectedConfig();
    const protectedConfig = await this.getProtectedConfig();
    
    return {
      ...unprotected,
      ...protectedConfig
    };
  }

  /**
   * Get unprotected configuration from TOML file
   */
  async getUnprotectedConfig(): Promise<UnprotectedConfig> {
    if (this.unprotectedConfig) {
      return this.unprotectedConfig;
    }

    try {
      const content = await fs.readFile(CONFIG_FILE, 'utf-8');
      this.unprotectedConfig = this.parseToml(content);
      return this.unprotectedConfig;
    } catch (error) {
      // If file doesn't exist or is corrupted, return defaults
      this.unprotectedConfig = { ...DEFAULT_CONFIG };
      return this.unprotectedConfig;
    }
  }

  /**
   * Get protected configuration from OS keyring
   */
  async getProtectedConfig(): Promise<ProtectedConfig> {
    try {
      const wallet_private_key = await keytar.getPassword(KEYRING_SERVICE, 'wallet_private_key');
      return {
        wallet_private_key: wallet_private_key || undefined
      };
    } catch (error) {
      // If keyring access fails, return empty protected config
      return {};
    }
  }

  /**
   * Set a configuration value
   */
  async setConfig(key: keyof VanaConfig, value: string): Promise<void> {
    if (this.isProtectedKey(key)) {
      await this.setProtectedConfig(key, value);
    } else {
      await this.setUnprotectedConfig(key as keyof UnprotectedConfig, value);
    }
  }

  /**
   * Get a specific configuration value
   */
  async getConfigValue(key: keyof VanaConfig): Promise<string | undefined> {
    const config = await this.getConfig();
    return config[key];
  }

  /**
   * Set unprotected configuration value
   */
  private async setUnprotectedConfig(key: keyof UnprotectedConfig, value: string): Promise<void> {
    const config = await this.getUnprotectedConfig();
    
    // Validate network value
    if (key === 'network' && !['vana', 'moksha'].includes(value)) {
      throw new Error(`Invalid network value: ${value}. Must be 'vana' or 'moksha'`);
    }
    
    config[key] = value as any;
    await this.writeUnprotectedConfig(config);
    this.unprotectedConfig = config; // Update cache
  }

  /**
   * Set protected configuration value in keyring
   */
  private async setProtectedConfig(key: keyof ProtectedConfig, value: string): Promise<void> {
    try {
      await keytar.setPassword(KEYRING_SERVICE, key, value);
    } catch (error) {
      throw new Error(`Failed to store ${key} in keyring: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Write unprotected configuration to TOML file
   */
  private async writeUnprotectedConfig(config: UnprotectedConfig): Promise<void> {
    const tomlContent = this.generateToml(config);
    
    try {
      await fs.mkdir(dirname(CONFIG_FILE), { recursive: true });
      await fs.writeFile(CONFIG_FILE, tomlContent, 'utf-8');
    } catch (error) {
      throw new Error(`Failed to write config file: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Check if a key should be stored in the keyring
   */
  private isProtectedKey(key: string): key is keyof ProtectedConfig {
    return key === 'wallet_private_key';
  }

  /**
   * Simple TOML parser for our basic config structure
   */
  private parseToml(content: string): UnprotectedConfig {
    const config: Partial<UnprotectedConfig> = {};
    
    const lines = content.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#')) {
        const [key, ...valueParts] = trimmed.split('=');
        if (key && valueParts.length > 0) {
          const cleanKey = key.trim();
          const cleanValue = valueParts.join('=').trim().replace(/['"]/g, '');
          
          if (cleanKey === 'network' || cleanKey === 'rpc_endpoint' || cleanKey === 'query_engine_endpoint') {
            config[cleanKey] = cleanValue as any;
          }
        }
      }
    }
    
    // Merge with defaults for any missing values
    return {
      ...DEFAULT_CONFIG,
      ...config
    };
  }

  /**
   * Generate TOML content from config object
   */
  private generateToml(config: UnprotectedConfig): string {
    return `# Vana CLI Configuration
# This file stores unprotected configuration values
# Secrets like private keys are stored securely in the OS keyring

network = "${config.network}"
rpc_endpoint = "${config.rpc_endpoint}"
query_engine_endpoint = "${config.query_engine_endpoint}"
`;
  }

  /**
   * Get all configuration keys
   */
  getConfigKeys(): {
    unprotected: (keyof UnprotectedConfig)[];
    protected: (keyof ProtectedConfig)[];
  } {
    return {
      unprotected: ['network', 'rpc_endpoint', 'query_engine_endpoint'],
      protected: ['wallet_private_key']
    };
  }

  /**
   * Reset configuration to defaults
   */
  async reset(): Promise<void> {
    // Reset unprotected config
    await this.writeUnprotectedConfig(DEFAULT_CONFIG);
    this.unprotectedConfig = null;
    
    // Clear protected config
    try {
      await keytar.deletePassword(KEYRING_SERVICE, 'wallet_private_key');
    } catch {
      // Ignore errors if password doesn't exist
    }
  }

  /**
   * Get the config file path
   */
  getConfigPath(): string {
    return CONFIG_FILE;
  }
} 