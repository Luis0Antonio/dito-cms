CREATE TABLE `contact_form_fields` (
	`id` text PRIMARY KEY NOT NULL,
	`form_id` text NOT NULL,
	`name` text NOT NULL,
	`label` text NOT NULL,
	`type` text NOT NULL,
	`required` integer DEFAULT false NOT NULL,
	`options` text DEFAULT '{}' NOT NULL,
	`sort_order` real DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`form_id`) REFERENCES `contact_forms`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "contact_form_fields_type_chk" CHECK("contact_form_fields"."type" in ('text', 'email', 'textarea', 'number', 'checkbox', 'select'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `contact_form_fields_form_name_unq` ON `contact_form_fields` (`form_id`,`name`);--> statement-breakpoint
CREATE INDEX `contact_form_fields_sort_idx` ON `contact_form_fields` (`form_id`,`sort_order`);--> statement-breakpoint
CREATE TABLE `contact_form_submissions` (
	`id` text PRIMARY KEY NOT NULL,
	`form_id` text NOT NULL,
	`data` text NOT NULL,
	`ip_hash` text NOT NULL,
	`user_agent` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`form_id`) REFERENCES `contact_forms`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `contact_form_submissions_form_created_idx` ON `contact_form_submissions` (`form_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `contact_form_submissions_rate_idx` ON `contact_form_submissions` (`form_id`,`ip_hash`,`created_at`);--> statement-breakpoint
CREATE TABLE `contact_forms` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`public_key` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`rate_limit_max` integer DEFAULT 5 NOT NULL,
	`rate_limit_window_seconds` integer DEFAULT 60 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "contact_forms_rate_max_chk" CHECK("contact_forms"."rate_limit_max" between 1 and 1000),
	CONSTRAINT "contact_forms_rate_window_chk" CHECK("contact_forms"."rate_limit_window_seconds" between 10 and 86400)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `contact_forms_public_key_unq` ON `contact_forms` (`public_key`);--> statement-breakpoint
CREATE INDEX `contact_forms_created_idx` ON `contact_forms` (`created_at`);