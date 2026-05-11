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
  
  // Soqucoin — Hot Wallet (WRITE-ONLY: sendtoaddress)
  soqucoinRpc: string;
  soqucoinRpcUser: string;
  soqucoinRpcPass: string;
  vaultAddress: string;

  // USDSOQ Mint — DEPRECATED: was for wallet-enabled node, now uses soq-signer
  usdsoqMintRpc: string;
  usdsoqMintRpcUser: string;
  usdsoqMintRpcPass: string;

  // soq-signer — Out-of-process Dilithium signing (Phase 4+)
  // Handles all L1 writes: sendtoaddress AND mint-usdsoq
  soqSignerUrl: string;
  soqSignerToken: string;

  // Read-path separation (Layer 3 — DL-HOT-WALLET-RPC-QUEUE)
  // Cold node for chain queries (disablewallet=1, no cs_wallet contention)
  coldNodeRpc: string;
  coldNodeRpcUser: string;
  coldNodeRpcPass: string;
  // SoquShield ElectrumX API for balance/UTXO queries (zero mutex)
  soqushieldApi: string;
  
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

    // USDSOQ mint: DEPRECATED — soq-signer handles this now
    usdsoqMintRpc: process.env.USDSOQ_MINT_RPC || 'http://127.0.0.1:38334',
    usdsoqMintRpcUser: process.env.USDSOQ_MINT_RPC_USER || process.env.SOQUCOIN_RPC_USER || 'soqucoin_hot',
    usdsoqMintRpcPass: process.env.USDSOQ_MINT_RPC_PASS || process.env.SOQUCOIN_RPC_PASS || '',

    // soq-signer: wallet-free signing service (Broadcast Node VPS)
    soqSignerUrl: process.env.SOQ_SIGNER_URL || 'http://64.23.129.28:8550',
    soqSignerToken: process.env.SOQ_SIGNER_TOKEN || '',

    // Read-path: cold node for chain data (no wallet mutex)
    coldNodeRpc: process.env.COLD_NODE_RPC || process.env.SOQUCOIN_RPC || 'http://127.0.0.1:38332',
    coldNodeRpcUser: process.env.COLD_NODE_RPC_USER || process.env.SOQUCOIN_RPC_USER || '',
    coldNodeRpcPass: process.env.COLD_NODE_RPC_PASS || process.env.SOQUCOIN_RPC_PASS || '',
    // Read-path: ElectrumX for balance/UTXO (zero mutex)
    soqushieldApi: process.env.SOQUSHIELD_API || 'https://soqushield-api.research-c26.workers.dev',
    
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
