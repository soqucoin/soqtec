# Contributing to SOQ-TEC

Thank you for your interest in contributing to SOQ-TEC!

## Project Structure

```
soqtec/
├── programs/soqtec-bridge/   # Solana Anchor program (Rust)
│   └── src/lib.rs            # Bridge instructions & state
├── relayer/                  # Cross-chain relayer (TypeScript)
│   └── src/
│       ├── index.ts          # Entry point
│       ├── config.ts         # Configuration
│       ├── queue.ts          # Transfer queue
│       ├── api.ts            # REST API for dashboard
│       └── watchers/         # Chain watchers
│           ├── solana.ts     # Solana event monitor
│           └── soqucoin.ts   # Soqucoin vault monitor
├── tests/                    # Anchor integration tests
├── scripts/                  # Deployment scripts
├── docs/                     # Architecture & protocol docs
│   ├── ARCHITECTURE.md
│   ├── SECURITY.md
│   └── BRIDGE_SPEC.md
└── index.html + style.css + script.js  # Terminal dashboard
```

## Development Setup

### Prerequisites

- [Rust](https://rustup.rs/) (latest stable)
- [Anchor CLI](https://www.anchor-lang.com/docs/installation) (v0.30+)
- [Solana CLI](https://docs.solana.com/cli/install-solana-cli-tools) (v1.18+)
- [Node.js](https://nodejs.org/) (v20+)
- A running Soqucoin testnet3 node (optional, for full integration)

### Build Bridge Program

```bash
anchor build
```

### Run Tests

```bash
anchor test
```

### Start Relayer (Development)

```bash
cd relayer
cp .env.example .env   # Edit with your values
npm install
npm run dev
```

### Deploy Terminal Dashboard

```bash
./scripts/deploy-terminal.sh "your commit message"
```

## Security

SOQ-TEC handles cross-chain value transfer. All contributions touching:
- Bridge program instructions
- Validator signing logic
- Transaction construction

...require review by at least 2 maintainers. See [SECURITY.md](docs/SECURITY.md) for the threat model.

## Code Style

- **Rust**: `cargo fmt` and `cargo clippy`
- **TypeScript**: Strict mode, ESLint
- **Commits**: Conventional commits (`feat:`, `fix:`, `docs:`, `test:`)

## License

MIT — see [LICENSE](LICENSE)
