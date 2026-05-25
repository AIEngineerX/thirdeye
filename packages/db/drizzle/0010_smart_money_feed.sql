CREATE TABLE "smart_trades" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"wallet" text NOT NULL,
	"mint" text NOT NULL,
	"symbol" text,
	"side" text NOT NULL,
	"sol_amount" numeric,
	"usd_value" numeric,
	"token_amount" numeric,
	"program" text,
	"signature" text NOT NULL,
	"traded_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "smart_trades_sig_wallet_uniq" UNIQUE("signature","wallet")
);
--> statement-breakpoint
CREATE TABLE "tracked_wallets" (
	"address" text PRIMARY KEY NOT NULL,
	"label" text,
	"source" text DEFAULT 'manual' NOT NULL,
	"win_rate" numeric,
	"realized_pnl_usd" numeric,
	"roi" numeric,
	"tokens_traded" integer,
	"identity" jsonb,
	"pnl_synced_at" timestamp with time zone,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "smart_trades_mint_side_time_idx" ON "smart_trades" USING btree ("mint","side","traded_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "smart_trades_traded_at_idx" ON "smart_trades" USING btree ("traded_at" DESC NULLS LAST);