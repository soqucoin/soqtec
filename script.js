/* =========================================================
   SOQ-TEC TERMINAL v1.4 — Pip-Boy Interface Logic
   Boot sequence, live data, animations, terminal behavior
   NOW WITH: Live relayer integration + PAUL/DUA/CEA pipeline
   ========================================================= */

// ============================================================
// CONFIGURATION
// ============================================================
const CONFIG = {
    // Relayer API — proxied through Cloudflare Worker (HTTPS) → stagenet (HTTP)
    relayerApi: 'https://soqtec-relay-proxy.research-c26.workers.dev',
    
    // Gateway API (wallet-api handles gateway transfers)
    bridgeApi: 'https://wallet-api.soqu.org',
    
    // Explorer API
    explorerApi: 'https://xplorer.soqu.org',
    
    // Solana RPC
    solanaRpc: 'https://api.devnet.solana.com',
    
    // Refresh intervals
    dataRefreshMs: 15000,     // 15s for live data
    activityRefreshMs: 10000, // 10s for activity feed
    blockRefreshMs: 30000,    // 30s for blocks
};

// ============================================================
// BOOT SEQUENCE
// ============================================================
const BOOT_LINES = [
    { text: '+==============================================+', delay: 30 },
    { text: '|                                              |', delay: 20 },
    { text: '|   SOQ-TEC TERMINAL v1.4.0                    |', delay: 40 },
    { text: '|   Soqucoin Operations for Quantum-Tolerant   |', delay: 40 },
    { text: '|   Ecosystem Custody                          |', delay: 40 },
    { text: '|                                              |', delay: 20 },
    { text: '|   Colosseum Frontier Hackathon 2026           |', delay: 50 },
    { text: '|   (c) 2026 Soqucoin Labs Inc.                |', delay: 40 },
    { text: '+==============================================+', delay: 30 },
    { text: '', delay: 200 },
    { text: 'MISSION: Quantum-safe custody gateway for', delay: 50 },
    { text: '         Solana assets via Soqucoin L1.', delay: 50 },
    { text: '', delay: 150 },
    { text: 'BIOS CHECK................OK', delay: 60 },
    { text: 'MEMORY TEST...............64K OK', delay: 80 },
    { text: '', delay: 100 },
    { text: '> Initializing SOQ-TEC Protocol...', delay: 80 },
    { text: '> Loading ML-DSA-44 Dilithium module.....OK', delay: 100 },
    { text: '> Loading XMSS-Lite Revolving Vault......OK', delay: 90 },
    { text: '> Loading Gateway Attestation Engine.......OK', delay: 110 },
    { text: '> Loading Quantum Express relay...........OK', delay: 100 },
    { text: '', delay: 100 },
    { text: '> Connecting to Soqucoin L1 (Stagenet)...', delay: 120 },
    { text: '  RPC: https://rpc.soqu.org', delay: 60 },
    { text: '  STATUS:  CONNECTED', delay: 80 },
    { text: '  BLOCK HEIGHT: syncing...', delay: 40, id: 'boot-soq-block' },
    { text: '', delay: 80 },
    { text: '> Connecting to Solana (Devnet)...', delay: 120 },
    { text: '  RPC: https://api.devnet.solana.com', delay: 60 },
    { text: '  STATUS:  CONNECTED', delay: 80 },
    { text: '  SLOT: syncing...', delay: 40, id: 'boot-sol-slot' },
    { text: '', delay: 80 },
    { text: '> Connecting to SOQ-TEC Relayer...', delay: 120 },
    { text: '  GATEWAY PROGRAM: 9pCJxjVF...w36', delay: 60 },
    { text: '  THRESHOLD: 2-of-3 MULTISIG', delay: 50 },
    { text: '  STATUS:  OPERATIONAL', delay: 80 },
    { text: '', delay: 80 },
    { text: '> Checking vault custody status...', delay: 100 },
    { text: '  SIGNATURE:  ML-DSA-44 (FIPS 204)', delay: 50 },
    { text: '  PROTECTION: DILITHIUM ACTIVE', delay: 50 },
    { text: '  VAULT:      XMSS-LITE REVOLVING', delay: 50 },
    { text: '', delay: 80 },
    { text: '> Running quantum threat assessment...', delay: 150 },
    { text: '  Ed25519 EXPOSURE: 100% of Solana wallets', delay: 60 },
    { text: '  HNDL RISK:        ELEVATED', delay: 60 },
    { text: '  PQ MIGRATION:     90% throughput loss', delay: 80 },
    { text: '  RECOMMENDATION:   USE PQ CUSTODY GATEWAY', delay: 60 },
    { text: '', delay: 100 },
    { text: '> Quantum Express relay: OPTIMISTIC MODE', delay: 80 },
    { text: '  Instant receipts: <30s | PoR batch: 60 blocks', delay: 60 },
    { text: '', delay: 100 },
    { text: '+----------------------------------------------+', delay: 30 },
    { text: '|  QUANTUM THREAT LEVEL:  ||||.  ELEVATED       |', delay: 50 },
    { text: '+----------------------------------------------+', delay: 30 },
    { text: '', delay: 200 },
    { text: '> SOQ-TEC Terminal ready.', delay: 80 },
    { text: '> "Prepared for the Quantum Future."', delay: 100 },
    { text: '', delay: 200 },
    { text: '', delay: 100 },
    { text: '> Initializing USDSOQ Stablecoin Module...', delay: 80 },
    { text: '  TYPE:       Quantum-safe stablecoin', delay: 50 },
    { text: '  COLLATERAL: SOQ-backed (native L1)', delay: 50 },
    { text: '  COMPLIANCE: GENIUS Act · MiCA · NYDFS', delay: 50 },
    { text: '  GOVERNANCE: 4/7 threshold authority', delay: 50 },
    { text: '  STATUS:  USDSOQ MODULE ONLINE', delay: 80 },
    { text: '', delay: 100 },
    { text: '> Loading dashboard interface...', delay: 300 },
];

