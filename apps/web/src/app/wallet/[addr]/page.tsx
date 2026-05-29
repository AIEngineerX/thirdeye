"use client";

import { EvidenceStrip } from "@/components/EvidenceStrip";
import { api } from "@/lib/api";
import {
  fmtInt,
  fmtPct,
  fmtRelativeMs,
  fmtUsd,
  fmtUsdSigned,
  isValidSolanaAddress,
  shortAddr,
} from "@/lib/format";
import {
  SOL_MINT,
  type TokenPosition,
  type WalletPerformance,
  type WalletPnlResponse,
  type WalletPnlSummary,
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
      {/* Compact header: identity + state, kept to a single band so the PnL
          below is the first thing the eye lands on. */}
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="font-mono text-2xs uppercase tracking-[0.22em] text-tertiary">
            wallet · trading performance
          </div>
          <div className="mt-1.5 flex items-center gap-2">
            <span className="select-all font-mono text-sm text-accent" title={addr}>
              {shortAddr(addr, 6, 6)}
            </span>
            <CopyButton value={addr} />
          </div>
        </div>
        <div className="flex items-center gap-4">
          <span className="font-sans text-2xs text-tertiary">
            {status === "loading" ? (
              <span className="cursor-blink text-secondary">loading…</span>
            ) : status === "done" && s ? (
              <>
                {fmtInt(s.summary.counts.trades)} trades · {fmtInt(s.summary.counts.tokensTraded)}{" "}
                tokens
              </>
            ) : null}
          </span>
          <button
            type="button"
            onClick={load}
            className="border border-border-emphasis px-3 py-1.5 font-mono text-2xs uppercase tracking-[0.2em] text-accent transition-colors hover:bg-accent-bg"
          >
            refresh
          </button>
        </div>
      </div>

      <div className="mb-6">
        <EvidenceStrip
          address={addr}
          kind="wallet"
          label="wallet evidence"
          meta={
            s
              ? `${fmtInt(s.summary.counts.trades)} trades · ${fmtInt(s.summary.counts.tokensTraded)} tokens`
              : undefined
          }
        />
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
          <WalletPerformanceHero summary={s} performance={data.performance} verified={verified} />

          <ImpactTape positions={topPositions.slice(0, 10)} />
          <PositionsTable positions={topPositions} />
          <TradesTable trades={data?.trades.slice(0, 15) ?? []} />
        </>
      ) : status === "loading" ? (
        <div className="border border-border-subtle bg-card px-4 py-16 text-center font-mono text-2xs uppercase tracking-[0.2em] text-tertiary">
          <span className="cursor-blink">querying solana tracker…</span>
        </div>
      ) : null}
    </div>
  );
}

