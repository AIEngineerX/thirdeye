"use client";

import { KbdInput } from "@/components/KbdInput";
import { getApiClient } from "@/lib/api";
import { type ByokKind, type ByokSnapshot, getByokStore } from "@/lib/byok";
import { useEffect, useState } from "react";

const HELIUS_TEST_RPC = {
  jsonrpc: "2.0",
  id: 1,
  method: "getHealth",
  params: [],
};

interface KeyStatus {
  saved: string | null;
  draft: string;
  revealed: boolean;
  testStatus: "idle" | "testing" | "ok" | "error";
  testMessage: string | null;
}

const EMPTY_STATUS: KeyStatus = {
  saved: null,
  draft: "",
  revealed: false,
  testStatus: "idle",
  testMessage: null,
};

export default function SettingsPage() {
  const [helius, setHelius] = useState<KeyStatus>(EMPTY_STATUS);
  const [anthropic, setAnthropic] = useState<KeyStatus>(EMPTY_STATUS);

  // Sync local view from store on mount + on cross-tab storage events.
  useEffect(() => {
    const store = getByokStore();
    const sync = (snap: ByokSnapshot) => {
      setHelius((prev) => ({
        ...prev,
        saved: snap.helius,
        draft: snap.helius ?? "",
      }));
      setAnthropic((prev) => ({
        ...prev,
        saved: snap.anthropic,
        draft: snap.anthropic ?? "",
      }));
    };
    sync(store.snapshot());
    return store.subscribe(sync);
  }, []);

  const save = (kind: ByokKind) => {
    const value = (kind === "helius" ? helius.draft : anthropic.draft).trim();
    if (value.length === 0) return;
    getByokStore().set(kind, value);
    if (kind === "helius") {
      setHelius((p) => ({ ...p, testStatus: "idle", testMessage: null }));
    } else {
      setAnthropic((p) => ({ ...p, testStatus: "idle", testMessage: null }));
    }
  };

  const clear = (kind: ByokKind) => {
    getByokStore().clear(kind);
    if (kind === "helius") {
      setHelius({ ...EMPTY_STATUS });
    } else {
      setAnthropic({ ...EMPTY_STATUS });
    }
  };

  const testHelius = async () => {
    setHelius((p) => ({ ...p, testStatus: "testing", testMessage: null }));
    const resp = await getApiClient().fetch("/api/helius-rpc", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(HELIUS_TEST_RPC),
    });
    if (!resp.ok) {
      const text = await resp.text();
      setHelius((p) => ({
        ...p,
        testStatus: "error",
        testMessage: `${resp.status}: ${text.slice(0, 160)}`,
      }));
      return;
    }
    const body = (await resp.json()) as { result?: string; error?: { message: string } };
    if (body.error) {
      setHelius((p) => ({ ...p, testStatus: "error", testMessage: body.error!.message }));
      return;
    }
    setHelius((p) => ({
      ...p,
      testStatus: "ok",
      testMessage: `helius reachable · response: ${body.result ?? "ok"}`,
    }));
  };

  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-10">
      <header className="mb-8 border-b border-border-subtle pb-4">
        <h1 className="font-mono text-2xs uppercase tracking-[0.22em] text-tertiary">
          credentials
        </h1>
        <p className="mt-2 font-sans text-sm text-secondary">
          BYOK keys stay in your browser&apos;s localStorage and ride every request as headers. They
          never touch the api&apos;s database.
        </p>
      </header>

      <KeySection
        title="Helius API key"
        envVarHint="HELIUS_API_KEY"
        dashboardUrl="https://dashboard.helius.dev/api-keys"
        status={helius}
        onDraft={(v) => setHelius((p) => ({ ...p, draft: v }))}
        onReveal={() => setHelius((p) => ({ ...p, revealed: !p.revealed }))}
        onSave={() => save("helius")}
        onClear={() => clear("helius")}
        onTest={testHelius}
        testable
      />

      <div className="my-8 h-px bg-border-subtle" />

      <KeySection
        title="Anthropic API key"
        envVarHint="ANTHROPIC_API_KEY"
        dashboardUrl="https://console.anthropic.com"
        status={anthropic}
        onDraft={(v) => setAnthropic((p) => ({ ...p, draft: v }))}
        onReveal={() => setAnthropic((p) => ({ ...p, revealed: !p.revealed }))}
        onSave={() => save("anthropic")}
        onClear={() => clear("anthropic")}
      />
    </div>
  );
}

