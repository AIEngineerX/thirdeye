"use client";

import { api, listCandidates, promoteCandidate } from "@/lib/api";
import type { CandidateRow } from "@/lib/api-types";
import { fmtMoneyCompact, isValidSolanaAddress, shortAddr } from "@/lib/format";
import { useEffect, useState } from "react";

export interface TrackedWallet {
  address: string;
  label: string | null;
  source: string;
  winRate: number | null;
  realizedPnlUsd: number | null;
  roi: number | null;
  tokensTraded: number | null;
  addedAt: string;
}

function SuggestedSection({ onPromoted }: { onPromoted: () => void }) {
  const [candidates, setCandidates] = useState<CandidateRow[]>([]);
  const [promoting, setPromoting] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    listCandidates({ limit: 15 })
      .then(setCandidates)
      .catch(() => {});
  }, []);

  const promote = async (address: string) => {
    setPromoting((p) => ({ ...p, [address]: true }));
    setErrors((e) => {
      const next = { ...e };
      delete next[address];
      return next;
    });
    try {
      await promoteCandidate(address);
      setCandidates((prev) => prev.filter((c) => c.address !== address));
      onPromoted();
    } catch {
      setErrors((e) => ({ ...e, [address]: "promote failed" }));
    } finally {
      setPromoting((p) => {
        const next = { ...p };
        delete next[address];
        return next;
      });
    }
  };

  return (
    <div className="mt-4 border border-border-subtle p-3">
      <h2 className="mb-2 font-mono text-2xs uppercase tracking-[0.22em] text-tertiary">
        suggested
      </h2>
      {candidates.length === 0 ? (
        <p className="font-mono text-2xs text-tertiary">
          no suggestions — run the seed/leaderboard sync
        </p>
      ) : (
        <ul className="divide-y divide-border-subtle">
          {candidates.map((c) => (
            <li key={c.address} className="flex flex-wrap items-center gap-x-3 gap-y-0.5 py-1.5">
              <span className="font-mono text-sm text-primary">
                {c.handle ?? c.displayName ?? shortAddr(c.address)}
              </span>
              {c.earlyRate !== null && (
                <span className="font-mono text-2xs tabular-nums text-accent">
                  {Math.round(c.earlyRate * 100)}% early
                </span>
              )}
              {c.srcPnlAll !== null && (
                <span className="font-mono text-2xs tabular-nums text-secondary">
                  {fmtMoneyCompact(c.srcPnlAll)}
                </span>
              )}
              {c.buysObserved !== null && (
                <span className="font-mono text-2xs tabular-nums text-tertiary">
                  {c.buysObserved}b
                </span>
              )}
              {c.tokensTraded !== null && (
                <span className="font-mono text-2xs tabular-nums text-tertiary">
                  {c.tokensTraded}t
                </span>
              )}
              <div className="ml-auto flex items-center gap-2">
                {errors[c.address] && (
                  <span className="font-mono text-2xs text-high">{errors[c.address]}</span>
                )}
                <button
                  type="button"
                  onClick={() => promote(c.address)}
                  disabled={!!promoting[c.address]}
                  className="border border-brand px-2 py-0.5 font-mono text-2xs text-brand disabled:opacity-50"
                >
                  {promoting[c.address] ? "…" : "promote"}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function Watchlist() {
  const [items, setItems] = useState<TrackedWallet[]>([]);
  const [addr, setAddr] = useState("");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const refresh = async () => {
    const r = await api("/api/db/tracked");
    if (!r.ok) {
      setErr("failed to load watchlist");
      return;
    }
    const body = (await r.json()) as { items: TrackedWallet[] };
    setItems(body.items);
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: load once on mount
  useEffect(() => {
    refresh().catch((e) => setErr(String(e)));
  }, []);

  const add = async () => {
    if (!isValidSolanaAddress(addr)) {
      setErr("invalid address");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const r = await api("/api/db/tracked", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(label ? { address: addr, label } : { address: addr }),
      });
      if (!r.ok) {
        setErr("add failed");
        return;
      }
      setAddr("");
      setLabel("");
      await refresh();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (a: string) => {
    try {
      const r = await api(`/api/db/tracked/${a}`, { method: "DELETE" });
      if (!r.ok) {
        setErr("remove failed");
        return;
      }
      await refresh();
    } catch (e) {
      setErr(String(e));
    }
  };

  return (
    <div>
      <div className="border border-border-subtle p-3">
        <h2 className="mb-2 font-mono text-2xs uppercase tracking-[0.22em] text-tertiary">
          watchlist
        </h2>
        <div className="mb-3 flex flex-wrap gap-2">
          <input
            value={addr}
            onChange={(e) => setAddr(e.target.value)}
            placeholder="wallet address"
            className="flex-1 border border-border-subtle bg-transparent px-2 py-1 font-mono text-xs"
          />
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="label (optional)"
            className="w-40 border border-border-subtle bg-transparent px-2 py-1 font-mono text-xs"
          />
          <button
            type="button"
            onClick={add}
            disabled={busy}
            className="border border-brand px-3 py-1 font-mono text-xs text-brand disabled:opacity-50"
          >
            add
          </button>
        </div>
        {err && <p className="mb-2 font-mono text-2xs text-high">{err}</p>}
        <ul className="divide-y divide-border-subtle">
          {items.map((w) => (
            <li key={w.address} className="flex items-center gap-3 py-1.5">
              <span className="font-mono text-sm text-primary">
                {w.label ?? shortAddr(w.address)}
              </span>
              {w.winRate !== null && (
                <span className="font-mono text-2xs text-tertiary">
                  {Math.round(w.winRate)}% wr
                </span>
              )}
              {w.realizedPnlUsd !== null && (
                <span
                  className={`font-mono text-2xs ${w.realizedPnlUsd >= 0 ? "text-mint" : "text-high"}`}
                >
                  ${Math.round(w.realizedPnlUsd).toLocaleString()}
                </span>
              )}
              <button
                type="button"
                onClick={() => remove(w.address)}
                className="ml-auto font-mono text-2xs text-tertiary hover:text-high"
              >
                remove
              </button>
            </li>
          ))}
        </ul>
      </div>
      <SuggestedSection onPromoted={refresh} />
    </div>
  );
}
