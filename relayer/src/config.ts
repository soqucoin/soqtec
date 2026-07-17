/**
 * SOQ-TEC Relayer Configuration
 */

import dotenv from 'dotenv';
import { join } from 'path';
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

  // BTCSOQ gateway (DL-BTC-SOQTEC-GATEWAY-2026-07-16)
  btcsoq: BtcsoqSettings;
}

export interface BtcsoqSettings {
  enabled: boolean;
  network: 'testnet4' | 'regtest' | 'signet' | 'mainnet';
  rpcUrl: string;
  rpcUser: string;
  rpcPass: string;
  depositWallet: string;
  releaseWallet: string;
  finalityConf: number;
  pollIntervalMs: number;
  dataDir: string;
  intentTtlHours: number;
  explorerBase: string;
  // Money loop (Day 2) — dedicated gateway signer instance + stagenet read RPC
  mintSignerUrl: string;
  mintSignerToken: string;
  mintFromAddress: string;
  redemptionAddress: string;
  carrierShors: number;
  mintFeeRate: number;
  minDepositSats: number;
  soqRpcUrl: string;
  soqRpcUser: string;
  soqRpcPass: string;
  attestationAddress: string;
  maxDailyMintSats: number;
  maxDailyReleaseSats: number;
  pauseFile: string;
  // USDSOQ conversion leg (WS2)
  convertSignerUrl: string;
  convertSignerToken: string;
  convertTreasuryAddress: string;
  convertUsdsoqAddress: string;
  convertSoqShors: number;
  maxDailyConvertShors: number;
  // Lightning + SOQ-402 finale (WS3)
  ln402LspUrl: string;
  ln402SellerUrl: string;
  ln402Question: string;
  ln402ChannelShors: number;
  ln402ChannelAddress: string;
  ln402Seller2Url: string;
  racePayeeAddress: string;
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
    soqSignerUrl: process.env.SOQ_SIGNER_URL || 'http://127.0.0.1:8550',
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

    btcsoq: loadBtcsoqSettings(),
  };
}

