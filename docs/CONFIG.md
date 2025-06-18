# Vana CLI Configuration

The Vana CLI uses a hybrid configuration system that stores unprotected values in a TOML file and protected secrets in the OS keyring for maximum security.

## Configuration Storage

### Unprotected Configuration
- **Location**: `~/.vana/cli.config.toml`
- **Format**: TOML
- **Contains**: Network settings, RPC endpoints, and other non-sensitive configuration

### Protected Configuration  
- **Location**: OS Keyring (Keychain on macOS, Credential Manager on Windows, Secret Service on Linux)
- **Format**: Encrypted key-value pairs
- **Contains**: Private keys and other sensitive data

## Configuration Keys

| Key | Type | Storage | Description | Default |
|-----|------|---------|-------------|---------|
| `network` | `vana` \| `moksha` | Unprotected | Target network | `moksha` |
| `rpc_endpoint` | `string` | Unprotected | RPC endpoint URL | `https://rpc.moksha.vana.org` |
| `wallet_private_key` | `string` | Protected | Wallet private key | _(not set)_ |

## Commands

### `vana config init`
Initialize configuration with default values.

```bash
# Initialize with defaults
vana config init

# Reset existing configuration to defaults
vana config init --reset

# Initialize quietly (no output)
vana config init --quiet
```

### `vana config get`
Retrieve configuration values.

```bash
# Show all unprotected configuration
vana config get

# Show specific key
vana config get network

# Show all configuration including secrets
vana config get --secrets

# Output as JSON
vana config get --json

# Get specific key with secrets
vana config get wallet_private_key --secrets
```

### `vana config set`
Set configuration values.

```bash
# Set network
vana config set network moksha

# Set RPC endpoint
vana config set rpc_endpoint https://rpc.moksha.vana.org

# Set private key (stored securely in keyring)
vana config set wallet_private_key 0x1234567890abcdef...

# Interactive configuration setup
vana config set --interactive

# Set value quietly (no output)
vana config set network vana --quiet
```

## Usage Examples

### Initial Setup
```bash
# 1. Initialize configuration
vana config init

# 2. Set your private key
vana config set wallet_private_key 0x1234567890abcdef...

# 3. Verify configuration
vana config get --secrets
```

### Switch Networks
```bash
# Switch to mainnet
vana config set network vana
vana config set rpc_endpoint https://rpc.vana.org

# Switch to testnet
vana config set network moksha
vana config set rpc_endpoint https://rpc.moksha.vana.org
```

### Export Configuration
```bash
# Export unprotected config as JSON
vana config get --json > vana-config.json

# View all settings (including masked secrets)
vana config get --secrets
```

## Security Considerations

### Private Key Storage
- Private keys are stored in the OS keyring, not in plain text files
- The keyring is encrypted and managed by the operating system
- Access requires user authentication (password, biometrics, etc.)

### File Permissions
- The config file `~/.vana/cli.config.toml` has restricted permissions (600)
- The config directory `~/.vana/` is created with user-only access

### Best Practices
1. **Never share your private key** - It's stored securely in the keyring
2. **Use environment variables** for CI/CD scenarios where keyring isn't available
3. **Regularly rotate keys** and update the configuration
4. **Backup your configuration** but exclude private keys from version control

## Troubleshooting

### Keyring Access Issues
If you encounter keyring access errors:

```bash
# On Linux, ensure you have a keyring service running
sudo apt-get install gnome-keyring

# On macOS, keyring access is built-in
# On Windows, Credential Manager is used automatically
```

### Configuration File Issues
```bash
# Reset configuration to defaults
vana config init --reset

# Check configuration file location
vana config get --json | jq '.config_path'

# Manually edit configuration file
vim ~/.vana/cli.config.toml
```

### Permission Issues
```bash
# Fix config directory permissions
chmod 700 ~/.vana/
chmod 600 ~/.vana/cli.config.toml
```

## Environment Variables

For CI/CD or automated scenarios, you can override configuration with environment variables:

```bash
export VANA_NETWORK=moksha
export VANA_RPC_ENDPOINT=https://rpc.moksha.vana.org
export VANA_WALLET_PRIVATE_KEY=0x1234567890abcdef...

# Commands will use environment variables if config is not set
vana stats refiner --id 45 --endpoint https://some-query-engine.endpoint
```

## Configuration Schema

The TOML configuration file follows this schema:

```toml
# Vana CLI Configuration
# This file stores unprotected configuration values
# Secrets like private keys are stored securely in the OS keyring

network = "moksha"
rpc_endpoint = "https://rpc.moksha.vana.org"
```

## Migration

### From Environment Variables
```bash
# If you previously used environment variables, migrate to config:
vana config set network $VANA_NETWORK
vana config set rpc_endpoint $VANA_RPC_ENDPOINT
vana config set wallet_private_key $VANA_WALLET_PRIVATE_KEY
```

### From Other CLI Tools
```bash
# Export from other tools and import:
vana config set network $(other-tool config get network)
vana config set rpc_endpoint $(other-tool config get rpc_endpoint)
```