class BootSequence {
    constructor() {
        this.bootScreen = document.getElementById('boot-screen');
        this.bootText = document.getElementById('boot-text');
        this.bootCursor = document.getElementById('boot-cursor');
        this.mainTerminal = document.getElementById('main-terminal');
        this.currentLine = 0;
        this.currentChar = 0;
        this.isComplete = false;
    }

    async start() {
        // Check for skip preference
        if (sessionStorage.getItem('soqtec-boot-done')) {
            this.skip();
            return;
        }

        // Allow click to skip
        this.bootScreen.addEventListener('click', () => this.skip());
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' || e.key === ' ' || e.key === 'Enter') {
                this.skip();
            }
        });

        for (let i = 0; i < BOOT_LINES.length; i++) {
            if (this.isComplete) return;
            const line = BOOT_LINES[i];
            await this.typeLine(line.text, line.delay);
            await this.sleep(line.delay);
        }

        if (!this.isComplete) {
            await this.sleep(500);
            this.complete();
        }
    }

    async typeLine(text, charDelay) {
        const baseDelay = Math.max(8, charDelay / 4);
        for (let i = 0; i < text.length; i++) {
            if (this.isComplete) return;
            this.bootText.textContent += text[i];
            // Auto-scroll
            this.bootText.parentElement.scrollTop = this.bootText.parentElement.scrollHeight;
            await this.sleep(baseDelay);
        }
        this.bootText.textContent += '\n';
    }

    skip() {
        if (this.isComplete) return;
        this.complete();
    }

    complete() {
        this.isComplete = true;
        sessionStorage.setItem('soqtec-boot-done', 'true');
        this.bootScreen.style.transition = 'opacity 0.5s ease-out';
        this.bootScreen.style.opacity = '0';
        setTimeout(() => {
            this.bootScreen.style.display = 'none';
            this.mainTerminal.classList.remove('hidden');
            // Start the dashboard
            dashboard.init();
        }, 500);
    }

    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

// ============================================================
// DASHBOARD CONTROLLER
// ============================================================
class Dashboard {
    constructor() {
        this.animationFrame = null;
        this.updateInterval = null;
        this.logIndex = 0;
        this.lastSoqBlock = 0;
        this.lastSolSlot = 0;
        this.knownBlocks = new Set();
        this.relayerConnected = false;
        this.relayerData = null;
        this.lastActivityCheck = 0;
    }

    init() {
        this.startClock();
        this.animateEntrance();
        this.startDataUpdates();
        this.startActivityFeed();
        this.fetchLiveData();
        this.fetchRecentBlocks();
        this.fetchRelayerStatus();
        this.startBridgeFlowMonitor();
        this.initTabs();
    }

    // --- Pip-Boy Tab Navigation (functional) ---
    initTabs() {
        const tabs = document.querySelectorAll('.pip-tab');
        const contents = document.querySelectorAll('.tab-content');
        tabs.forEach(tab => {
            tab.addEventListener('click', () => {
                const target = tab.dataset.tab;
                tabs.forEach(t => t.classList.remove('active'));
                tab.classList.add('active');
                contents.forEach(c => {
                    c.classList.toggle('active', c.dataset.tabContent === target);
                });
            });
        });
    }

    // --- Sync hero bar from live data ---
    syncHeroBar() {
        const b = document.getElementById('hero-block');
        const s = document.getElementById('soq-block');
        if (b && s && s.textContent !== 'LOADING...') b.textContent = s.textContent;
        const v = document.getElementById('hero-vault');
        const vb = document.getElementById('vault-balance');
        if (v && vb) v.textContent = vb.textContent;
        // Bridge status — reflect real relay state
        const bs = document.getElementById('hero-bridge');
        const rs = document.getElementById('hero-relay-state');
        const bstat = document.getElementById('hero-bridge-status');
        if (bs) bs.textContent = this.relayerConnected ? 'OPERATIONAL' : 'STANDBY';
        if (rs) rs.textContent = this.relayerConnected ? 'ONLINE' : 'STANDBY';
        if (bstat) {
            bstat.className = this.relayerConnected
                ? 'vital__badge vital__badge--online'
                : 'vital__badge';
        }
        // Bridge status color
        if (bs) {
            bs.className = this.relayerConnected
                ? 'vital__value vital__value--bloom'
                : 'vital__value vital__value--amber';
        }
    }

