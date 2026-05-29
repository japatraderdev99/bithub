"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { LayoutGrid, Globe2, Library, Sparkles, Rocket, Activity, LineChart, History } from "lucide-react";
import { cn } from "@/lib/utils";

const NAV = [
  { href: "/", label: "Home", icon: LayoutGrid },
  { href: "/panorama", label: "Panorama", icon: Globe2 },
  { href: "/library", label: "Library", icon: Library },
  { href: "/advisor", label: "Advisor", icon: Sparkles },
  { href: "/launcher", label: "Launcher", icon: Rocket },
  { href: "/cyclical", label: "Cyclical AI", icon: Activity },
  { href: "/cockpit", label: "Cockpit", icon: LineChart },
  { href: "/history", label: "Histórico", icon: History },
];

export function Sidebar() {
  const pathname = usePathname();
  return (
    <aside className="hidden md:flex h-full w-56 shrink-0 flex-col border-r border-border bg-card">
      <div className="px-4 py-3 border-b border-border">
        <Link href="/" className="flex items-baseline gap-1.5">
          <span className="text-base font-semibold tracking-tight">Bithub</span>
          <span className="text-[10px] uppercase tracking-widest text-muted-foreground">research</span>
        </Link>
      </div>
      <nav className="flex-1 py-2 px-2 space-y-0.5">
        {NAV.map(({ href, label, icon: Icon }) => {
          const active = href === "/" ? pathname === "/" : pathname.startsWith(href);
          return (
            <Link
              key={href}
              href={href}
              className={cn(
                "flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-xs transition-colors",
                active
                  ? "bg-secondary text-foreground font-medium"
                  : "text-muted-foreground hover:bg-secondary/50 hover:text-foreground"
              )}
            >
              <Icon className="h-3.5 w-3.5" />
              {label}
            </Link>
          );
        })}
      </nav>
      <div className="border-t border-border px-3 py-2 text-[10px] text-muted-foreground">
        <div className="flex items-center justify-between">
          <span className="uppercase tracking-wider">Phase 3 mock</span>
          <span className="mono">v0.1.0</span>
        </div>
      </div>
    </aside>
  );
}
