"use client";
import { createContext, useContext, useState, type ReactNode } from "react";

interface CockpitState {
  highlightedSymbol: string | null;
  setHighlighted: (sym: string | null) => void;
}

const Ctx = createContext<CockpitState>({
  highlightedSymbol: null,
  setHighlighted: () => {},
});

export function CockpitProvider({ children }: { children: ReactNode }) {
  const [highlightedSymbol, setHighlighted] = useState<string | null>(null);
  return (
    <Ctx.Provider value={{ highlightedSymbol, setHighlighted }}>
      {children}
    </Ctx.Provider>
  );
}

export function useCockpitHighlight() {
  return useContext(Ctx);
}
