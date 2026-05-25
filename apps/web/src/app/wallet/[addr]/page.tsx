"use client";

import { AddressBanner } from "@/components/AddressBanner";
import { api } from "@/lib/api";
import {
  fmtInt,
  fmtPct,
  fmtRelativeMs,
  fmtUsd,
  fmtUsdSigned,
  isValidSolanaAddress,
} from "@/lib/format";
import {
  SOL_MINT,
  type TokenPosition,
  type WalletPnlResponse,
  type WalletTrade,
} from "@/lib/pnl-types";
import { useParams, useRouter } from "next/navigation";
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";

type Status = "loading" | "done" | "error";

export default function WalletDetailPage() {
  const params = useParams<{ addr: string }>();
  const router = useRouter();
  const addr = decodeURIComponent(params.addr);
  const valid = isValidSolanaAddress(addr);

  const [data, setData] = useState<WalletPnlResponse | null>(null);
  const [status, setStatus] = useState<Status>("loading");
  const [errMsg, setErrMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!valid) return;
    setStatus("loading");
    setErrMsg(null);
    try {
      const r = await api(`/api/wallet/${addr}/pnl`);
      if (!r.ok) {
        const body = (await r.json().catch(() => ({}))) as { message?: string };
        throw new Error(body.message ?? `request failed (${r.status})`);
      }
      setData((await r.json()) as WalletPnlResponse);
      setStatus("done");
    } catch (e) {
      setErrMsg(e instanceof Error ? e.message : String(e));
      setStatus("error");
    }
  }, [addr, valid]);

  useEffect(() => {
    load();
  }, [load]);

  const topPositions = useMemo(() => {
    if (!data) return [];
    return [...data.positions]
      .sort((a, b) => Math.abs(b.pnl.total) - Math.abs(a.pnl.total))
      .slice(0, 20);
  }, [data]);

  if (!valid) {
    return (
      <div className="mx-auto max-w-6xl px-6 py-12">
        <ErrorCard
          title="invalid address"
          message="Not a valid Solana base58 address (32–44 chars)."
          actionLabel="back to landing"
          onAction={() => router.push("/")}
        />
      </div>
    );
  }

  const s = data?.summary;
  const verified = s?.pnlMode === "strict";

  return (
    <div className="mx-auto w-full max-w-6xl px-6 py-8">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-mono text-2xs uppercase tracking-[0.22em] text-tertiary">
            wallet · trading performance
          </h1>
          <p className="mt-1 font-sans text-sm text-secondary">
            {status === "loading" ? (
              <span className="cursor-blink">loading PnL…</span>
            ) : status === "error" ? (
              <span className="text-high">{errMsg ?? "failed to load"}</span>
            ) : (
              <>
                {fmtInt(s?.summary.counts.trades ?? 0)} trades ·{" "}
                {fmtInt(s?.summary.counts.tokensTraded ?? 0)} tokens
              </>
            )}
          </p>
        </div>
        <button
          type="button"
          onClick={load}
          className="border border-border-emphasis px-3 py-1.5 font-mono text-2xs uppercase tracking-[0.2em] text-accent transition-colors hover:bg-accent-bg"
        >
          refresh
        </button>
      </div>

      <div className="mb-6">
        <AddressBanner address={addr} label="wallet address" />
      </div>

      {status === "error" ? (
        <ErrorCard
          title="could not load"
          message={errMsg ?? "unknown error"}
          actionLabel="retry"
          onAction={load}
        />
      ) : null}

      {s ? (
        <>
          {/* Headline PnL — the alpha. */}
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <StatCard
              label="realized pnl"
              value={fmtUsdSigned(s.summary.pnl.realized)}
              tone={tone(s.summary.pnl.realized)}
              big
            />
            <StatCard label="roi" value={fmtPct(s.summary.roi, 1)} tone={tone(s.summary.roi)} />
            <StatCard label="win rate" value={fmtPct(s.analysis.winRate, 1)} />
            <StatCard
              label="tokens won / lost"
              value={`${fmtInt(s.analysis.tokens.winning)} / ${fmtInt(s.analysis.tokens.losing)}`}
            />
          </div>

          {/* The differentiator, in plain language — not a competitor's inflatable label. */}
          {verified ? (
            <p className="mt-3 font-mono text-2xs uppercase tracking-[0.18em] text-clean">
              ✓ verified · wash &amp; manipulated trades excluded from these figures
            </p>
          ) : null}

          <PositionsTable positions={topPositions} />
          <TradesTable trades={data?.trades.slice(0, 15) ?? []} />
        </>
      ) : status === "loading" ? (
        <div className="border border-border-subtle bg-card px-4 py-12 text-center font-mono text-2xs uppercase tracking-[0.2em] text-tertiary">
          <span className="cursor-blink">querying solana tracker…</span>
        </div>
      ) : null}
    </div>
  );
}

function tone(n: number): "clean" | "high" | "primary" {
  return n > 0 ? "clean" : n < 0 ? "high" : "primary";
}

