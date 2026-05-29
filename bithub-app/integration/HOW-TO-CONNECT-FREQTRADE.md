# Conectando o Freqtrade ao Bithub

Como ligar o `monitor_all.py` (do projeto `Project Trading Agora Vai/freqtrade`) ao Bithub UI sem **expor credenciais Bybit**.

## Arquitetura

```
monitor_all.py  ─── escreve JSON ───→  ~/.bithub-monitor/
       (sem rede)                         positions.json
                                          candidates.json
                                          system.json
                                          events.jsonl
                                            │
                                            │  Bithub lê
                                            ▼
                                       bithub-app (Next.js)
                                       /api/monitor/*
```

**Princípios:**
- Bithub **lê filesystem local**. Nenhuma rede entre Freqtrade e Bithub.
- Credencial Bybit fica **só** no Freqtrade — Bithub nunca a vê.
- Defesa em profundidade: as routes do Bithub fazem sweep de credencial em cada leitura. Se algo credencial-shape aparecer, refusa servir.

---

## Passo 1 — Adicionar `bithub_state_publisher.py` no Freqtrade

Crie `Project Trading Agora Vai/freqtrade/user_data/bithub_state_publisher.py`:

```python
"""
bithub_state_publisher — exporta estado do monitor para o Bithub UI.

Opt-in via env var BITHUB_STATE_DIR. Sem efeito se a var não estiver
definida. Escreve JSONs atômicos (tmp + rename) num diretório local.

Bithub UI lê esses arquivos via API routes Next.js. Nunca rede.
"""
from __future__ import annotations

import json
import os
import re
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

# Mesmo regex do cockpit-tail/publisher Phase 1.
_SENSITIVE_KEY = re.compile(
    r"(?:^|_)(?:api_?key|secret|password|passphrase|token|signature|"
    r"private_key|priv_key|bearer|auth|cookie|session_id)(?:_|$)",
    re.IGNORECASE,
)


def _enabled() -> Path | None:
    raw = os.environ.get("BITHUB_STATE_DIR")
    if not raw:
        return None
    p = Path(os.path.expanduser(raw))
    p.mkdir(parents=True, exist_ok=True)
    return p


def _strip(value: Any) -> Any:
    """Remove qualquer chave com cara de credencial recursivamente."""
    if isinstance(value, dict):
        return {k: _strip(v) for k, v in value.items() if not _SENSITIVE_KEY.search(k or "")}
    if isinstance(value, list):
        return [_strip(v) for v in value]
    return value


def _atomic_write(path: Path, data: Any) -> None:
    payload = json.dumps(_strip(data), separators=(",", ":"), default=str)
    with tempfile.NamedTemporaryFile("w", dir=path.parent, delete=False, encoding="utf-8") as tf:
        tf.write(payload)
        tmp = tf.name
    os.replace(tmp, path)


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def publish_positions(open_positions: dict[str, dict], max_slots: int = 4) -> None:
    state_dir = _enabled()
    if not state_dir:
        return
    positions = []
    for sym, p in open_positions.items():
        current = p.get("current_price") or p.get("last_price") or p["entry"]
        positions.append({
            "symbol": sym,
            "side": p["side"],
            "entry": float(p["entry"]),
            "current_price": float(current),
            "sl": float(p.get("sl", 0)),
            "tp": float(p.get("tp", 0)),
            "qty": float(p.get("qty", 0)),
            "pnl_pct": float(p.get("pnl_pct", 0)),
            "best_pnl_pct": float(p.get("best_pnl", 0)),
            "size_usd": float(p.get("size_usd", 0)),
            "leverage": int(p.get("leverage", 10)),
            "momentum_state": str(p.get("momentum_state", "NORMAL")),
            "tape_bias": int(p.get("tape_bias", 0)),
            "tape_flow_pct": int(p.get("tape_flow_pct", 50)),
            "tape_delta_trend": str(p.get("tape_delta_trend", "ESTAVEL")),
            "be_set": bool(p.get("be_set", False)),
            "partial_done": bool(p.get("partial_done", False)),
            "tp_extended": bool(p.get("tp_extended", False)),
            "opened_at": str(p.get("opened_at", _now_iso())),
        })
    _atomic_write(state_dir / "positions.json", {
        "as_of": _now_iso(),
        "open_count": len(positions),
        "max_slots": max_slots,
        "positions": positions,
    })


def publish_candidates(candidates_with_t2: list[dict], last_t1_ts: str | None, last_t2_ts: str | None) -> None:
    state_dir = _enabled()
    if not state_dir:
        return
    _atomic_write(state_dir / "candidates.json", {
        "as_of": _now_iso(),
        "last_t1_scan_ts": last_t1_ts,
        "last_t2_scan_ts": last_t2_ts,
        "candidates": candidates_with_t2,
    })


def publish_system(*, balance_usdt: float, free_usdt: float, open_slots: int,
                   max_slots: int, ws_status: str, alerts: list[dict] | None = None) -> None:
    state_dir = _enabled()
    if not state_dir:
        return
    _atomic_write(state_dir / "system.json", {
        "as_of": _now_iso(),
        "balance_usdt": float(balance_usdt),
        "free_usdt": float(free_usdt),
        "open_slots": int(open_slots),
        "max_slots": int(max_slots),
        "ws_private_status": ws_status,
        "last_heartbeat_ts": _now_iso(),
        "alerts": alerts or [],
    })


def append_event(symbol: str, event_type: str, detail: str, pnl_realized: float | None = None) -> None:
    state_dir = _enabled()
    if not state_dir:
        return
    record = {
        "ts": _now_iso(),
        "symbol": symbol,
        "event_type": event_type,
        "detail": detail,
    }
    if pnl_realized is not None:
        record["pnl_realized"] = float(pnl_realized)
    record = _strip(record)
    with (state_dir / "events.jsonl").open("a", encoding="utf-8") as f:
        f.write(json.dumps(record, separators=(",", ":"), default=str) + "\n")
```

