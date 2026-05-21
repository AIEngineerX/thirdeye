import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ["var(--font-plex-sans)", "system-ui", "sans-serif"],
        mono: ["var(--font-plex-mono)", "ui-monospace", "monospace"],
      },
      colors: {
        base: "var(--bg-base)",
        card: "var(--bg-card)",
        "card-hover": "var(--bg-card-hover)",
        elevated: "var(--bg-elevated)",
        primary: "var(--text-primary)",
        secondary: "var(--text-secondary)",
        tertiary: "var(--text-tertiary)",
        accent: "var(--accent)",
        "accent-dim": "var(--accent-dim)",
        "accent-bg": "var(--accent-bg)",
        clean: "var(--severity-clean)",
        low: "var(--severity-low)",
        med: "var(--severity-med)",
        high: "var(--severity-high)",
        "border-subtle": "var(--border-subtle)",
        "border-emphasis": "var(--border-emphasis)",
      },
      borderRadius: {
        none: "0",
        DEFAULT: "2px",
        sm: "1px",
        md: "2px",
        lg: "2px",
      },
      fontSize: {
        "2xs": ["10px", { lineHeight: "14px" }],
      },
      animation: {
        "cursor-blink": "cursor-blink 1.2s steps(1) infinite",
        heartbeat: "heartbeat 2s ease-in-out infinite",
        "verdict-pulse": "verdict-pulse 0.3s ease-out 1",
        "ticker-fade": "ticker-fade 120ms ease-out both",
      },
      keyframes: {
        "cursor-blink": {
          "0%, 49%": { opacity: "1" },
          "50%, 100%": { opacity: "0" },
        },
        heartbeat: {
          "0%, 100%": { opacity: "0.4" },
          "50%": { opacity: "1" },
        },
        "verdict-pulse": {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0.6" },
        },
        "ticker-fade": {
          "0%": { opacity: "0" },
          "100%": { opacity: "1" },
        },
      },
    },
  },
  plugins: [],
};

export default config;