const TONE_CLASS = {
  primary: "text-primary",
  clean: "text-clean",
  high: "text-high",
} as const;

function StatCard({
  label,
  value,
  tone = "primary",
  big = false,
}: {
  label: string;
  value: string;
  tone?: keyof typeof TONE_CLASS;
  big?: boolean;
}) {
  return (
    <div className="border border-border-subtle bg-card px-4 py-4">
      <div className="font-mono text-2xs uppercase tracking-[0.18em] text-tertiary">{label}</div>
      <div className={`mt-2 font-mono tabular ${big ? "text-2xl" : "text-lg"} ${TONE_CLASS[tone]}`}>
        {value}
      </div>
    </div>
  );
}

function PositionsTable({ positions }: { positions: TokenPosition[] }) {
  return (
    <Section title={`positions · top ${positions.length} by impact`}>
      {positions.length === 0 ? (
        <Empty label="no positions" />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse font-mono text-sm">
            <thead>
              <Tr head>
                <Th>token</Th>
                <Th right>pnl</Th>
                <Th right>roi</Th>
                <Th right>invested</Th>
                <Th right>holding</Th>
              </Tr>
            </thead>
            <tbody>
              {positions.map((p) => (
                <Tr key={p.token}>
                  <Th>
                    <span className="text-primary">{p.meta.symbol || "?"}</span>
                    {p.meta.rugged ? (
                      <span className="ml-2 text-2xs uppercase tracking-[0.15em] text-high">
                        rug
                      </span>
                    ) : null}
                  </Th>
                  <Td right className={TONE_CLASS[tone(p.pnl.total)]}>
                    {fmtUsdSigned(p.pnl.total)}
                  </Td>
                  <Td right className={p.roi === null ? "text-tertiary" : TONE_CLASS[tone(p.roi)]}>
                    {fmtPct(p.roi, 0)}
                  </Td>
                  <Td right>{fmtUsd(p.invested)}</Td>
                  <Td right>{p.current.value > 0 ? fmtUsd(p.current.value) : "—"}</Td>
                </Tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}

function TradesTable({ trades }: { trades: WalletTrade[] }) {
  return (
    <Section title="recent trades">
      {trades.length === 0 ? (
        <Empty label="no trades" />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse font-mono text-sm">
            <thead>
              <Tr head>
                <Th>side</Th>
                <Th>token</Th>
                <Th right>volume</Th>
                <Th right>when</Th>
              </Tr>
            </thead>
            <tbody>
              {trades.map((t) => {
                const buy = t.from.address === SOL_MINT;
                const symbol = buy ? t.to.token.symbol : t.from.token.symbol;
                return (
                  <Tr key={t.tx}>
                    <Td className={buy ? "text-clean" : "text-high"}>{buy ? "buy" : "sell"}</Td>
                    <Th>{symbol || "?"}</Th>
                    <Td right>{fmtUsd(t.volume.usd)}</Td>
                    <Td right className="text-tertiary">
                      {fmtRelativeMs(t.time)}
                    </Td>
                  </Tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-6 border border-border-subtle bg-card">
      <header className="border-b border-border-subtle px-4 py-3">
        <h3 className="font-mono text-2xs uppercase tracking-[0.22em] text-secondary">{title}</h3>
      </header>
      <div className="px-2 py-1">{children}</div>
    </section>
  );
}

function Empty({ label }: { label: string }) {
  return (
    <p className="px-2 py-8 text-center font-mono text-2xs uppercase tracking-[0.2em] text-tertiary">
      {label}
    </p>
  );
}

function Tr({ children, head = false }: { children: ReactNode; head?: boolean }) {
  return (
    <tr className={head ? "" : "border-t border-border-subtle/60 hover:bg-accent-bg/30"}>
      {children}
    </tr>
  );
}

function Th({ children, right = false }: { children: ReactNode; right?: boolean }) {
  return (
    <th
      className={`px-2 py-2.5 text-2xs font-medium uppercase tracking-[0.15em] text-tertiary ${right ? "text-right" : "text-left"}`}
    >
      {children}
    </th>
  );
}

function Td({
  children,
  right = false,
  className = "text-primary",
}: {
  children: ReactNode;
  right?: boolean;
  className?: string;
}) {
  return (
    <td className={`tabular px-2 py-2.5 ${right ? "text-right" : "text-left"} ${className}`}>
      {children}
    </td>
  );
}

function ErrorCard({
  title,
  message,
  actionLabel,
  onAction,
}: {
  title: string;
  message: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <section className="border border-high/60 bg-high/10 p-5">
      <header className="mb-2 font-mono text-2xs uppercase tracking-[0.22em] text-high">
        ▸ {title}
      </header>
      <p className="font-sans text-sm text-primary">{message}</p>
      {actionLabel && onAction ? (
        <button
          type="button"
          onClick={onAction}
          className="mt-4 border border-high/60 px-3 py-1.5 font-mono text-2xs uppercase tracking-[0.2em] text-high hover:bg-high/20"
        >
          {actionLabel}
        </button>
      ) : null}
    </section>
  );
}
