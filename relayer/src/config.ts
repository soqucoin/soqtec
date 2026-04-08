/**
 * SOQ-TEC Relayer Configuration
 */

import dotenv from 'dotenv';
dotenv.config();

export interface RelayerConfig {
  // Network
  network: 'devnet' | 'testnet' | 'mainnet';
  
  // Solana
  solanaRpc: string;
  solanaProgramId: string;
  psoqMint: string;
  
  // Soqucoin
  soqucoinRpc: string;
  soqucoinRpcUser: string;
  soqucoinRpcPass: string;
  vaultAddress: string;
  
  // Validator/Signing
  threshold: number;
  validatorCount: number;
  validatorKeyPath: string;
  
  // API
  apiPort: number;
  apiCorsOrigins: string[];
  
  // Limits
  dailyLimitSoq: number;
  minTransferSoq: number;
  maxTransferSoq: number;
  
  // Polling intervals (ms)
  solanaPollInterval: number;
  soqucoinPollInterval: number;
}

export function loadConfig(): RelayerConfig {
  return {
    network: (process.env.NETWORK as any) || 'devnet',
    
    solanaRpc: process.env.SOLANA_RPC || 'https://api.devnet.solana.com',
    solanaProgramId: process.env.SOLANA_PROGRAM_ID || 'SoQTECBridgeProgram11111111111111111111111',
    psoqMint: process.env.PSOQ_MINT || '',
    
    soqucoinRpc: process.env.SOQUCOIN_RPC || 'http://localhost:44555',
    soqucoinRpcUser: process.env.SOQUCOIN_RPC_USER || '',
    soqucoinRpcPass: process.env.SOQUCOIN_RPC_PASS || '',
    vaultAddress: process.env.VAULT_ADDRESS || '',
    
    threshold: parseInt(process.env.THRESHOLD || '3'),
    validatorCount: parseInt(process.env.VALIDATOR_COUNT || '5'),
    validatorKeyPath: process.env.VALIDATOR_KEY_PATH || './keys',
    
    apiPort: parseInt(process.env.API_PORT || '3001'),
    apiCorsOrigins: (process.env.CORS_ORIGINS || 'https://soqtec.soqu.org,http://localhost:3000')
      .split(','),
    
    dailyLimitSoq: parseInt(process.env.DAILY_LIMIT || '1000000'),
    minTransferSoq: parseInt(process.env.MIN_TRANSFER || '100'),
    maxTransferSoq: parseInt(process.env.MAX_TRANSFER || '100000'),
    
    solanaPollInterval: parseInt(process.env.SOLANA_POLL_MS || '2000'),
    soqucoinPollInterval: parseInt(process.env.SOQUCOIN_POLL_MS || '10000'),
  };
}