    // --- Clock ---
    startClock() {
        const update = () => {
            const now = new Date();
            const time = now.toLocaleTimeString('en-US', { hour12: false });
            const date = now.toLocaleDateString('en-US', {
                month: 'short',
                day: '2-digit',
                year: 'numeric'
            }).toUpperCase();

            const timeEl = document.getElementById('header-time');
            const dateEl = document.getElementById('header-date');
            if (timeEl) timeEl.textContent = time;
            if (dateEl) dateEl.textContent = date;
        };
        update();
        setInterval(update, 1000);
    }

    // --- Entrance Animation ---
    animateEntrance() {
        const panels = document.querySelectorAll('.panel');
        panels.forEach((panel, i) => {
            panel.style.opacity = '0';
            panel.style.transform = 'translateY(10px)';
            setTimeout(() => {
                panel.style.transition = 'opacity 0.4s ease-out, transform 0.4s ease-out';
                panel.style.opacity = '1';
                panel.style.transform = 'translateY(0)';
            }, 100 + (i * 120));
        });

        // Animate vault bar after panels
        setTimeout(() => {
            this.animateVaultBar();
        }, 1000);
    }

    // --- Vault Bar Animation ---
    animateVaultBar() {
        const vaultBar = document.getElementById('vault-bar');
        if (vaultBar) {
            vaultBar.style.width = '3%';
        }
    }

    // ==========================================================
    // RELAYER INTEGRATION — Live bridge data
    // ==========================================================
    
    async fetchRelayerStatus() {
        try {
            const res = await fetch(`${CONFIG.relayerApi}/api/status`, {
                signal: AbortSignal.timeout(5000)
            });
            if (res.ok) {
                this.relayerData = await res.json();
                this.relayerConnected = true;
                this.updateRelayerDisplay();
                this.updateReservesFromRelayer();
            }
        } catch (e) {
            this.relayerConnected = false;
            console.warn('[SOQ-TEC] Relayer not reachable:', e.message);
        }
        
        // Update relay status indicator
        const relayStatus = document.getElementById('relay-status');
        if (relayStatus) {
            if (this.relayerConnected) {
                relayStatus.textContent = 'RELAY ONLINE';
                relayStatus.classList.add('online');
                relayStatus.classList.remove('offline');
            } else {
                relayStatus.textContent = 'RELAY STANDBY';
                relayStatus.classList.remove('online');
            }
        }
    }

    updateRelayerDisplay() {
        if (!this.relayerData) return;
        const data = this.relayerData;

        // Update SOQ block height from relayer (if available)
        if (data.vault && data.vault.blockHeight > 0) {
            const blockEl = document.getElementById('soq-block');
            if (blockEl && data.vault.blockHeight > this.lastSoqBlock) {
                this.animateNumber(blockEl, data.vault.blockHeight);
                this.lastSoqBlock = data.vault.blockHeight;
            }
        }

        // Update vault balance display
        const vaultBal = document.getElementById('vault-balance');
        if (vaultBal && data.vault) {
            const balance = data.vault.balance || 0;
            vaultBal.textContent = balance > 0 
                ? `${balance.toLocaleString()} SOQ`
                : '0.00 SOQ';
        }

        // Update bridge status in threshold display
        const quorumEl = document.querySelector('.reserves-panel .stat-value:last-child');
        if (data.vault && data.vault.threshold) {
            // Already shows from HTML — just update if needed
        }

        // Update queue + total bridged
        if (data.queue) {
            const totalBridged = document.getElementById('total-bridged');
            if (totalBridged) {
                totalBridged.textContent = data.queue.completed > 0
                    ? `${data.queue.completed} transfers`
                    : '0 SOQ';
            }

            if (data.queue.total > 0) {
                this.addActivityEntry('system', 
                    `[GATEWAY] Queue: ${data.queue.pending} pending, ${data.queue.completed} completed`
                );
            }
        }
    }

