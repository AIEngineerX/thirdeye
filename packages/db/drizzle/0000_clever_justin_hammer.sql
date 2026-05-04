CREATE TABLE "auth_tokens" (
	"token" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone DEFAULT now() + interval '7 days' NOT NULL,
	"rate_bucket" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "funders" (
	"address" text PRIMARY KEY NOT NULL,
	"fanout_count" integer DEFAULT 0 NOT NULL,
	"cluster_count" integer DEFAULT 0 NOT NULL,
	"first_seen" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "intel_aggregates" (
	"key" text PRIMARY KEY NOT NULL,
	"payload" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "token_scans" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"mint" text NOT NULL,
	"symbol" text,
	"name" text,
	"launchpad" text,
	"total_holders" integer,
	"scanned_holders" integer,
	"cluster_count" integer,
	"clustered_pct" numeric,
	"lp_pct" numeric,
	"locked_pct" numeric,
	"risk_pct" numeric,
	"sybil_flag" boolean DEFAULT false NOT NULL,
	"verdict" text,
	"payload" jsonb NOT NULL,
	"scanned_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wallet_checks" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"address" text NOT NULL,
	"score" integer NOT NULL,
	"verdict" text NOT NULL,
	"payload" jsonb NOT NULL,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wallets" (
	"address" text PRIMARY KEY NOT NULL,
	"first_funder" text,
	"funded_at" timestamp with time zone,
	"sol_balance" numeric,
	"usd_value" numeric,
	"tx_count" integer,
	"age_days" integer,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"last_checked" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "wallet_checks" ADD CONSTRAINT "wallet_checks_address_wallets_address_fk" FOREIGN KEY ("address") REFERENCES "public"."wallets"("address") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "funders_fanout_idx" ON "funders" USING btree ("fanout_count" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "token_scans_mint_idx" ON "token_scans" USING btree ("mint","scanned_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "wallet_checks_address_idx" ON "wallet_checks" USING btree ("address","checked_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "wallets_first_funder_idx" ON "wallets" USING btree ("first_funder");--> statement-breakpoint
CREATE INDEX "wallets_tags_idx" ON "wallets" USING gin ("tags");