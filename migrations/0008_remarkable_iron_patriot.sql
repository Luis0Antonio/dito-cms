CREATE TABLE `order_hook_deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`fired_at` integer NOT NULL,
	`event` text NOT NULL,
	`detail` text,
	`url` text NOT NULL,
	`ok` integer NOT NULL,
	`status` integer,
	`error` text
);
--> statement-breakpoint
CREATE INDEX `order_hook_deliveries_fired_idx` ON `order_hook_deliveries` (`fired_at`);