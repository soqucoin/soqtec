# BTCSOQ consensus board — setup

## For Bill (the booth): one URL, nothing to run

Open Chrome, go to:

```
https://soqtec.soqu.org/flow.html
```

Press F11 for fullscreen. That is the entire setup. The boundary line and the
live consensus supply are both on that one page. If anything ever looks wrong,
reload the page.

Behind it (already running, nothing for the booth to do): the consensus loop
runs as `btcsoq-consensus-demo.service` on the Services VPS (systemd
auto-restarts it, recycles daily), and nginx serves its status at
`/api/btc/consensus-status` without touching the demo relayer. If that feed is
ever down, the page automatically shows an honest snapshot instead of a blank
panel — Bill never sees a broken board.

Everything below is for operators, not the booth.

---

## Fully offline backup (no wifi at all)

On a machine with the node binary (the build VPS, or any Linux box):

```
./start-consensus-board.sh
```

It prints one URL. Open it, press F11. The standalone consensus board goes
live in about a minute; Ctrl-C stops everything. (This standalone board needs
no network; the hosted flow.html boundary-line data does.)

---

## Skeptic wants to use their own Bitcoin

After they send testnet4 coins to a boundary address, in another terminal:

```
echo '<btc_txid> <vout> <sats>' > .live/request.txt
```

The next cycle mints BTCSOQ bound to that exact deposit and the board flags it
as a real testnet4 deposit. That is the honest Tier-A flow.

---

## What it actually is (for your own confidence)

`start-consensus-board.sh` runs the consensus lifecycle loop (a real node
enforcing BTCSOQ supply on an isolated regtest chain: mint bound to a Bitcoin
deposit, transfer, redeem, every block checked by ConnectBlock) and serves the
board plus its live data from one local web server. Nothing touches the live
overlay pilot or the demo stagenet. It is the real consensus code, audit-gated
and dormant on mainnet.

---

## Options you probably do not need

- **On the Mac mini / Dell (no Linux box):** run it under Docker so the Linux
  node binary runs locally, then open the URL. (Ask for the one-line Docker
  command if you want this path.)
- **Fold into the hosted flow.html instead of the standalone board:** flow.html
  already carries the consensus panel. It polls `/api/btc/consensus-status` by
  default, or `?consensus=<url>`. To feed the hosted board, add the small
  relayer endpoint (below) reading the loop's status file, run the loop on the
  Services VPS, and `wrangler pages deploy ./soqu-web/soqtec
  --project-name=soqtec --branch=main`. Use this only if you want the boundary
  line and the consensus supply on the same hosted page.

  ```ts
  // relayer/src/btcsoq/api.ts — GET /api/btc/consensus-status
  router.get('/consensus-status', (_req, res) => {
    try {
      const p = process.env.BTCSOQ_CONSENSUS_STATUS || '/var/lib/btcsoq-demo/status.json';
      res.type('application/json').send(fs.readFileSync(p, 'utf8'));
    } catch { res.status(204).end(); }  // no feed -> flow.html keeps the panel hidden
  });
  ```

- **Network:** the standalone board (`start-consensus-board.sh`) needs no
  network. The hosted flow.html board needs network for the boundary-line data
  (phone hotspot is the backup, same as the rest of the demo).
