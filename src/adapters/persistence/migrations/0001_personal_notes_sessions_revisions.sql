CREATE TYPE "public"."note_priority" AS ENUM('alta', 'media', 'baja');--> statement-breakpoint
CREATE TYPE "public"."note_status" AS ENUM('pendiente', 'completado');--> statement-breakpoint
CREATE TABLE "personal_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" text NOT NULL,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"priority" "note_priority" NOT NULL,
	"status" "note_status" DEFAULT 'pendiente' NOT NULL,
	"deadline_date" date,
	"deadline_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "personal_notes_title_length" CHECK (char_length(btrim("personal_notes"."title")) BETWEEN 1 AND 200),
	CONSTRAINT "personal_notes_description_length" CHECK (char_length("personal_notes"."description") <= 10000),
	CONSTRAINT "personal_notes_single_deadline" CHECK ("personal_notes"."deadline_date" IS NULL OR "personal_notes"."deadline_at" IS NULL)
);
--> statement-breakpoint
CREATE TABLE "browser_sessions" (
	"account_id" text PRIMARY KEY NOT NULL,
	"expected_identity" text NOT NULL,
	"state" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "browser_session_valid_state" CHECK ("browser_sessions"."state" IN ('disconnected','connecting','connected','expired','error'))
);
--> statement-breakpoint
CREATE TABLE "personal_browser_state" (
	"id" text PRIMARY KEY DEFAULT 'active' NOT NULL,
	"account_id" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "personal_browser_singleton" CHECK ("personal_browser_state"."id" = 'active')
);
--> statement-breakpoint
CREATE TABLE "account_revisions" (
	"account_id" text PRIMARY KEY NOT NULL,
	"revision" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX "personal_notes_account_status" ON "personal_notes" USING btree ("account_id","status");--> statement-breakpoint
-- Both the durable cursor and NOTIFY participate in the caller's transaction.
-- PostgreSQL only delivers notifications on commit, so rolled-back changes stay invisible.
CREATE FUNCTION public.advance_account_revision(changed_account text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO public.account_revisions(account_id, revision)
  VALUES (changed_account, 1)
  ON CONFLICT (account_id) DO UPDATE
    SET revision = public.account_revisions.revision + 1;
  PERFORM pg_notify('fetcher_tasks_changed', changed_account);
END;
$$;
--> statement-breakpoint
CREATE FUNCTION public.notify_account_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM public.advance_account_revision(OLD.account_id);
  ELSE
    IF TG_OP = 'UPDATE' AND OLD.account_id IS DISTINCT FROM NEW.account_id THEN
      PERFORM public.advance_account_revision(OLD.account_id);
    END IF;
    PERFORM public.advance_account_revision(NEW.account_id);
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER tasks_account_mutation AFTER INSERT OR UPDATE OR DELETE ON public.tasks
FOR EACH ROW EXECUTE FUNCTION public.notify_account_mutation();
--> statement-breakpoint
CREATE TRIGGER jobs_account_mutation AFTER INSERT OR UPDATE OR DELETE ON public.jobs
FOR EACH ROW EXECUTE FUNCTION public.notify_account_mutation();
--> statement-breakpoint
CREATE TRIGGER notes_account_mutation AFTER INSERT OR UPDATE OR DELETE ON public.personal_notes
FOR EACH ROW EXECUTE FUNCTION public.notify_account_mutation();
--> statement-breakpoint
CREATE TRIGGER browser_sessions_account_mutation AFTER INSERT OR UPDATE OR DELETE ON public.browser_sessions
FOR EACH ROW EXECUTE FUNCTION public.notify_account_mutation();
--> statement-breakpoint
CREATE TRIGGER personal_browser_state_account_mutation AFTER INSERT OR UPDATE OR DELETE ON public.personal_browser_state
FOR EACH ROW EXECUTE FUNCTION public.notify_account_mutation();
