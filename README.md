# Vana CLI

> **⚠️ ALPHA SOFTWARE - EXPERIMENTAL USE ONLY**
> 
> This CLI is in early alpha development and is **NOT SUITABLE FOR PRODUCTION USE**. 
> Features may change without notice, and data loss or unexpected behavior may occur.
> Use at your own risk and avoid using with mainnet assets or critical operations.

A command-line interface for interacting with the Vana L1 network and related services.

## Installation

Install globally via npm:

```bash
npm install -g vana-cli
```

Or use directly with npx:

```bash
npx vana-cli --help
```

## Quick Start

> **Note**: This is alpha software. Only use with testnet/development environments.

1. **Initialize configuration**:
   ```bash
   vana config init
   ```

2. **Set your wallet private key**:
   ```bash
   vana config set wallet_private_key 63...
   ```

3. **Get refiner statistics**:
   ```bash
   vana stats refiner --id 45
   ```

## Commands

### Configuration Management

- `vana config init` - Initialize configuration with defaults
- `vana config get [key]` - Get configuration values
- `vana config set <key> <value>` - Set configuration values

### Statistics

- `vana stats refiner --id <id>` - Get ingestion statistics for a specific refiner

## Configuration

The CLI stores configuration in:
- **Unprotected values**: `~/.vana/cli.config.toml`
- **Protected values** (like private keys): OS keyring

### Available Configuration Keys

- `network` - Network to connect to (vana|moksha)
- `rpc_endpoint` - RPC endpoint URL
- `wallet_private_key` - Your wallet private key (stored securely in keyring)

## Examples

```bash
# Initialize with defaults
vana config init

# Set network
vana config set network moksha

# Set custom RPC endpoint
vana config set rpc_endpoint https://rpc.moksha.vana.org

# Get refiner stats with verbose output
vana stats refiner --id 45 --verbose

# Get stats in JSON format
vana stats refiner --id 45 --json

# Use custom endpoint for one-off query
vana stats refiner --id 45 --endpoint https://custom.api.com
```

## Development

See [DEVELOPMENT.md](DEVELOPMENT.md) for development setup and contribution guidelines.

## License

MIT