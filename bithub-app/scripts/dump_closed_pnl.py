#!/usr/bin/env python3
"""dump_closed_pnl.py — gera dump JSON de /v5/position/closed-pnl da Bybit.

Operador roda 1× para feed do backfill-fees-from-bybit.mjs. Read-only:
não cria ordens, não mexe em posição. Credenciais carregadas de
bybit_keys.json (mesma fonte do monitor) e NUNCA ecoam em stdout/log.

Uso:
    python3 dump_closed_pnl.py [--hours 48] [--out /tmp/bybit-round2-closed-pnl.json]
"""
import argparse
import json
import sys
import time
from pathlib import Path

KEYS_PATH = Path("/Users/gabrielcasarin/Documents/Project Trading Agora Vai/freqtrade/user_data/bybit_keys.json")
DEFAULT_OUT = Path("/tmp/bybit-round2-closed-pnl.json")

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--hours", type=int, default=48, help="quantas horas pra trás (default 48)")
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    args = parser.parse_args()

    if not KEYS_PATH.exists():
        print(f"ERR: keys file não encontrado em {KEYS_PATH}", file=sys.stderr)
        return 2

    keys = json.loads(KEYS_PATH.read_text())
    api_key = keys.get("api_key") or keys.get("apiKey") or keys.get("key")
    api_secret = keys.get("api_secret") or keys.get("apiSecret") or keys.get("secret")
    if not api_key or not api_secret:
        print(f"ERR: keys file sem api_key/api_secret. Keys: {list(keys.keys())}", file=sys.stderr)
        return 2

    try:
        from pybit.unified_trading import HTTP
    except ImportError:
        print("ERR: pybit não instalado. pip install pybit", file=sys.stderr)
        return 2

    client = HTTP(testnet=False, api_key=api_key, api_secret=api_secret)

    end_ms = int(time.time() * 1000)
    start_ms = end_ms - args.hours * 60 * 60 * 1000

    print(f"Range: {args.hours}h → start={start_ms} end={end_ms}", file=sys.stderr)

    all_rows = []
    cursor = ""
    page = 0
    while True:
        page += 1
        kwargs = {
            "category": "linear",
            "startTime": start_ms,
            "endTime": end_ms,
            "limit": 100,
        }
        if cursor:
            kwargs["cursor"] = cursor
        resp = client.get_closed_pnl(**kwargs)
        result = resp.get("result", {})
        rows = result.get("list", [])
        all_rows.extend(rows)
        cursor = result.get("nextPageCursor", "")
        print(f"  page {page}: +{len(rows)} rows (cursor={cursor[:20] + '...' if cursor else '<end>'})", file=sys.stderr)
        if not cursor or not rows:
            break
        if page > 50:
            print("WARN: stopping at page 50 (safety)", file=sys.stderr)
            break

    args.out.write_text(json.dumps({"rows": all_rows}, indent=2))
    print(f"\nDumped {len(all_rows)} rows → {args.out}", file=sys.stderr)

    # Sumário (não printa nenhuma credencial, só counts)
    by_sym = {}
    total_net = 0.0
    total_fee = 0.0
    for r in all_rows:
        sym = r.get("symbol", "?")
        by_sym[sym] = by_sym.get(sym, 0) + 1
        try:
            total_net += float(r.get("closedPnl", 0))
            total_fee += float(r.get("cumExecFee", 0))
        except (TypeError, ValueError):
            pass
    print(f"Total net (Bybit closedPnl): ${total_net:.4f}", file=sys.stderr)
    print(f"Total fees:                   ${total_fee:.4f}", file=sys.stderr)
    print(f"Símbolos únicos: {len(by_sym)}", file=sys.stderr)
    return 0

if __name__ == "__main__":
    sys.exit(main())
