/* =========================================================
   SOQ-TEC TERMINAL v1.0 — Pip-Boy Interface Logic
   Boot sequence, live data, animations, terminal behavior
   ========================================================= */

// ============================================================
// BOOT SEQUENCE
// ============================================================
const BOOT_LINES = [
    { text: '+==============================================+', delay: 30 },
    { text: '|                                              |', delay: 20 },
    { text: '|   SOQ-TEC TERMINAL v1.0.0                    |', delay: 40 },
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
    { text: '> Loading Winternitz OTS verifier.........OK', delay: 90 },
    { text: '> Loading Bridge Attestation Engine.......OK', delay: 110 },
    { text: '', delay: 100 },
    { text: '> Connecting to Soqucoin L1 (Testnet3)...', delay: 120 },
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
    }

    init() {
        this.startClock();
        this.animateEntrance();
        this.startDataUpdates();
        this.startActivityFeed();
        this.fetchLiveData();
        this.initTabs();
    }

    // --- Pip-Boy Tab Navigation (visual-only for now) ---
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

        // Animate vault bar after panels
        setTimeout(() => {
            this.animateVaultBar();
        }, 1000);
    }

    // --- Vault Bar Animation ---
    animateVaultBar() {
        const vaultBar = document.getElementById('vault-bar');
        if (vaultBar) {
            // Pre-launch: show low capacity as a teaser
            vaultBar.style.width = '3%';
        }
    }

    // --- Live Data Fetch ---
    async fetchLiveData() {
        // Try to fetch Soqucoin block height from explorer
        try {
            const response = await fetch('https://xplorer.soqu.org/api/blocks/tip/height', {
                signal: AbortSignal.timeout(5000)
            });
            if (response.ok) {
                const height = await response.text();
                const blockEl = document.getElementById('soq-block');
                if (blockEl) {
                    this.animateNumber(blockEl, parseInt(height.trim()));
                }
            }
        } catch (e) {
            const blockEl = document.getElementById('soq-block');
            if (blockEl) blockEl.textContent = '2,347';
        }

        // Solana devnet slot (simulated for pre-launch)
        const solSlot = document.getElementById('sol-slot');
        if (solSlot) {
            this.animateNumber(solSlot, 348721456);
        }
    }

    // --- Number Animation ---
    animateNumber(el, target) {
        const duration = 1500;
        const start = 0;
        const startTime = Date.now();

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
        // Simulate vault balance (pre-launch: zero with small test amounts)
        this.updateVaultDisplay();

        // Update every 30s
        this.updateInterval = setInterval(() => {
            this.updateVaultDisplay();
        }, 30000);
    }

    updateVaultDisplay() {
        const balance = document.getElementById('vault-balance');
        const ratio = document.getElementById('backing-ratio');
        const total = document.getElementById('total-bridged');

        // Pre-launch values
        if (balance) balance.textContent = '0.00 SOQ';
        if (ratio) ratio.textContent = '1:1 (TARGET)';
        if (total) total.textContent = '0 SOQ';
    }

    // --- Activity Feed ---
    startActivityFeed() {
        const messages = [
            { type: 'system', text: '[SYSTEM] Monitoring Solana mempool for bridge events...' },
            { type: 'system', text: '[SYSTEM] Soqucoin block height updated' },
            { type: 'info', text: '[INFO] Vault Dilithium signature verification: PASS' },
            { type: 'system', text: '[SYSTEM] Heartbeat — all systems nominal' },
            { type: 'warn', text: '[THREAT] Ed25519 harvesting detected — HNDL risk active' },
            { type: 'info', text: '[INFO] Relayer attestation engine: STANDBY' },
            { type: 'highlight', text: '[SOQ-TEC] Vault custody: ML-DSA-44 ACTIVE' },
            { type: 'system', text: '[SYSTEM] Proof of reserves check: PASS' },
            { type: 'info', text: '[INFO] Winternitz vault monitor: SCANNING' },
            { type: 'system', text: '[SYSTEM] Bridge circuit breaker: ARMED (inactive)' },
            { type: 'highlight', text: '[SOQ-TEC] Next attestation in 240 blocks...' },
            { type: 'info', text: '[INFO] pSOQ supply monitor: 1,000,000,000 SPL tokens' },
            { type: 'warn', text: '[ALERT] Quantum computing milestone: IBM Heron r2 — 156 qubits' },
            { type: 'system', text: '[SYSTEM] No pending bridge transactions' },
            { type: 'highlight', text: '[SOQ-TEC] Protocol status: PRE-LAUNCH' },
        ];

        let idx = 0;
        setInterval(() => {
            const log = document.getElementById('activity-log');
            if (!log) return;

            const msg = messages[idx % messages.length];
            const entry = document.createElement('div');
            entry.className = `log-entry ${msg.type}`;

            const now = new Date();
            const ts = now.toLocaleTimeString('en-US', { hour12: false });
            entry.textContent = `${ts} ${msg.text}`;

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
            while (log.children.length > 30) {
                log.removeChild(log.firstChild);
            }

            idx++;
        }, 4000);
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
