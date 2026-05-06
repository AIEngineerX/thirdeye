// Process-local pub/sub for intel feed events. Producers (scan/check route
// handlers) publish on write; consumers (the intel/feed SSE handler)
// subscribe and forward to connected clients. Multi-process variants would
// swap this for Postgres LISTEN/NOTIFY — see Phase 4 design doc.

export type IntelEvent =
  | { event: "scan:start"; data: { mint: string; symbol: string | null } }
  | {
      event: "scan:complete";
      data: {
        id: number | null;
        mint: string;
        symbol: string | null;
        risk: number;
        sybilFlag: boolean;
      };
    }
  | { event: "check:start"; data: { address: string } }
  | {
      event: "check:complete";
      data: { address: string; score: number; verdict: string };
    }
  | { event: "tag:applied"; data: { address: string; tag: string } };

type Handler = (evt: IntelEvent) => void;

const handlers = new Set<Handler>();

export function publish(evt: IntelEvent): void {
  for (const h of handlers) {
    try {
      h(evt);
    } catch (e) {
      console.error("[intel-bus] handler threw", e);
    }
  }
}

export function subscribe(handler: Handler): () => void {
  handlers.add(handler);
  return () => handlers.delete(handler);
}

export function subscriberCount(): number {
  return handlers.size;
}
