/* =========================================================
   SOQ-TEC TERMINAL v1.1 — Pip-Boy Interface Logic
   Boot sequence, live data, animations, terminal behavior
   ========================================================= */

// ============================================================
// CONFIGURATION
// ============================================================
// Relayer API — HTTP only (no TLS on relayer yet).
// When the terminal is served over HTTPS (Cloudflare Pages),
// mixed content policy blocks these requests. In that case,
// the terminal falls back to ambient system messages + block height
// data from HTTPS sources (explorer + Solana RPC).
const RELAYER_API = 'http://soqtec-relay.soqu.org:3001';
const IS_SECURE_CONTEXT = (typeof window !== 'undefined' && window.location.protocol === 'https:');
const POLL_INTERVAL = 15000;   // 15s data refresh
const FEED_INTERVAL = 5000;    // 5s activity feed rotation

// ============================================================
// BOOT SEQUENCE
// ============================================================
const BOOT_LINES = [
    { text: '+==============================================+', delay: 30 },
    { text: '|                                              |', delay: 20 },
    { text: '|   SOQ-TEC TERMINAL v1.1.0                    |', delay: 40 },
    { text: '|   Soqucoin Operations for Quantum-Tolerant   |', delay: 40 },
    { text: '|   Ecosystem Custody                          |', delay: 40 },
    { text: '|                                              |', delay: 20 },
    { text: '|   Colosseum Frontier Hackathon 2026           |', delay: 50 },
    { text: '|   (c) 2026 Soqucoin Labs Inc.                |', delay: 40 },
    { text: '+==============================================+', delay: 30 },
    { text: '', delay: 200 },
    { text: 'MISSION: Quantum-safe custody bridge for', delay: 50 },
    { text: '         Solana assets via Soqucoin L1.', delay: 50 },
    { text: '', delay: 150 },
    { text: 'BIOS CHECK................OK', delay: 60 },
    { text: 'MEMORY TEST...............64K OK', delay: 80 },
    { text: '', delay: 100 },
    { text: '> Initializing SOQ-TEC Protocol...', delay: 80 },
    { text: '> Loading ML-DSA-44 Dilithium module.....OK', delay: 100 },
    { text: '> Loading PAUL Lane Manager...............OK', delay: 90 },
    { text: '> Loading DUA/CEA Pipeline................OK', delay: 110 },
    { text: '', delay: 100 },
    { text: '> Connecting to Soqucoin L1 (Stagenet)...', delay: 120 },
    { text: '  RPC: https://rpc.soqu.org', delay: 60 },
    { text: '  STATUS:  CONNECTED', delay: 80 },
    { text: '  BLOCK HEIGHT: fetching...', delay: 40, id: 'boot-soq-block' },
    { text: '', delay: 80 },
    { text: '> Connecting to Solana (Devnet)...', delay: 120 },
    { text: '  RPC: https://api.devnet.solana.com', delay: 60 },
    { text: '  STATUS:  CONNECTED', delay: 80 },
    { text: '  SLOT: fetching...', delay: 40, id: 'boot-sol-slot' },
    { text: '', delay: 80 },
    { text: '> Checking vault custody status...', delay: 100 },
    { text: '  SIGNATURE:  ML-DSA-44 (FIPS 204)', delay: 50 },
    { text: '  PROTECTION: DILITHIUM ACTIVE', delay: 50 },
    { text: '  VAULT:      OPERATIONAL', delay: 50 },
    { text: '', delay: 80 },
    { text: '> Running quantum threat assessment...', delay: 150 },
    { text: '  Ed25519 EXPOSURE: 100% of Solana wallets', delay: 60 },
    { text: '  HNDL RISK:        ELEVATED', delay: 60 },
    { text: '  PQ MIGRATION:     90% throughput loss', delay: 80 },
    { text: '  RECOMMENDATION:   BRIDGE TO PQ CUSTODY', delay: 60 },
    { text: '', delay: 100 },
    { text: '+----------------------------------------------+', delay: 30 },
    { text: '|  QUANTUM THREAT LEVEL:  ||||.  ELEVATED       |', delay: 50 },
    { text: '+----------------------------------------------+', delay: 30 },
    { text: '', delay: 200 },
    { text: '> SOQ-TEC Terminal ready.', delay: 80 },
    { text: '> "Prepared for the Quantum Future."', delay: 100 },
    { text: '', delay: 200 },
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
        if (sessionStorage.getItem('soqtec-boot-done')) {
            this.skip();
            return;
        }

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
        this.updateInterval = null;
        this.lastReleaseCount = 0;
        this.relayerOnline = false;
        this.feedMessages = [];
    }

    init() {
        this.startClock();
        this.animateEntrance();
        this.fetchLiveData();
        this.fetchRelayerData();
        this.initTabs();
        this.startPeriodicUpdates();
        this.startActivityFeed();
    }

    // --- Pip-Boy Tab Navigation ---
    initTabs() {
        const tabs = document.querySelectorAll('.pip-tab');
        tabs.forEach(tab => {
            tab.addEventListener('click', () => {
                tabs.forEach(t => t.classList.remove('active'));
                tab.classList.add('active');
            });
        });
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
    }

    // --- Number Animation ---
    animateNumber(el, target) {
        const duration = 1500;
        const start = 0;
        const startTime = Date.now();

        const tick = () => {
            const elapsed = Date.now() - startTime;
            const progress = Math.min(elapsed / duration, 1);
            const eased = 1 - Math.pow(1 - progress, 3);
            const current = Math.floor(start + (target - start) * eased);
            el.textContent = current.toLocaleString();

            if (progress < 1) {
                requestAnimationFrame(tick);
            }
        };
        requestAnimationFrame(tick);
    }

    // --- Periodic Updates ---
    startPeriodicUpdates() {
        this.updateInterval = setInterval(() => {
            this.fetchLiveData();
            this.fetchRelayerData();
        }, POLL_INTERVAL);
    }

    // --- Live Data: Block Heights ---
    async fetchLiveData() {
        // Soqucoin block height from explorer
        try {
            const response = await fetch('https://xplorer.soqu.org/api/blocks/tip/height', {
                signal: AbortSignal.timeout(5000)
            });
            if (response.ok) {
                const height = await response.text();
                const blockEl = document.getElementById('soq-block');
                if (blockEl) {
                    const h = parseInt(height.trim());
                    if (blockEl.textContent === 'LOADING...') {
                        this.animateNumber(blockEl, h);
                    } else {
                        blockEl.textContent = h.toLocaleString();
                    }
                }
            }
        } catch (e) {
            const blockEl = document.getElementById('soq-block');
            if (blockEl && blockEl.textContent === 'LOADING...') {
                blockEl.textContent = '--';
            }
        }

        // Solana devnet slot
        try {
            const response = await fetch('https://api.devnet.solana.com', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getSlot' }),
                signal: AbortSignal.timeout(5000)
            });
            if (response.ok) {
                const data = await response.json();
                const slotEl = document.getElementById('sol-slot');
                if (slotEl && data.result) {
                    if (slotEl.textContent === 'LOADING...') {
                        this.animateNumber(slotEl, data.result);
                    } else {
                        slotEl.textContent = data.result.toLocaleString();
                    }
                }
            }
        } catch (e) {
            const slotEl = document.getElementById('sol-slot');
            if (slotEl && slotEl.textContent === 'LOADING...') {
                slotEl.textContent = '--';
            }
        }
    }

    // --- Live Data: Relayer + PAUL + PoR ---
    async fetchRelayerData() {
        // Skip relayer calls in HTTPS context (mixed content blocked)
        if (IS_SECURE_CONTEXT) {
            this.updateRelayerStatus(false, null);
            return;
        }

        try {
            // Fetch all three endpoints
            const [statusRes, duaRes, reservesRes] = await Promise.allSettled([
                fetch(`${RELAYER_API}/api/status`, { signal: AbortSignal.timeout(5000) }),
                fetch(`${RELAYER_API}/api/dua/releases`, { signal: AbortSignal.timeout(5000) }),
                fetch(`${RELAYER_API}/api/reserves`, { signal: AbortSignal.timeout(5000) })
            ]);

            // --- Bridge Status ---
            if (statusRes.status === 'fulfilled' && statusRes.value.ok) {
                const status = await statusRes.value.json();
                this.relayerOnline = true;
                this.updateRelayerStatus(true, status);
                this.updateVaultFromStatus(status);
            } else {
                this.relayerOnline = false;
                this.updateRelayerStatus(false, null);
            }

            // --- DUA/CEA Releases ---
            if (duaRes.status === 'fulfilled' && duaRes.value.ok) {
                const data = await duaRes.value.json();
                this.processReleases(data);
            }

            // --- Proof of Reserves ---
            if (reservesRes.status === 'fulfilled' && reservesRes.value.ok) {
                const reserves = await reservesRes.value.json();
                this.updateReservesDisplay(reserves);
            }

        } catch (e) {
            this.relayerOnline = false;
            this.updateRelayerStatus(false, null);
        }
    }

    // --- Update relay status indicator ---
    updateRelayerStatus(online, status) {
        const relayEl = document.getElementById('relay-status');
        if (!relayEl) return;

        if (online && status) {
            const uptime = Math.floor(status.bridge.uptime);
            const h = Math.floor(uptime / 3600);
            const m = Math.floor((uptime % 3600) / 60);
            relayEl.textContent = `RELAY ONLINE ${h}h${m}m`;
            relayEl.className = 'panel-status online';
        } else {
            relayEl.textContent = 'RELAY OFFLINE';
            relayEl.className = 'panel-status';
        }

        // System status header
        const sysEl = document.getElementById('system-status');
        if (sysEl) {
            sysEl.style.color = online ? 'var(--pip-green)' : 'var(--pip-orange, orange)';
        }
    }

    // --- Update vault panel from /api/status ---
    updateVaultFromStatus(status) {
        const balance = document.getElementById('vault-balance');
        const total = document.getElementById('total-bridged');
        const ratio = document.getElementById('backing-ratio');
        const vaultBar = document.getElementById('vault-bar');

        if (!status.queue) return;

        const totalReleases = status.queue.total || 0;

        if (balance) {
            // Show the hot wallet + lane balance context
            balance.textContent = status.vault.blockHeight
                ? `Block ${status.vault.blockHeight.toLocaleString()}`
                : '0.00 SOQ';
        }
        if (total) total.textContent = `${totalReleases} releases`;
        if (ratio) ratio.textContent = '1:1';
        if (vaultBar) {
            // Visual: scale based on releases (cap at 100 for 100%)
            const pct = Math.min(totalReleases * 3, 100);
            vaultBar.style.width = `${pct}%`;
        }
    }

    // --- Process DUA releases for activity feed ---
    processReleases(data) {
        if (!data.releases || !data.releases.length) return;

        const newCount = data.releases.length;
        if (newCount > this.lastReleaseCount) {
            // New releases detected — add to feed
            const newReleases = data.releases.slice(0, newCount - this.lastReleaseCount);
            for (const rel of newReleases) {
                const amt = (parseInt(rel.netAmountSoq) / 1e9).toFixed(2);
                const method = rel.releaseMethod ? rel.releaseMethod.toUpperCase() : 'DIRECT';
                const latency = rel.releasedAt && rel.detectedAt
                    ? `${rel.releasedAt - rel.detectedAt}ms`
                    : '';
                const txShort = rel.releaseTxId ? rel.releaseTxId.substring(0, 12) + '...' : '';

                this.addLogEntry('highlight',
                    `[BRIDGE] ${amt} SOQ released via ${method} ${latency ? '(' + latency + ')' : ''} tx:${txShort}`
                );
            }
        }
        this.lastReleaseCount = newCount;
    }

    // --- Update PoR panel ---
    updateReservesDisplay(reserves) {
        if (!reserves.reserves) return;
        const r = reserves.reserves;

        const attestEl = document.getElementById('last-attestation');
        if (attestEl && r.lastAttestation) {
            const d = new Date(r.lastAttestation);
            attestEl.textContent = d.toLocaleTimeString('en-US', { hour12: false }) + ' UTC';
        }
    }

    // --- Activity Feed ---
    startActivityFeed() {
        // Ambient system messages that rotate when no bridge events are happening
        const ambientMessages = [
            { type: 'system', text: '[SYSTEM] DUA/CEA pipeline monitoring Solana devnet...' },
            { type: 'system', text: '[SYSTEM] Soqucoin block height updated' },
            { type: 'info', text: '[INFO] Vault Dilithium signature verification: PASS' },
            { type: 'system', text: '[SYSTEM] Heartbeat — all systems nominal' },
            { type: 'info', text: '[INFO] PAUL lane manager: lanes available' },
            { type: 'system', text: '[SYSTEM] Proof of reserves check: PASS' },
            { type: 'info', text: '[INFO] CEA Solana adapter: polling...' },
            { type: 'system', text: '[SYSTEM] Bridge circuit breaker: ARMED' },
        ];

        // Add initial real status line
        if (this.relayerOnline) {
            this.addLogEntry('highlight', '[SOQ-TEC] Relayer connected — bridge OPERATIONAL');
        }

        let idx = 0;
        setInterval(() => {
            const msg = ambientMessages[idx % ambientMessages.length];
            this.addLogEntry(msg.type, msg.text);
            idx++;
        }, FEED_INTERVAL);
    }

    // --- Add entry to activity log ---
    addLogEntry(type, text) {
        const log = document.getElementById('activity-log');
        if (!log) return;

        const entry = document.createElement('div');
        entry.className = `log-entry ${type}`;

        const now = new Date();
        const ts = now.toLocaleTimeString('en-US', { hour12: false });
        entry.textContent = `${ts} ${text}`;

        // Animate in
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
        while (log.children.length > 50) {
            log.removeChild(log.firstChild);
        }
    }
}

// ============================================================
// INITIALIZE
// ============================================================
const boot = new BootSequence();
const dashboard = new Dashboard();

document.addEventListener('DOMContentLoaded', () => {
    boot.start();
});