function WalletTape({ summary }: { summary: WalletPnlSummary }) {
  const rows = [
    ["buys", fmtInt(summary.summary.counts.buys)],
    ["sells", fmtInt(summary.summary.counts.sells)],
    ["tokens", fmtInt(summary.summary.counts.tokensTraded)],
    ["invested", fmtUsd(summary.summary.invested)],
    ["proceeds", fmtUsd(summary.summary.proceeds)],
    [
      "won / lost",
      `${fmtInt(summary.analysis.tokens.winning)} / ${fmtInt(summary.analysis.tokens.losing)}`,
    ],
  ] as const;
  return (
    <div className="grid border-t border-border-subtle sm:grid-cols-2 lg:grid-cols-6">
      {rows.map(([label, value], i) => (
        <div
          key={label}
          className={`px-4 py-3 ${i < rows.length - 1 ? "border-b border-border-subtle sm:border-r lg:border-b-0" : ""}`}
        >
          <div className="font-mono text-2xs uppercase tracking-[0.16em] text-tertiary">
            {label}
          </div>
          <div className="mt-1 font-mono text-sm tabular text-secondary">{value}</div>
        </div>
      ))}
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

function WalletPerformanceHero({
  summary,
  performance,
  verified,
}: {
  summary: WalletPnlSummary;
  performance: WalletPerformance;
  verified: boolean;
}) {
  return (
    <section className="border border-border-subtle bg-card">
      <div className="grid gap-px bg-border-subtle lg:grid-cols-[minmax(0,1.65fr)_minmax(280px,0.85fr)]">
        <div className="bg-card p-4">
          <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="font-mono text-2xs uppercase tracking-[0.22em] text-tertiary">
                pnl curve · {performance.window}d
              </div>
              <div
                className={`mt-2 font-mono text-3xl tabular md:text-5xl ${TONE_CLASS[tone(summary.summary.pnl.total)]}`}
              >
                {fmtUsdSigned(summary.summary.pnl.total)}
              </div>
            </div>
            <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-right font-mono text-2xs uppercase tracking-[0.14em]">
              <span className="text-tertiary">window pnl</span>
              <span className={TONE_CLASS[tone(performance.totals.realizedPnl)]}>
                {fmtUsdSigned(performance.totals.realizedPnl)}
              </span>
              <span className="text-tertiary">window volume</span>
              <span className="text-secondary">{fmtUsd(Math.abs(performance.totals.volume))}</span>
              <span className="text-tertiary">drawdown</span>
              <span className="text-high">{fmtUsdSigned(performance.drawdown.amount)}</span>
            </div>
          </div>
          <PerformanceSvg days={performance.days} />
        </div>
        <div className="grid bg-card sm:grid-cols-2 lg:grid-cols-1">
          <Stat
            label="realized"
            value={fmtUsdSigned(summary.summary.pnl.realized)}
            tone={tone(summary.summary.pnl.realized)}
            className="border-b border-border-subtle sm:border-r lg:border-r-0"
          />
          <Stat
            label="unrealized"
            value={fmtUsdSigned(summary.summary.pnl.unrealized)}
            tone={tone(summary.summary.pnl.unrealized)}
            className="border-b border-border-subtle"
          />
          <Stat
            label="roi"
            value={fmtPct(summary.summary.roi, 1)}
            tone={tone(summary.summary.roi)}
            className="border-b border-border-subtle sm:border-r lg:border-r-0"
          />
          <Stat label="win rate" value={fmtPct(summary.analysis.winRate, 1)} />
        </div>
      </div>
      <WalletTape summary={summary} />
      <div className="grid border-t border-border-subtle md:grid-cols-3">
        <WindowStat
          label="best day"
          value={fmtUsdSigned(performance.bestDay.realizedPnl)}
          detail={performance.bestDay.date}
          tone={tone(performance.bestDay.realizedPnl)}
        />
        <WindowStat
          label="worst day"
          value={fmtUsdSigned(performance.worstDay.realizedPnl)}
          detail={performance.worstDay.date}
          tone={tone(performance.worstDay.realizedPnl)}
        />
        <WindowStat
          label="current streak"
          value={
            performance.streaks.currentPositive > 0
              ? `${fmtInt(performance.streaks.currentPositive)} green`
              : performance.streaks.currentNegative > 0
                ? `${fmtInt(performance.streaks.currentNegative)} red`
                : "flat"
          }
          detail={`${fmtInt(performance.totals.trades)} window trades`}
          tone={
            performance.streaks.currentPositive > 0
              ? "clean"
              : performance.streaks.currentNegative > 0
                ? "high"
                : "primary"
          }
        />
      </div>
      {verified ? (
        <div className="border-t border-border-subtle px-4 py-2.5 font-mono text-2xs uppercase tracking-[0.16em] text-clean">
          verified · wash and manipulated trades excluded from these figures
        </div>
      ) : null}
    </section>
  );
}

function PerformanceSvg({ days }: { days: WalletPerformance["days"] }) {
  const width = 720;
  const height = 220;
  const pad = 18;
  const series = days.reduce<Array<{ date: string; value: number; volume: number }>>((acc, day) => {
    const prev = acc.at(-1)?.value ?? 0;
    acc.push({ date: day.date, value: prev + day.realizedPnl, volume: Math.abs(day.volume) });
    return acc;
  }, []);
  if (series.length < 2) {
    return (
      <div className="flex h-[220px] items-center justify-center border border-border-subtle bg-base font-mono text-2xs uppercase tracking-[0.2em] text-tertiary">
        no performance series
      </div>
    );
  }
  const values = series.map((p) => p.value);
  const min = Math.min(...values, 0);
  const max = Math.max(...values, 0);
  const range = max - min || 1;
  const x = (i: number) => pad + (i / Math.max(1, series.length - 1)) * (width - pad * 2);
  const y = (value: number) => height - pad - ((value - min) / range) * (height - pad * 2);
  const line = series.map((p, i) => `${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(" ");
  const zeroY = y(0);
  const maxVolume = Math.max(...series.map((p) => p.volume), 1);

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label="wallet realized pnl path"
      className="h-[220px] w-full border border-border-subtle bg-base"
      preserveAspectRatio="none"
    >
      <line
        x1={pad}
        y1={zeroY}
        x2={width - pad}
        y2={zeroY}
        stroke="var(--border-emphasis)"
        strokeWidth="1"
      />
      {series.map((p, i) => {
        const barH = Math.max(2, (p.volume / maxVolume) * 34);
        return (
          <rect
            key={`${p.date}-${i}`}
            x={x(i) - 2}
            y={height - pad - barH}
            width="4"
            height={barH}
            fill="var(--border-emphasis)"
            opacity="0.55"
          />
        );
      })}
      <polyline
        points={line}
        fill="none"
        stroke={series.at(-1)!.value >= 0 ? "var(--severity-clean)" : "var(--severity-high)"}
        strokeWidth="2.5"
        vectorEffect="non-scaling-stroke"
      />
      {series.map((p, i) =>
        i === 0 || i === series.length - 1 ? (
          <circle
            key={`${p.date}-dot`}
            cx={x(i)}
            cy={y(p.value)}
            r="4"
            fill={p.value >= 0 ? "var(--severity-clean)" : "var(--severity-high)"}
          />
        ) : null,
      )}
    </svg>
  );
}

function WindowStat({
  label,
  value,
  detail,
  tone: statTone,
}: {
  label: string;
  value: string;
  detail: string;
  tone: keyof typeof TONE_CLASS;
}) {
  return (
    <div className="border-b border-border-subtle px-4 py-3 md:border-r md:border-b-0 md:last:border-r-0">
      <div className="font-mono text-2xs uppercase tracking-[0.16em] text-tertiary">{label}</div>
      <div className={`mt-1 font-mono text-sm tabular ${TONE_CLASS[statTone]}`}>{value}</div>
      <div className="mt-1 font-mono text-2xs uppercase tracking-[0.12em] text-tertiary">
        {detail}
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  tone = "primary",
  className = "",
}: {
  label: string;
  value: string;
  tone?: keyof typeof TONE_CLASS;
  className?: string;
}) {
  return (
    <div className={`px-5 py-4 ${className}`}>
      <div className="font-mono text-2xs uppercase tracking-[0.18em] text-tertiary">{label}</div>
      <div className={`mt-2 font-mono text-xl tabular ${TONE_CLASS[tone]}`}>{value}</div>
    </div>
  );
}

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        } catch {
          /* clipboard unavailable (insecure context) — no-op */
        }
      }}
      className="border border-border-subtle px-2 py-0.5 font-mono text-2xs uppercase tracking-[0.18em] text-tertiary transition-colors hover:text-accent"
    >
      {copied ? "copied" : "copy"}
    </button>
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
                    <div className="flex min-w-40 flex-col gap-0.5">
                      <span className="text-primary">{p.meta.symbol || "?"}</span>
                      <span className="truncate text-[11px] normal-case tracking-normal text-tertiary">
                        {p.meta.name || shortAddr(p.token, 5, 5)}
                      </span>
                    </div>
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

function ImpactTape({ positions }: { positions: TokenPosition[] }) {
  if (positions.length === 0) return null;
  const maxAbs = Math.max(...positions.map((p) => Math.abs(p.pnl.total)), 1);
  return (
    <section className="mt-6 border border-border-subtle bg-card">
      <header className="flex items-baseline justify-between border-b border-border-subtle px-4 py-3">
        <h3 className="font-mono text-2xs uppercase tracking-[0.22em] text-secondary">
          position impact
        </h3>
        <span className="font-mono text-2xs uppercase tracking-[0.16em] text-tertiary">
          absolute pnl scale
        </span>
      </header>
      <ol className="divide-y divide-border-subtle/60">
        {positions.map((p, i) => {
          const width = Math.max(4, (Math.abs(p.pnl.total) / maxAbs) * 100);
          const isWin = p.pnl.total >= 0;
          return (
            <li
              key={p.token}
              className="grid gap-3 px-4 py-2.5 md:grid-cols-[2rem_10rem_1fr_7rem] md:items-center"
            >
              <span className="font-mono text-2xs tabular text-tertiary">{i + 1}</span>
              <span
                className="min-w-0 truncate font-mono text-sm text-primary"
                title={p.meta.name || p.token}
              >
                {p.meta.symbol || shortAddr(p.token, 4, 4)}
              </span>
              <div className="h-2 bg-base">
                <div
                  className={isWin ? "h-full bg-clean" : "h-full bg-high"}
                  style={{ width: `${width}%` }}
                />
              </div>
              <span
                className={`text-right font-mono text-sm tabular ${TONE_CLASS[tone(p.pnl.total)]}`}
              >
                {fmtUsdSigned(p.pnl.total)}
              </span>
            </li>
          );
        })}
      </ol>
    </section>
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
                <Th>route</Th>
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
                    <Td className="text-tertiary" title={t.tx}>
                      {t.program || "unknown"} · {shortAddr(t.tx, 4, 4)}
                    </Td>
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
  title,
}: {
  children: ReactNode;
  right?: boolean;
  className?: string;
  title?: string;
}) {
  return (
    <td
      title={title}
      className={`tabular px-2 py-2.5 ${right ? "text-right" : "text-left"} ${className}`}
    >
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
