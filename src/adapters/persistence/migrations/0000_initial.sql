CREATE TYPE "public"."destination" AS ENUM('aula_virtual', 'other', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."job_kind" AS ENUM('search', 'delivery');--> statement-breakpoint
CREATE TYPE "public"."job_state" AS ENUM('queued', 'authorized', 'running', 'completed', 'confirmed', 'failed', 'needs_verification');--> statement-breakpoint
CREATE TABLE "deliveries" (
	"job_id" uuid PRIMARY KEY NOT NULL,
	"task_id" uuid NOT NULL,
	"pdf_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"activity_url" text NOT NULL,
	"original_name" text NOT NULL,
	"sha256" text NOT NULL,
	"storage_key" text NOT NULL,
	"observed_activity_url" text,
	"visible_status" text,
	"observed_file_name" text,
	"portal_reference" text,
	CONSTRAINT "deliveries_task_id_pdf_id_unique" UNIQUE("task_id","pdf_id")
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" text NOT NULL,
	"kind" "job_kind" NOT NULL,
	"state" "job_state" NOT NULL,
	"summary" text,
	"verify_requested" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_state_matches_kind" CHECK (
    ("jobs"."kind" = 'search' AND "jobs"."state" IN ('queued', 'running', 'completed', 'failed'))
    OR ("jobs"."kind" = 'delivery' AND "jobs"."state" IN ('authorized', 'running', 'confirmed', 'failed', 'needs_verification'))
  ),
	CONSTRAINT "job_verification_only_when_uncertain" CHECK (NOT "jobs"."verify_requested" OR "jobs"."state" = 'needs_verification')
);
--> statement-breakpoint
CREATE TABLE "pdfs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"task_id" uuid NOT NULL,
	"original_name" text NOT NULL,
	"storage_key" text NOT NULL,
	"byte_size" bigint NOT NULL,
	"sha256" text NOT NULL,
	"current" boolean NOT NULL,
	CONSTRAINT "pdfs_storage_key_unique" UNIQUE("storage_key"),
	CONSTRAINT "pdfs_task_id_id_unique" UNIQUE("task_id","id"),
	CONSTRAINT "pdf_valid_size" CHECK ("pdfs"."byte_size" BETWEEN 1 AND 20971520)
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" text NOT NULL,
	"external_id" text NOT NULL,
	"course" text NOT NULL,
	"title" text NOT NULL,
	"activity_url" text NOT NULL,
	"deadline_date" date,
	"deadline_at" timestamp with time zone,
	"destination" "destination" NOT NULL,
	CONSTRAINT "tasks_account_id_external_id_unique" UNIQUE("account_id","external_id"),
	CONSTRAINT "task_single_deadline" CHECK ("tasks"."deadline_date" IS NULL OR "tasks"."deadline_at" IS NULL)
);
--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_task_id_pdf_id_pdfs_task_id_id_fk" FOREIGN KEY ("task_id","pdf_id") REFERENCES "public"."pdfs"("task_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pdfs" ADD CONSTRAINT "pdfs_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "jobs_queue" ON "jobs" USING btree ("account_id","state","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "pdf_one_current_per_task" ON "pdfs" USING btree ("task_id") WHERE "pdfs"."current";