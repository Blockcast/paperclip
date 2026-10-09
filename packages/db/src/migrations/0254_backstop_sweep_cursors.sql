CREATE TABLE IF NOT EXISTS "backstop_sweep_cursors" (
	"sweep" text PRIMARY KEY NOT NULL,
	"cursor" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
