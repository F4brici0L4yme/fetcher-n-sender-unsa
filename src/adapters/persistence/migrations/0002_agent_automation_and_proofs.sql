CREATE TYPE "public"."agent_delivery_policy" AS ENUM('confirm_in_panel', 'direct_on_exact_match');--> statement-breakpoint
CREATE TYPE "public"."agent_proposal_state" AS ENUM('pending', 'authorized', 'rejected');--> statement-breakpoint
ALTER TABLE "deliveries" ADD COLUMN "proof_storage_key" text;--> statement-breakpoint
ALTER TABLE "deliveries" ADD COLUMN "proof_captured_at" timestamp with time zone;--> statement-breakpoint
CREATE TABLE "account_automation_settings" (
	"account_id" text PRIMARY KEY NOT NULL,
	"delivery_policy" "agent_delivery_policy" DEFAULT 'confirm_in_panel' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_delivery_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" text NOT NULL,
	"source" text NOT NULL,
	"instruction" text NOT NULL,
	"task_id" uuid NOT NULL,
	"pdf_id" uuid NOT NULL,
	"state" "agent_proposal_state" DEFAULT 'pending' NOT NULL,
	"delivery_job_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_proposal_source_length" CHECK (char_length(btrim("agent_delivery_proposals"."source")) BETWEEN 1 AND 40),
	CONSTRAINT "agent_proposal_instruction_length" CHECK (char_length("agent_delivery_proposals"."instruction") <= 500)
);
--> statement-breakpoint
ALTER TABLE "agent_delivery_proposals" ADD CONSTRAINT "agent_delivery_proposals_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_delivery_proposals" ADD CONSTRAINT "agent_delivery_proposals_delivery_job_id_jobs_id_fk" FOREIGN KEY ("delivery_job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_delivery_proposals" ADD CONSTRAINT "agent_delivery_proposals_task_id_pdf_id_pdfs_task_id_id_fk" FOREIGN KEY ("task_id","pdf_id") REFERENCES "public"."pdfs"("task_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_proposals_account_created" ON "agent_delivery_proposals" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE INDEX "agent_proposals_task_pdf" ON "agent_delivery_proposals" USING btree ("task_id","pdf_id");--> statement-breakpoint
CREATE TRIGGER account_automation_settings_account_mutation AFTER INSERT OR UPDATE OR DELETE ON public.account_automation_settings
FOR EACH ROW EXECUTE FUNCTION public.notify_account_mutation();
--> statement-breakpoint
CREATE TRIGGER agent_delivery_proposals_account_mutation AFTER INSERT OR UPDATE OR DELETE ON public.agent_delivery_proposals
FOR EACH ROW EXECUTE FUNCTION public.notify_account_mutation();