---

## Passo 2 — Hook 2 chamadas no `monitor_all.py`

Adicione no topo:

```python
try:
    from bithub_state_publisher import (
        publish_positions, publish_candidates, publish_system, append_event,
    )
    BITHUB_PUBLISH = True
except ImportError:
    BITHUB_PUBLISH = False
```

No loop principal (após `manage_positions`):

```python
if BITHUB_PUBLISH:
    publish_positions(OPEN_POSITIONS, max_slots=MAX_SLOTS)
    publish_system(
        balance_usdt=balance_total,
        free_usdt=balance_free,
        open_slots=len(OPEN_POSITIONS),
        max_slots=MAX_SLOTS,
        ws_status="connected" if WS_OK else "down",
    )
```

Após T1+T2 scan:

```python
if BITHUB_PUBLISH:
    publish_candidates(
        candidates_with_t2,
        last_t1_ts=str(_t1_last_iso),
        last_t2_ts=str(_t2_last_iso),
    )
```

Nos pontos de evento (entry, exit, trail, partial):

```python
if BITHUB_PUBLISH:
    append_event(sym, "ENTRY", f"score {r.score} tape {r.tape_conf:.2f}")
    # ...
    append_event(sym, "TRAIL", f"SL {old_sl:.4f} → {new_sl:.4f}")
    # ...
    append_event(sym, "EXIT_FULL", f"reason={reason} pnl={pnl:.2f}%", pnl_realized=pnl)
```

---

## Passo 3 — Rodar

Em um terminal (no projeto Freqtrade):

```bash
cd "Project Trading Agora Vai/freqtrade"
export BITHUB_STATE_DIR="$HOME/.bithub-monitor"
python user_data/monitor_all.py
```

Em outro terminal (no Bithub app):

```bash
cd "Bithub Project/bithub-app"
pnpm dev
# abre http://127.0.0.1:3000
```

`/cockpit`, `/cyclical` e `/launcher` passam a mostrar estado real do monitor.

---

## Dry-run sem o monitor

Enquanto não quiser ligar o monitor real, use o fake publisher:

```bash
cd "Bithub Project/bithub-app"
node scripts/fake-publisher.mjs            # tick 5s
# ou:
node scripts/fake-publisher.mjs --tick 2   # tick 2s, mais ágil
```

Ele escreve no mesmo `~/.bithub-monitor/` simulando posições, candidatos, sistema e eventos. Bithub UI responde igual.

---

## Hard stops mantidos

1. **Bithub nunca chama Bybit privada.** Toda info de conta (balance, positions, orders) vem do monitor via filesystem.
2. **Bithub não envia ordens.** O Launcher hoje é UI-only (registra no audit log local). Próximo handoff (`H-STRATEGY-LAUNCHER-001`) adicionará canal de escrita reverso (Bithub → Freqtrade) com payload restrito a `{strategy_id}`.
3. **Sweep de credencial em cada leitura.** Se `bithub_state_publisher.py` regredir e tentar escrever uma key, a API route do Bithub refusa servir.
4. **Credencial Bybit fica em `bybit_keys.json` e `config.json` no Freqtrade**, gitignored. Bithub não as toca.

---

## Schemas

Ver `bithub-app/src/types/monitor.ts` — fonte da verdade dos shapes JSON.

| Arquivo | Schema | Atualização |
|---|---|---|
| `positions.json` | `PositionsFile` | A cada ciclo do `manage_positions` (~ a cada 1s) |
| `candidates.json` | `CandidatesFile` | A cada T2 scan (~ a cada 45s) |
| `system.json` | `SystemFile` | A cada ciclo de gestão (~ a cada 1s) |
| `events.jsonl` | `MonitorEvent` per line | Append-only, em cada evento |