function loadBtcsoqSettings(): BtcsoqSettings {
  const network = (process.env.BTC_NETWORK as any) || 'regtest';
  const defaultRpcPort: Record<string, number> = {
    testnet4: 48332, regtest: 18443, signet: 38332, mainnet: 8332,
  };
  const defaultExplorer: Record<string, string> = {
    testnet4: 'https://mempool.space/testnet4',
    signet: 'https://mempool.space/signet',
    mainnet: 'https://mempool.space',
    regtest: '',
  };
  return {
    enabled: process.env.BTCSOQ_ENABLED === 'true',
    network,
    rpcUrl: process.env.BTC_RPC_URL || `http://127.0.0.1:${defaultRpcPort[network] || 18443}`,
    rpcUser: process.env.BTC_RPC_USER || '',
    rpcPass: process.env.BTC_RPC_PASS || '',
    depositWallet: process.env.BTC_DEPOSIT_WALLET || 'btcsoq-deposits',
    releaseWallet: process.env.BTC_RELEASE_WALLET || 'btcsoq-release',
    // Demo confirmation policy: 1 conf on testnet4/regtest, disclosed on-screen;
    // mainnet posture = 6 (DL §4.5)
    finalityConf: parseInt(process.env.BTC_FINALITY_CONF || (network === 'mainnet' ? '6' : '1')),
    pollIntervalMs: parseInt(process.env.BTC_POLL_MS || '10000'),
    dataDir: process.env.BTCSOQ_DATA_DIR || './btcsoq-data',
    intentTtlHours: parseInt(process.env.BTCSOQ_INTENT_TTL_HOURS || '24'),
    explorerBase: process.env.BTC_EXPLORER_BASE || defaultExplorer[network] || '',
    // Money loop: the gateway's OWN signer instance (soq-privacy-signer
    // pattern) — never the production signer at 8550.
    mintSignerUrl: process.env.BTCSOQ_MINT_SIGNER_URL || '',
    mintSignerToken: process.env.BTCSOQ_MINT_SIGNER_TOKEN || '',
    mintFromAddress: process.env.BTCSOQ_MINT_FROM_ADDRESS || '',
    redemptionAddress: process.env.BTCSOQ_REDEMPTION_ADDRESS || '',
    // Carrier must cover its own redemption-spend fee: ML-DSA txs are ~4-8kB
    // and the stagenet fee-rate floor is 1000 shors/vB.
    carrierShors: parseInt(process.env.BTCSOQ_CARRIER_SHORS || '20000000'),
    mintFeeRate: parseInt(process.env.BTCSOQ_MINT_FEE_RATE || '1000'),
    minDepositSats: parseInt(process.env.BTCSOQ_MIN_DEPOSIT_SATS || '10000'),
    // Stagenet read path (recovery + redemption scanning) — reuses the
    // relayer's cold-node creds unless overridden.
    soqRpcUrl: process.env.BTCSOQ_SOQ_RPC || process.env.COLD_NODE_RPC || 'http://127.0.0.1:38332',
    soqRpcUser: process.env.BTCSOQ_SOQ_RPC_USER || process.env.COLD_NODE_RPC_USER || process.env.SOQUCOIN_RPC_USER || '',
    soqRpcPass: process.env.BTCSOQ_SOQ_RPC_PASS || process.env.COLD_NODE_RPC_PASS || process.env.SOQUCOIN_RPC_PASS || '',
    // Dilithium-signed event feed; key lives in the gateway signer keystore
    attestationAddress: process.env.BTCSOQ_ATTESTATION_ADDRESS || '',
    // Circuit breaker: rolling-24h ceilings (0 = unlimited) + pause file.
    // Demo posture: cap a runaway lane at ~0.05 BTC/day each direction.
    maxDailyMintSats: parseInt(process.env.BTCSOQ_MAX_DAILY_MINT_SATS || '5000000'),
    maxDailyReleaseSats: parseInt(process.env.BTCSOQ_MAX_DAILY_RELEASE_SATS || '5000000'),
    pauseFile: process.env.BTCSOQ_PAUSE_FILE ||
      join(process.env.BTCSOQ_DATA_DIR || './btcsoq-data', 'PAUSE'),
    // USDSOQ conversion leg (WS2): the gateway is a convert CUSTOMER of the
    // production signer — deposit-is-the-auth, no authority keys anywhere
    // near this path. All four values set = leg on.
    convertSignerUrl: process.env.BTCSOQ_CONVERT_SIGNER_URL || '',
    convertSignerToken: process.env.BTCSOQ_CONVERT_SIGNER_TOKEN || '',
    convertTreasuryAddress: process.env.BTCSOQ_CONVERT_TREASURY_ADDRESS || '',
    convertUsdsoqAddress: process.env.BTCSOQ_CONVERT_USDSOQ_ADDRESS || '',
    // 1 SOQ of gateway float per completed BTC loop (tunable per demo)
    convertSoqShors: parseInt(process.env.BTCSOQ_CONVERT_SHORS || '100000000'),
    // Rolling-24h ceiling on float SOQ entering the treasury: 50 SOQ
    maxDailyConvertShors: parseInt(process.env.BTCSOQ_MAX_DAILY_CONVERT_SHORS || '5000000000'),
    // Lightning + SOQ-402 finale (WS3): both URLs + question + channel
    // identity set = leg on. The seller runs on this same VPS.
    ln402LspUrl: process.env.BTCSOQ_LN402_LSP_URL || '',
    ln402SellerUrl: process.env.BTCSOQ_LN402_SELLER_URL || '',
    ln402Question: process.env.BTCSOQ_LN402_QUESTION ||
      'In one sentence: what does a 2,420-byte ML-DSA-44 signature buy Bitcoin that a 64-byte Schnorr signature cannot?',
    ln402ChannelShors: parseInt(process.env.BTCSOQ_LN402_CHANNEL_SHORS || '100000000'),
    // Channel identity rides the same gateway key as the USDSOQ destination
    // unless split out explicitly.
    ln402ChannelAddress: process.env.BTCSOQ_LN402_CHANNEL_ADDRESS ||
      process.env.BTCSOQ_CONVERT_USDSOQ_ADDRESS || '',
    // Theater acts: second agent + race payee identity (both set = acts on)
    ln402Seller2Url: process.env.BTCSOQ_LN402_SELLER2_URL || '',
    racePayeeAddress: process.env.BTCSOQ_RACE_PAYEE_ADDRESS || '',
  };
}