function KeySection(props: {
  title: string;
  envVarHint: string;
  dashboardUrl: string;
  status: KeyStatus;
  onDraft: (v: string) => void;
  onReveal: () => void;
  onSave: () => void;
  onClear: () => void;
  onTest?: () => void;
  testable?: boolean;
}) {
  const { title, envVarHint, dashboardUrl, status } = props;
  const masked = status.saved ? maskKey(status.saved) : null;

  return (
    <section className="border border-border-subtle bg-card">
      <header className="flex items-center justify-between border-b border-border-subtle px-4 py-3">
        <h2 className="font-mono text-2xs uppercase tracking-[0.22em] text-secondary">{title}</h2>
        <span className="font-mono text-2xs uppercase tracking-[0.18em] text-tertiary">
          {status.saved ? "active" : "— not set —"}
        </span>
      </header>

      <div className="space-y-3 px-4 py-4">
        <KbdInput
          value={status.draft}
          onChange={props.onDraft}
          onSubmit={props.onSave}
          type={status.revealed ? "text" : "password"}
          placeholder={status.saved ? maskKey(status.saved) : `paste your ${title.toLowerCase()}`}
          aria-label={title}
          trailing={
            <button
              type="button"
              onClick={props.onReveal}
              className="font-mono text-2xs uppercase tracking-[0.18em] text-tertiary hover:text-accent"
            >
              {status.revealed ? "hide" : "show"}
            </button>
          }
        />

        <p className="font-mono text-2xs uppercase tracking-[0.16em] text-tertiary">
          ▸ falls back to server env {envVarHint} when not set ·{" "}
          <a
            href={dashboardUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-accent hover:underline"
          >
            get a key ↗
          </a>
        </p>

        {masked ? (
          <p className="font-mono text-2xs uppercase tracking-[0.16em] text-secondary">
            ▸ saved: <span className="tabular">{masked}</span>
          </p>
        ) : null}

        {status.testMessage ? (
          <p
            className={`font-mono text-2xs uppercase tracking-[0.16em] ${
              status.testStatus === "ok" ? "text-clean" : "text-high"
            }`}
          >
            ▸ {status.testMessage}
          </p>
        ) : null}
      </div>

      <footer className="flex flex-wrap items-center gap-2 border-t border-border-subtle px-4 py-3">
        <button
          type="button"
          onClick={props.onSave}
          disabled={status.draft.trim().length === 0}
          className="border border-accent bg-accent-bg px-3 py-1.5 font-mono text-2xs uppercase tracking-[0.22em] text-accent hover:bg-accent/20 disabled:cursor-not-allowed disabled:border-border-subtle disabled:bg-transparent disabled:text-tertiary"
        >
          save
        </button>
        <button
          type="button"
          onClick={props.onClear}
          disabled={status.saved === null}
          className="border border-border-emphasis px-3 py-1.5 font-mono text-2xs uppercase tracking-[0.22em] text-tertiary hover:bg-card-hover disabled:cursor-not-allowed disabled:opacity-50"
        >
          clear
        </button>
        {props.testable && props.onTest ? (
          <button
            type="button"
            onClick={props.onTest}
            disabled={status.testStatus === "testing"}
            className="border border-border-emphasis px-3 py-1.5 font-mono text-2xs uppercase tracking-[0.22em] text-tertiary hover:bg-card-hover disabled:cursor-not-allowed disabled:opacity-50"
          >
            {status.testStatus === "testing" ? "▸ testing…" : "test connection"}
          </button>
        ) : null}
      </footer>
    </section>
  );
}

function maskKey(value: string): string {
  if (value.length <= 8) return "•".repeat(value.length);
  return `${"•".repeat(Math.max(8, value.length - 4))} ${value.slice(-4)}`;
}
