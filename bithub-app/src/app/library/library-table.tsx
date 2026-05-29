"use client";
import { useMemo, useState } from "react";
import {
  ColumnDef,
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  SortingState,
  useReactTable,
} from "@tanstack/react-table";
import { ArrowUpDown, ChevronRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Card, CardContent } from "@/components/ui/card";
import { formatPct, pnlClass, timeAgo } from "@/lib/utils";
import { StrategyDetail } from "./strategy-detail";

interface Strategy {
  id: string;
  name: string;
  regime: string;
  timeframe: string;
  pair_universe: string[];
  sharpe: number;
  win_rate_pct: number;
  total_return_pct: number;
  max_dd_pct: number;
  trade_count: number;
  last_backtest_ts: string;
  freqtrade_version: string;
  tags: string[];
  content_hash: string;
  status?: string;
  collection_mode?: string;
  readiness?: string;
  hypothesis?: string;
  entry_model?: {
    bias?: string;
    anchor?: string;
    ttl_sec?: number;
    volume_min?: number;
    score_min?: number;
  };
  routing_features?: string[];
  is_active?: number;
  activated_at?: string | null;
  activated_by?: string | null;
}

const REGIMES = ["scalp", "swing", "position", "fade"] as const;
const MODES = ["shadow", "paper", "live_canary", "live", "backtest"] as const;

