CREATE TABLE IF NOT EXISTS "pull_request_review_state" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"repo_full_name" text NOT NULL,
	"pr_number" integer NOT NULL,
	"pr_created_at" timestamp with time zone NOT NULL,
	"author_login" text,
	"title" text,
	"url" text,
	"is_draft" boolean DEFAULT false NOT NULL,
	"requests_readable" boolean DEFAULT false NOT NULL,
	"pending_review_requests" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"reviews_readable" boolean DEFAULT false NOT NULL,
	"reviews" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"unreadable_reason" text,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pull_request_review_state" ADD CONSTRAINT "pull_request_review_state_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "pull_request_review_state_company_repo_pr_uniq" ON "pull_request_review_state" USING btree ("company_id","repo_full_name","pr_number");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pull_request_review_state_company_created_idx" ON "pull_request_review_state" USING btree ("company_id","pr_created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pull_request_review_state_company_repo_idx" ON "pull_request_review_state" USING btree ("company_id","repo_full_name");
