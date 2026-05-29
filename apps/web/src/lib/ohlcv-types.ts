// Mirror of GET /api/db/tokens/:mint/ohlcv (apps/web can't import @thirdeye/*).
export interface OhlcvCandle {
  time: number; // unix seconds
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}
export interface ChartMarker {
  time: number; // unix seconds
  position: "aboveBar" | "belowBar";
  color: string;
  shape: "arrowDown" | "arrowUp" | "circle";
  text?: string;
}

// Mirror of GET /api/db/tokens/:mint/markers
export interface TokenMarkers {
  call: { time: number; multiplier: number | null } | null;
  buys: { time: number }[];
}
