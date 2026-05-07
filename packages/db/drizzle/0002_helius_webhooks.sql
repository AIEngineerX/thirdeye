CREATE TABLE "helius_webhooks" (
	"id" integer PRIMARY KEY NOT NULL,
	"webhook_id" text NOT NULL,
	"last_synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_synced_address_count" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "watch_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"address" text NOT NULL,
	"signature" text NOT NULL,
	"type" text,
	"payload" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "watches" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"address" text NOT NULL,
	"label" text,
	"token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "watches" ADD CONSTRAINT "watches_token_auth_tokens_token_fk" FOREIGN KEY ("token") REFERENCES "public"."auth_tokens"("token") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "watch_events_address_idx" ON "watch_events" USING btree ("address","received_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "watches_address_idx" ON "watches" USING btree ("address");