CREATE TABLE "tokens" (
	"mint" text PRIMARY KEY NOT NULL,
	"symbol" text,
	"name" text,
	"mc_usd" numeric,
	"price_usd" numeric,
	"mc_24h_pct" numeric,
	"liquidity_usd" numeric,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_refreshed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "tokens_last_refreshed_idx" ON "tokens" USING btree ("last_refreshed_at" DESC NULLS LAST);