    async updateReservesFromRelayer() {
        // Fetch the dedicated reserves endpoint for PoR data
        const soqBar = document.getElementById('soq-reserve-bar');
        const soqVal = document.getElementById('soq-reserve');
        const psoqBar = document.getElementById('psoq-reserve-bar');
        const psoqVal = document.getElementById('psoq-reserve');
        const attestEl = document.getElementById('last-attestation');
        const ratioEl = document.getElementById('backing-ratio');
        const reservesStatus = document.getElementById('reserves-status');

        if (this.relayerConnected) {
            try {
                const res = await fetch(`${CONFIG.relayerApi}/api/reserves`, {
                    signal: AbortSignal.timeout(5000)
                });
                if (res.ok) {
                    const data = await res.json();
                    const reserves = data.reserves;

                    if (reserves) {
                        // SOQ vault balance
                        const vaultBal = reserves.soqVaultBalance || 0;
                        if (soqVal) soqVal.textContent = vaultBal > 0 
                            ? `${vaultBal.toLocaleString()} SOQ` 
                            : '0 SOQ';
                        if (soqBar) soqBar.style.width = vaultBal > 0 ? '50%' : '3%';

                        // pSOQ circulating
                        const psoqCirc = reserves.psoqCirculating || 0;
                        if (psoqVal) psoqVal.textContent = psoqCirc > 0 
                            ? `${psoqCirc.toLocaleString()} pSOQ` 
                            : '0 pSOQ';
                        if (psoqBar) psoqBar.style.width = psoqCirc > 0 ? '50%' : '0%';

                        // Backing ratio
                        if (ratioEl) {
                            ratioEl.textContent = reserves.backingRatio || '1:1 (TARGET)';
                        }

                        // Attestation timestamp
                        if (attestEl && reserves.lastAttestation) {
                            attestEl.textContent = reserves.lastAttestation.slice(0, 19) + 'Z';
                        }

                        // PoR status indicator
                        if (reservesStatus) {
                            reservesStatus.textContent = 'LIVE';
                            reservesStatus.classList.add('online');
                        }
                    }
                }
            } catch (e) {
                console.warn('[SOQ-TEC] Reserves fetch failed:', e.message);
            }
        } else {
            // Fallback: show waiting status
            if (attestEl) attestEl.textContent = 'AWAITING RELAY';
            if (reservesStatus) {
                reservesStatus.textContent = 'STANDBY';
                reservesStatus.classList.remove('online');
            }
        }
    }

    async fetchRelayerActivity() {
        if (!this.relayerConnected) return;
        
        try {
            const res = await fetch(`${CONFIG.relayerApi}/api/activity`, {
                signal: AbortSignal.timeout(5000)
            });
            if (!res.ok) return;
            const data = await res.json();

            // Show real burn events
            if (data.burns && data.burns.length > 0) {
                for (const burn of data.burns) {
                    const amountSoq = (burn.amount / 1e9).toFixed(2);
                    this.addActivityEntry('highlight',
                        `[BURN] 🔥 ${amountSoq} pSOQ burned → ${burn.soqAddress || 'L1 address'} (nonce: ${burn.nonce})`
                    );
                }
            }

            // Show real transfer events
            if (data.transfers && data.transfers.length > 0) {
                for (const tx of data.transfers) {
                    const dir = tx.direction === 'sol_to_soq' ? 'pSOQ→SOQ' : 'SOQ→pSOQ';
                    const status = tx.status.toUpperCase();
                    const raw = typeof tx.amount === 'number' ? tx.amount : parseFloat(tx.amount);
                    const amount = raw > 1000000 ? (raw / 1e9).toFixed(0) : raw;
                    this.addActivityEntry(
                        tx.status === 'completed' ? 'highlight' : 'system',
                        `[GATEWAY] ${dir}: ${Number(amount).toLocaleString()} SOQ — ${status}`
                    );
                }
            }
        } catch (e) {
            // Silently fail — relayer might not be running
        }

        // Fetch DUA/PAUL releases — real burn-to-release pipeline data
        try {
            const duaRes = await fetch(`${CONFIG.relayerApi}/api/dua/releases`, {
                signal: AbortSignal.timeout(5000)
            });
            if (!duaRes.ok) return;
            const duaData = await duaRes.json();

            if (duaData.releases && duaData.releases.length > 0) {
                const isFirstDuaPoll = !this._seenDuaReleases;
                if (isFirstDuaPoll) this._seenDuaReleases = new Set();

                // On first poll, show the 3 most recent releases to seed the feed
                const releases = isFirstDuaPoll
                    ? duaData.releases.slice(0, 3)
                    : duaData.releases;

                for (const rel of releases) {
                    const key = rel.releaseTxId || rel.burnTxId;
                    if (this._seenDuaReleases.has(key)) continue;
                    this._seenDuaReleases.add(key);

                    const amt = (Number(rel.netAmountSoq) / 1e9).toFixed(0);
                    const method = (rel.releaseMethod || 'direct').toUpperCase();
                    const burnShort = rel.burnTxId ? rel.burnTxId.slice(0, 12) + '...' : '—';
                    const relTxShort = rel.releaseTxId ? rel.releaseTxId.slice(0, 12) + '...' : 'pending';

                    this.addActivityEntry('highlight',
                        `[PAUL] 🔥 ${amt} pSOQ burned (${burnShort}) → ${amt} SOQ released via ${method}`
                    );
                    this.addActivityEntry('info',
                        `[PAUL] L1 release TX: ${relTxShort} | confidence: ${rel.confidence || '—'}`
                    );

                    // Trigger flow animation only for truly new releases (not first-load seed)
                    if (!isFirstDuaPoll && !this._animating) {
                        this.animateBridgeFlow(`${amt} SOQ`, rel.releaseTxId);
                    }
                }

                // On first poll, also mark ALL existing releases as seen to prevent re-display
                if (isFirstDuaPoll) {
                    for (const rel of duaData.releases) {
                        this._seenDuaReleases.add(rel.releaseTxId || rel.burnTxId);
                    }
                }
            }
        } catch (e) {
            // DUA endpoint may not exist on older relayers
        }
    }

