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
  solanaKeypairPath: string;
  
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

  // CEA/DUA — Chain Event Adapter & Dual-Usage Attestation
  heliusApiKey: string;
  paulEndpoint: string;
  releasePolicy: 'mempool' | 'confirmed' | 'finalized';
  webhookCallbackUrl: string;
  duaEnabled: boolean;
}

export function loadConfig(): RelayerConfig {
  return {
    network: (process.env.NETWORK as any) || 'devnet',
    
    solanaRpc: process.env.SOLANA_RPC || 'https://api.devnet.solana.com',
    solanaProgramId: process.env.SOLANA_PROGRAM_ID || '9pCJxjVF8VTizZ9RZZLTu997y2DafWgUGqYbrNiqPw36',
    psoqMint: process.env.PSOQ_MINT || '7TCU5SnLR7ARRAd8aUdoAFgw9zvCvzwdphm7TjUT6s46',
    solanaKeypairPath: process.env.SOLANA_KEYPAIR || '~/.config/solana/soqtec-deployer.json',
    
    soqucoinRpc: process.env.SOQUCOIN_RPC || 'http://127.0.0.1:44557',
    soqucoinRpcUser: process.env.SOQUCOIN_RPC_USER || '',
    soqucoinRpcPass: process.env.SOQUCOIN_RPC_PASS || '',
    vaultAddress: process.env.VAULT_ADDRESS || '',
    
    threshold: parseInt(process.env.THRESHOLD || '2'),
    validatorCount: parseInt(process.env.VALIDATOR_COUNT || '3'),
    validatorKeyPath: process.env.VALIDATOR_KEY_PATH || './keys',
    
    apiPort: parseInt(process.env.API_PORT || '3001'),
    apiCorsOrigins: (process.env.CORS_ORIGINS || 'https://soqtec.soqu.org,http://localhost:3000')
      .split(','),
    
    dailyLimitSoq: parseInt(process.env.DAILY_LIMIT || '1000000'),
    minTransferSoq: parseInt(process.env.MIN_TRANSFER || '1'),
    maxTransferSoq: parseInt(process.env.MAX_TRANSFER || '100000'),
    
    solanaPollInterval: parseInt(process.env.SOLANA_POLL_MS || '2000'),
    soqucoinPollInterval: parseInt(process.env.SOQUCOIN_POLL_MS || '10000'),

    // CEA/DUA
    heliusApiKey: process.env.HELIUS_API_KEY || '',
    paulEndpoint: process.env.PAUL_ENDPOINT || 'http://localhost:3003',
    releasePolicy: (process.env.RELEASE_POLICY as any) || 'confirmed',
    webhookCallbackUrl: process.env.WEBHOOK_CALLBACK_URL || '',
    duaEnabled: process.env.DUA_ENABLED === 'true',
  };
}
