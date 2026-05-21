"use client";

import { getApiClient } from "@/lib/api";
import { type SseFrame, sseFetch, sseFetchViaTicket } from "@/lib/sse";
import { useCallback, useEffect, useReducer, useRef } from "react";

export type SseStatus = "idle" | "streaming" | "done" | "error";

export interface UseSseState {
  events: SseFrame[];
  status: SseStatus;
  error: Error | null;
}

interface State extends UseSseState {}
type Action =
  | { type: "reset" }
  | { type: "open" }
  | { type: "frame"; frame: SseFrame }
  | { type: "done" }
  | { type: "error"; error: Error };

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "reset":
      return { events: [], status: "idle", error: null };
    case "open":
      return { events: [], status: "streaming", error: null };
    case "frame":
      return { ...state, events: [...state.events, action.frame] };
    case "done":
      return { ...state, status: "done" };
    case "error":
      return { ...state, status: "error", error: action.error };
  }
}

export interface UseSseOptions {
  /** Path to GET. When null, the hook stays idle and emits no requests. */
  path: string | null;
  /**
   * When set, use the two-step ticket flow against `path` (treats `path` as
   * the feed URL and `ticketPath` as the ticket POST endpoint).
   */
  ticketPath?: string;
  /**
   * Re-open the stream when this value changes, even if `path` stayed the
   * same. Used by "Force re-scan" buttons to re-run with `?force=true`.
   */
  reconnectKey?: string | number;
}

export interface UseSseResult extends UseSseState {
  /** Manually close the in-flight stream. Status moves to "done". */
  abort: () => void;
}

/**
 * Open an SSE connection and accumulate frames into state. The component
 * gets a re-render on each event. AbortController is tracked in a ref so
 * the manual `abort()` and the unmount cleanup both fire on the same
 * controller.
 *
 * Each `path` change (or `reconnectKey` change) tears down the prior
 * controller and opens a fresh stream — this is how the "Force re-scan"
 * button avoids the concurrent-scan issue flagged in the spec-scope review.
 */
export function useSse({ path, ticketPath, reconnectKey }: UseSseOptions): UseSseResult {
  const [state, dispatch] = useReducer(reducer, {
    events: [],
    status: "idle" as SseStatus,
    error: null,
  });
  const ctrlRef = useRef<AbortController | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reconnectKey is the explicit re-fire trigger; path/ticketPath are the natural change-detection inputs.
  useEffect(() => {
    if (!path) {
      dispatch({ type: "reset" });
      return;
    }
    const ctrl = new AbortController();
    ctrlRef.current = ctrl;
    dispatch({ type: "open" });

    const api = getApiClient();
    const apiFetch = (p: string, init?: RequestInit) => api.fetch(p, init);
    const stream = ticketPath
      ? sseFetchViaTicket(apiFetch, ticketPath, path, ctrl.signal)
      : sseFetch(apiFetch, path, ctrl.signal);

    (async () => {
      try {
        for await (const frame of stream) {
          if (ctrl.signal.aborted) return;
          dispatch({ type: "frame", frame });
        }
        if (!ctrl.signal.aborted) dispatch({ type: "done" });
      } catch (e) {
        if (ctrl.signal.aborted) return;
        const err = e instanceof Error ? e : new Error(String(e));
        dispatch({ type: "error", error: err });
      }
    })();

    return () => {
      ctrl.abort();
    };
  }, [path, ticketPath, reconnectKey]);

  const abort = useCallback(() => {
    ctrlRef.current?.abort();
  }, []);

  return { ...state, abort };
}