export function LibraryTable({ data }: { data: Strategy[] }) {
  const [sorting, setSorting] = useState<SortingState>([{ id: "sharpe", desc: true }]);
  const [search, setSearch] = useState("");
  const [activeRegimes, setActiveRegimes] = useState<Set<string>>(new Set());
  const [activeModes, setActiveModes] = useState<Set<string>>(new Set());
  const [minSharpe, setMinSharpe] = useState("");
  const [selected, setSelected] = useState<Strategy | null>(null);

  const filtered = useMemo(() => {
    return data.filter((s) => {
      if (
        search &&
        !s.name.toLowerCase().includes(search.toLowerCase()) &&
        !s.tags.some((t) => t.toLowerCase().includes(search.toLowerCase())) &&
        !(s.hypothesis ?? "").toLowerCase().includes(search.toLowerCase())
      ) return false;
      if (activeRegimes.size > 0 && !activeRegimes.has(s.regime)) return false;
      if (activeModes.size > 0 && !activeModes.has(s.collection_mode ?? "backtest")) return false;
      if (minSharpe && s.sharpe < parseFloat(minSharpe)) return false;
      return true;
    });
  }, [data, search, activeRegimes, activeModes, minSharpe]);

  const columns = useMemo<ColumnDef<Strategy>[]>(
    () => [
      {
        id: "name",
        accessorKey: "name",
        header: "Strategy",
        cell: ({ row }) => (
          <div className="space-y-0.5 min-w-0">
            <div className="text-xs font-medium text-foreground truncate">{row.original.name}</div>
            <div className="flex items-center gap-1.5 flex-wrap">
              <Badge variant="outline">{row.original.regime}</Badge>
              <Badge variant={row.original.status === "deprecated" ? "rose" : row.original.collection_mode === "shadow" ? "muted" : "outline"}>
                {row.original.collection_mode ?? "backtest"}
              </Badge>
              <span className="text-[10px] mono text-muted-foreground">{row.original.timeframe}</span>
              <span className="text-[10px] text-muted-foreground">·</span>
              <span className="text-[10px] mono text-muted-foreground">{row.original.pair_universe.length} pairs</span>
            </div>
            {row.original.hypothesis && (
              <p className="text-[10px] text-muted-foreground line-clamp-1 max-w-[360px]">{row.original.hypothesis}</p>
            )}
          </div>
        ),
      },
      {
        id: "setup",
        header: () => <span className="text-[10px] uppercase tracking-wider">Setup</span>,
        cell: ({ row }) => (
          <div className="space-y-0.5">
            <div className="text-[10px] text-muted-foreground">
              anchor <span className="mono text-foreground">{row.original.entry_model?.anchor ?? "n/a"}</span>
            </div>
            <div className="text-[10px] text-muted-foreground">
              score <span className="mono text-foreground">{row.original.entry_model?.score_min ?? "n/a"}</span>
              <span className="mx-1">·</span>
              ttl <span className="mono text-foreground">{row.original.entry_model?.ttl_sec ? `${row.original.entry_model.ttl_sec}s` : "n/a"}</span>
            </div>
          </div>
        ),
      },
      {
        accessorKey: "sharpe",
        header: ({ column }) => (
          <button onClick={() => column.toggleSorting()} className="flex items-center gap-1 text-[10px] uppercase tracking-wider hover:text-foreground">
            Sharpe <ArrowUpDown className="h-3 w-3" />
          </button>
        ),
        cell: ({ getValue }) => <span className="tabular mono text-xs font-medium">{(getValue() as number).toFixed(2)}</span>,
      },
      {
        accessorKey: "win_rate_pct",
        header: () => <span className="text-[10px] uppercase tracking-wider">Win %</span>,
        cell: ({ getValue }) => <span className="tabular mono text-xs text-muted-foreground">{(getValue() as number).toFixed(1)}%</span>,
      },
      {
        accessorKey: "total_return_pct",
        header: ({ column }) => (
          <button onClick={() => column.toggleSorting()} className="flex items-center gap-1 text-[10px] uppercase tracking-wider hover:text-foreground">
            Return <ArrowUpDown className="h-3 w-3" />
          </button>
        ),
        cell: ({ getValue }) => {
          const v = getValue() as number;
          return <span className={`tabular mono text-xs font-medium ${pnlClass(v)}`}>{formatPct(v, 1)}</span>;
        },
      },
      {
        accessorKey: "max_dd_pct",
        header: () => <span className="text-[10px] uppercase tracking-wider">Max DD</span>,
        cell: ({ getValue }) => <span className="tabular mono text-xs text-rose">{(getValue() as number).toFixed(1)}%</span>,
      },
      {
        accessorKey: "trade_count",
        header: () => <span className="text-[10px] uppercase tracking-wider">Trades</span>,
        cell: ({ getValue }) => <span className="tabular mono text-xs text-muted-foreground">{getValue() as number}</span>,
      },
      {
        accessorKey: "last_backtest_ts",
        header: () => <span className="text-[10px] uppercase tracking-wider">Backtest</span>,
        cell: ({ getValue }) => <span className="text-[10px] text-muted-foreground">{timeAgo(getValue() as string)}</span>,
      },
      {
        id: "actions",
        cell: ({ row }) => (
          <Sheet>
            <SheetTrigger asChild>
              <Button variant="ghost" size="sm" onClick={() => setSelected(row.original)}>
                <ChevronRight className="h-4 w-4" />
              </Button>
            </SheetTrigger>
            <SheetContent>
              <SheetHeader>
                <SheetTitle>{row.original.name}</SheetTitle>
                <SheetDescription>
                  Content hash <span className="mono text-foreground">{row.original.content_hash.slice(0, 18)}…</span>
                </SheetDescription>
              </SheetHeader>
              <StrategyDetail strategy={row.original} />
            </SheetContent>
          </Sheet>
        ),
      },
    ],
    []
  );

  const table = useReactTable({
    data: filtered,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
  });

  const toggleRegime = (r: string) => {
    const next = new Set(activeRegimes);
    if (next.has(r)) next.delete(r);
    else next.add(r);
    setActiveRegimes(next);
  };

  const toggleMode = (m: string) => {
    const next = new Set(activeModes);
    if (next.has(m)) next.delete(m);
    else next.add(m);
    setActiveModes(next);
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="p-4 grid grid-cols-1 md:grid-cols-5 gap-3 items-end">
          <div className="space-y-1.5">
            <Label htmlFor="search">Search</Label>
            <Input id="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Name or tag…" />
          </div>
          <div className="space-y-1.5">
            <Label>Regime</Label>
            <div className="flex flex-wrap gap-1.5">
              {REGIMES.map((r) => (
                <button key={r} onClick={() => toggleRegime(r)}>
                  <Badge variant={activeRegimes.has(r) ? "default" : "outline"} className="cursor-pointer">
                    {r}
                  </Badge>
                </button>
              ))}
            </div>
          </div>
          <div className="space-y-1.5 md:col-span-2">
            <Label>Collection</Label>
            <div className="flex flex-wrap gap-1.5">
              {MODES.map((m) => (
                <button key={m} onClick={() => toggleMode(m)}>
                  <Badge variant={activeModes.has(m) ? "default" : "outline"} className="cursor-pointer">
                    {m}
                  </Badge>
                </button>
              ))}
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="sharpe">Min Sharpe</Label>
            <Input id="sharpe" type="number" step="0.1" value={minSharpe} onChange={(e) => setMinSharpe(e.target.value)} placeholder="0.0" />
          </div>
        </CardContent>
      </Card>

      <Card className="overflow-hidden">
        <table className="w-full">
          <thead>
            {table.getHeaderGroups().map((hg) => (
              <tr key={hg.id} className="border-b border-border bg-secondary/30">
                {hg.headers.map((h) => (
                  <th key={h.id} className="text-left px-4 py-2 text-[10px] uppercase tracking-wider text-muted-foreground font-medium">
                    {h.isPlaceholder ? null : flexRender(h.column.columnDef.header, h.getContext())}
                  </th>
                ))}
              </tr>
            ))}
          </thead>
          <tbody>
            {table.getRowModel().rows.map((row) => (
              <tr key={row.id} className="border-b border-border/40 hover:bg-secondary/30">
                {row.getVisibleCells().map((cell) => (
                  <td key={cell.id} className="px-4 py-2.5">
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </td>
                ))}
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={9} className="px-4 py-8 text-center text-xs text-muted-foreground">
                  No strategies match those filters.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>

      <p className="text-[10px] text-muted-foreground">
        Showing {filtered.length} of {data.length} strategies. All metrics from persisted backtests in the Phase-1 Registry.
      </p>
      {/* selected referenced to silence unused-state lint */}
      <span className="hidden">{selected?.id}</span>
    </div>
  );
}
