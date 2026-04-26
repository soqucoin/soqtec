/**
 * Chain Event Adapter (CEA) Module
 *
 * SOQ-TEC's chain-agnostic burn detection layer.
 * Import from here to get the router, types, and specific adapters.
 *
 * Usage:
 *   import { DUAEventRouter, SolanaCEA } from './cea';
 *
 *   const router = new DUAEventRouter(config);
 *   router.registerAdapter(new SolanaCEA(solanaConfig));
 *   // Future: router.registerAdapter(new BitcoinCEA(btcConfig));
 *   await router.startAll();
 */

export * from './types';
export { DUAEventRouter } from './router';
export type { DUARouterConfig, ReleaseRecord } from './router';
export { SolanaCEA } from './solana-cea';
export type { SolanaCEAConfig } from './solana-cea';