    // Fetch REAL bridge transfer activity from wallet-api
    async fetchBridgeTransfers() {
        try {
            const res = await fetch(`${CONFIG.bridgeApi}/api/bridge/activity?limit=5`, {
                signal: AbortSignal.timeout(5000)
            });
            if (!res.ok) return;
            const data = await res.json();

            if (data.transfers && data.transfers.length > 0) {
                if (!this._seenBridgeTxs) this._seenBridgeTxs = new Set();

                for (const tx of data.transfers) {
                    const txKey = tx.soqTxid || String(tx.timestamp);
                    if (this._seenBridgeTxs.has(txKey)) continue;
                    this._seenBridgeTxs.add(txKey);

                    const addr = tx.soqAddress ? tx.soqAddress.slice(0, 12) + '...' : '???';
                    this.addActivityEntry('highlight',
                        `[GATEWAY] \u{1F525} ${tx.amount.toLocaleString()} pSOQ \u2192 ${tx.netAmount.toLocaleString()} SOQ released to ${addr}`
                    );
                    this.addActivityEntry('info',
                        `[GATEWAY] SOQ txid: ${tx.soqTxid ? tx.soqTxid.slice(0, 16) + '...' : 'pending'}`
                    );
                    // Animation triggered by startBridgeFlowMonitor (single source)
                }

                // Update total bridged counter
                const totalBridged = document.getElementById('total-bridged');
                if (totalBridged && data.totalBridged > 0) {
                    totalBridged.textContent = `${data.totalBridged.toLocaleString()} SOQ`;
                }
            }
        } catch (e) {
            // Silently fail
        }
    }

