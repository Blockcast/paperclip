CREATE TABLE IF NOT EXISTS "issue_comment_effects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seq" bigserial NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"comment_id" uuid NOT NULL,
	"effect_kind" text NOT NULL,
	"effect_key" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"payload" jsonb NOT NULL,
	"result" jsonb,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"claimed_at" timestamp with time zone,
	"claim_expires_at" timestamp with time zone,
	"processed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "issue_comment_effects" ADD CONSTRAINT "issue_comment_effects_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "issue_comment_effects" ADD CONSTRAINT "issue_comment_effects_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "issue_comment_effects" ADD CONSTRAINT "issue_comment_effects_comment_id_issue_comments_id_fk" FOREIGN KEY ("comment_id") REFERENCES "public"."issue_comments"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "issue_comment_effects_comment_effect_key_idx" ON "issue_comment_effects" USING btree ("comment_id","effect_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issue_comment_effects_status_seq_idx" ON "issue_comment_effects" USING btree ("status","seq");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issue_comment_effects_comment_seq_idx" ON "issue_comment_effects" USING btree ("comment_id","seq");