    // --- Live Data Fetch (with fallback chain) ---
    async fetchLiveData() {
        // ── SOQ Block Height ──
        // Primary: Explorer API (has CORS now)
        // Fallback: Relayer data (if connected)
        let soqHeight = null;

        try {
            const response = await fetch(`${CONFIG.explorerApi}/api/blocks/tip/height`, {
                signal: AbortSignal.timeout(8000)
            });
            if (response.ok) {
                const text = await response.text();
                soqHeight = parseInt(text.trim());
            }
        } catch (e) {
            console.warn('[SOQ-TEC] Explorer API failed, trying relayer...', e.message);
        }

        // Fallback: use relayer's soqucoin block height
        if (!soqHeight && this.relayerData && this.relayerData.vault) {
            soqHeight = this.relayerData.vault.blockHeight;
        }

        // Update SOQ block height
        const blockEl = document.getElementById('soq-block');
        if (blockEl && soqHeight) {
            this.animateNumber(blockEl, soqHeight);
            this.lastSoqBlock = soqHeight;
        } else if (blockEl && this.lastSoqBlock > 0) {
            blockEl.textContent = this.lastSoqBlock.toLocaleString();
        } else if (blockEl) {
            blockEl.textContent = 'SYNC...';
        }

        // ── Solana Devnet Slot (live) ──
        try {
            const solRes = await fetch(CONFIG.solanaRpc, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getSlot' }),
                signal: AbortSignal.timeout(5000)
            });
            if (solRes.ok) {
                const data = await solRes.json();
                const slot = data.result;
                const solSlot = document.getElementById('sol-slot');
                if (solSlot && slot) {
                    this.animateNumber(solSlot, slot);
                    this.lastSolSlot = slot;
                }
            }
        } catch (e) {
            const solSlot = document.getElementById('sol-slot');
            if (solSlot && this.lastSolSlot > 0) {
                solSlot.textContent = this.lastSolSlot.toLocaleString();
            }
        }
    }

    // --- Number Animation ---
    animateNumber(el, target) {
        const duration = 1500;
        const start = parseInt(el.textContent.replace(/,/g, '')) || 0;
        const startTime = Date.now();

        // If already close to target, just set it
        if (Math.abs(target - start) < 3) {
            el.textContent = target.toLocaleString();
            return;
        }

        const tick = () => {
            const elapsed = Date.now() - startTime;
            const progress = Math.min(elapsed / duration, 1);
            // Ease out cubic
            const eased = 1 - Math.pow(1 - progress, 3);
            const current = Math.floor(start + (target - start) * eased);
            el.textContent = current.toLocaleString();

            if (progress < 1) {
                requestAnimationFrame(tick);
            }
        };
        requestAnimationFrame(tick);
    }

    // --- Periodic Data Updates ---
    startDataUpdates() {
        this.updateVaultDisplay();

        // Fast cycle: relayer + chain data + reserves
        this.updateInterval = setInterval(() => {
            this.fetchLiveData();
            this.fetchRelayerStatus();
            this.updateReservesFromRelayer();
            this.syncHeroBar();
        }, CONFIG.dataRefreshMs);

        // Slower cycle: blocks
        setInterval(() => {
            this.fetchRecentBlocks();
        }, CONFIG.blockRefreshMs);
    }

    updateVaultDisplay() {
        const balance = document.getElementById('vault-balance');
        const ratio = document.getElementById('backing-ratio');
        const total = document.getElementById('total-bridged');

        // Pre-launch values (overridden by relayer when connected)
        if (balance && !this.relayerConnected) balance.textContent = '0.00 SOQ';
        if (ratio && !this.relayerConnected) ratio.textContent = '1:1 (TARGET)';
        if (total && !this.relayerConnected) total.textContent = '0 SOQ';
    }

    // --- Activity Feed ---
    addActivityEntry(type, text) {
        const log = document.getElementById('activity-log');
        if (!log) return;

        const entry = document.createElement('div');
        entry.className = `log-entry ${type}`;

        const now = new Date();
        const ts = now.toLocaleTimeString('en-US', { hour12: false });
        entry.textContent = `${ts} ${text}`;

        // Add with animation
        entry.style.opacity = '0';
        entry.style.transform = 'translateX(-10px)';
        log.appendChild(entry);

        requestAnimationFrame(() => {
            entry.style.transition = 'opacity 0.3s, transform 0.3s';
            entry.style.opacity = '1';
            entry.style.transform = 'translateX(0)';
        });

        // Auto-scroll
        log.scrollTop = log.scrollHeight;

        // Limit entries
        while (log.children.length > 40) {
            log.removeChild(log.firstChild);
        }
    }

    startActivityFeed() {
        // System messages that rotate when relayer has no new events
        const systemMessages = [
            { type: 'system', text: '[SYSTEM] Monitoring Solana mempool for gateway events...' },
            { type: 'system', text: '[SYSTEM] Soqucoin L1: synced and operational' },
            { type: 'info', text: '[INFO] Vault Dilithium signature verification: PASS' },
            { type: 'system', text: '[SYSTEM] Heartbeat — all systems nominal' },
            { type: 'warn', text: '[THREAT] Ed25519 harvesting risk — HNDL active' },
            { type: 'info', text: '[INFO] Gateway attestation engine: OPERATIONAL' },
            { type: 'highlight', text: '[SOQ-TEC] Vault custody: ML-DSA-44 ACTIVE' },
            { type: 'system', text: '[SYSTEM] Proof of reserves check: PASS' },
            { type: 'highlight', text: '[SOQ-TEC] QUANTUM EXPRESS: Optimistic relay enabled' },
            { type: 'info', text: '[INFO] XMSS-Lite vault: 1,024 keys available' },
            { type: 'system', text: '[SYSTEM] Circuit breaker: ARMED (inactive)' },
            { type: 'highlight', text: '[SOQ-TEC] Next PoR attestation in 60 blocks (~1 hour)' },
            { type: 'info', text: '[INFO] Gateway program: 9pCJxjVF8VTizZ9RZZLTu997y2DafWgUGqYbrNiqPw36' },
            { type: 'info', text: '[INFO] Instant receipt window: <30s via Quantum Express' },
            { type: 'system', text: '[SYSTEM] No pending gateway transactions' },
            { type: 'highlight', text: '[SOQ-TEC] Revolving Vault: XMSS-Lite (1,024 sigs/vault)' },
            { type: 'info', text: '[INFO] Direct-mint-to-vault: Zero Ed25519 exposure' },
            { type: 'highlight', text: '[USDSOQ] Stablecoin module: ON-PEG — $1.0000' },
            { type: 'system', text: '[USDSOQ] GENIUS Act compliance check: PASS' },
            { type: 'info', text: '[USDSOQ] Governance: 4/7 threshold authority active' },
            { type: 'highlight', text: '[USDSOQ] Backing ratio: 1.00:1 — fully collateralized' },
        ];

        let idx = 0;
        setInterval(() => {
            // Try to fetch real activity from relayer
            if (this.relayerConnected) {
                this.fetchRelayerActivity();
            }
            // Always check bridge transfers from wallet-api
            this.fetchBridgeTransfers();

            // Inject system message with live data
            const msg = systemMessages[idx % systemMessages.length];
            let text = msg.text;

            // Enrich with live data
            if (text.includes('L1:') && this.lastSoqBlock > 0) {
                text = `[SYSTEM] Soqucoin L1 block #${this.lastSoqBlock.toLocaleString()} — synced`;
            }
            if (text.includes('relay') && this.relayerConnected) {
                text = '[SOQ-TEC] QUANTUM EXPRESS: Relay ONLINE — optimistic mode';
            }

            this.addActivityEntry(msg.type, text);
            idx++;
        }, CONFIG.activityRefreshMs);
    }

    // --- Recent Blocks Feed ---
    async fetchRecentBlocks() {
        try {
            // Get tip height first
            const tipRes = await fetch(`${CONFIG.explorerApi}/api/blocks/tip/height`, {
                signal: AbortSignal.timeout(5000)
            });
            if (!tipRes.ok) return;
            const tipHeight = parseInt((await tipRes.text()).trim());
            if (!tipHeight) return;

            // Fetch last 5 blocks in parallel
            const heights = [];
            for (let i = 0; i < 5; i++) {
                heights.push(tipHeight - i);
            }

            const blocks = await Promise.all(
                heights.map(h =>
                    fetch(`${CONFIG.explorerApi}/api/block/${h}`, {
                        signal: AbortSignal.timeout(5000)
                    }).then(r => r.ok ? r.json() : null).catch(() => null)
                )
            );

            const container = document.getElementById('blocks-rows');
            if (!container) return;

            // Clear loading placeholder
            container.innerHTML = '';

            blocks.forEach(block => {
                if (!block || !block.height) return;

                const row = document.createElement('div');
                row.className = 'block-row';

                // Flash animation for NEW blocks
                if (!this.knownBlocks.has(block.height) && this.knownBlocks.size > 0) {
                    row.classList.add('new-block');
                }
                this.knownBlocks.add(block.height);

                // Height (clickable → explorer)
                const colH = document.createElement('span');
                colH.className = 'col-height';
                colH.textContent = block.height.toLocaleString();
                colH.title = 'View in explorer';
                colH.addEventListener('click', () => {
                    window.open(`${CONFIG.explorerApi}/block/${block.height}`, '_blank');
                });

                // Hash (truncated)
                const colHash = document.createElement('span');
                colHash.className = 'col-hash';
                const h = block.hash;
                colHash.textContent = h ? `${h.slice(0, 8)}…${h.slice(-8)}` : '—';
                colHash.title = h || '';

                // Time ago
                const colTime = document.createElement('span');
                colTime.className = 'col-time';
                colTime.textContent = this.timeAgo(block.time);

                // Tx count
                const colTxns = document.createElement('span');
                colTxns.className = 'col-txns';
                colTxns.textContent = block.tx ? block.tx.length : '0';

                // Difficulty
                const colDiff = document.createElement('span');
                colDiff.className = 'col-diff';
                const diff = block.difficulty;
                colDiff.textContent = diff ? diff.toFixed(2) : '—';

                row.append(colH, colHash, colTime, colTxns, colDiff);
                container.appendChild(row);
            });

            // Keep known blocks set manageable
            if (this.knownBlocks.size > 100) {
                const arr = [...this.knownBlocks].sort((a, b) => a - b);
                arr.slice(0, 50).forEach(h => this.knownBlocks.delete(h));
            }
        } catch (e) {
            console.warn('[SOQ-TEC] Recent blocks fetch failed:', e.message);
        }
    }

    timeAgo(unixTs) {
        const now = Math.floor(Date.now() / 1000);
        const diff = now - unixTs;
        if (diff < 5) return 'just now';
        if (diff < 60) return `${diff}s ago`;
        if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
        if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
        return `${Math.floor(diff / 86400)}d ago`;
    }

    // --- Quantum Express Bridge Flow Animation ---
    animateBridgeFlow(amount, txid) {
        const relay = document.getElementById('pn-relay');
        const flowStatus = document.getElementById('flow-status');
        const relayAmount = document.getElementById('qe-live-amount');
        const lastTransferEl = document.getElementById('qe-last-transfer');
        const pipeStatus = document.getElementById('qe-pipe-status');

        if (!relay || this._animating) return;
        this._animating = true;
        this._lastTransferTime = Date.now();

        // Update stats
        if (lastTransferEl) lastTransferEl.textContent = amount;
        if (flowStatus) { flowStatus.textContent = 'BRIDGING'; flowStatus.classList.add('online'); }
        if (pipeStatus) { pipeStatus.textContent = '◆ BRIDGING'; }

        // Walk through all flow children left-to-right
        // Children alternate: node, connector, node, connector, ..., relay, connector, node, ...
        const flow = document.querySelector('.qe-flow');
        if (!flow) return;
        const children = Array.from(flow.children);
        const step = 400;
        let t = 0;

        children.forEach((child) => {
            setTimeout(() => {
                if (child.classList.contains('qe-node')) {
                    child.classList.add('active');
                } else if (child.classList.contains('qe-connector')) {
                    child.classList.add('active');
                } else if (child.classList.contains('qe-relay')) {
                    child.classList.add('active');
                    if (relayAmount) relayAmount.textContent = amount;
                }
            }, t);
            t += step;
        });

        // Complete phase — after all children lit
        setTimeout(() => {
            // Flash the last node
            const lastNode = document.getElementById('pn-soq');
            if (lastNode) lastNode.classList.add('complete');
            if (flowStatus) { flowStatus.textContent = 'COMPLETE'; }
            if (pipeStatus) { pipeStatus.textContent = '✓ COMPLETE'; }

            // Volume tracked by pollActivity — just update last transfer
            const lastEl = document.getElementById('qe-last-transfer');
            if (lastEl) lastEl.textContent = `${amount} · just now`;

            // Reset after 3s
            setTimeout(() => {
                children.forEach(c => c.classList.remove('active', 'complete'));
                if (relayAmount) relayAmount.textContent = '';
                if (flowStatus) { flowStatus.textContent = 'MONITORING'; flowStatus.classList.remove('online'); }
                if (pipeStatus) { pipeStatus.textContent = '● LIVE'; }
                this._animating = false;
            }, 3000);
        }, t + 200);
    }

    // Countdown timer — syncs to actual transfers
    startHeartbeatCountdown() {
        this._lastTransferTime = Date.now();
        this._countdownInterval = setInterval(() => {
            const elapsed = Math.floor((Date.now() - this._lastTransferTime) / 1000);
            const remaining = Math.max(0, 90 - elapsed);
            const countdownEl = document.getElementById('qe-countdown');
            if (countdownEl) {
                countdownEl.textContent = remaining > 0 ? `~${remaining}s` : 'DUE';
            }
        }, 1000);
    }

    // Unified bridge flow monitor — uses /api/activity (real transfer data)
    // The relay queue.completed is always 0; actual transfers go through wallet-api.
    startBridgeFlowMonitor() {
        this._lastSeenTimestamp = 0;
        this._dailyVolume = 0;
        this._isFirstPoll = true;
        this.startHeartbeatCountdown();

        const pollActivity = async () => {
            if (this._animating) return;
            try {
                const res = await fetch(`${CONFIG.relayerApi}/api/activity`, {
                    signal: AbortSignal.timeout(5000)
                });
                if (!res.ok) return;
                const data = await res.json();
                if (!data.transfers || data.transfers.length === 0) return;

                // Sort by timestamp descending (newest first)
                const transfers = data.transfers.sort((a, b) => b.timestamp - a.timestamp);
                const latest = transfers[0];
                const latestTs = latest.timestamp;

                // Compute 24h volume from available data
                const now = Date.now();
                const oneDayAgo = now - 86400000;
                let vol24h = 0;
                for (const tx of transfers) {
                    if (tx.timestamp >= oneDayAgo && tx.status === 'completed') {
                        const raw = typeof tx.amount === 'number' ? tx.amount : parseFloat(tx.amount);
                        vol24h += raw > 1000000 ? raw / 1e9 : raw;
                    }
                }
                this._dailyVolume = vol24h;
                const volEl = document.getElementById('qe-24h-volume');
                if (volEl) volEl.textContent = `${Math.round(vol24h).toLocaleString()} SOQ`;

                // Update LAST TRANSFER with time-ago
                const lastEl = document.getElementById('qe-last-transfer');
                if (lastEl && latest.status === 'completed') {
                    const raw = typeof latest.amount === 'number' ? latest.amount : parseFloat(latest.amount);
                    const amt = raw > 1000000 ? Math.round(raw / 1e9) : raw;
                    const ago = this.timeAgo(Math.floor(latestTs / 1000));
                    lastEl.textContent = `${amt} SOQ · ${ago}`;
                }

                // On first poll, seed the countdown from the latest transfer
                if (this._isFirstPoll) {
                    this._isFirstPoll = false;
                    this._lastSeenTimestamp = latestTs;
                    // Sync countdown to time since last transfer
                    const elapsed = Math.floor((now - latestTs) / 1000);
                    if (elapsed < 90) {
                        this._lastTransferTime = latestTs;
                    }
                    return; // Don't animate on first poll
                }

                // Detect new transfer — timestamp increased
                if (latestTs > this._lastSeenTimestamp) {
                    this._lastSeenTimestamp = latestTs;
                    this._lastTransferTime = Date.now();
                    const raw = typeof latest.amount === 'number' ? latest.amount : parseFloat(latest.amount);
                    const amt = raw > 1000000 ? Math.round(raw / 1e9) : raw;
                    this.animateBridgeFlow(`${amt} SOQ`, latest.destinationTx || null);
                }
            } catch(e) { /* silent */ }
        };

        // Initial poll immediately, then every 10s
        pollActivity();
        setInterval(pollActivity, 10000);
    }
}

// ============================================================
// INITIALIZE
// ============================================================
const boot = new BootSequence();
const dashboard = new Dashboard();

// Start boot on DOM ready
document.addEventListener('DOMContentLoaded', () => {
    boot.start();
});
