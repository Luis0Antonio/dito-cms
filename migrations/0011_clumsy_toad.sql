PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_fields` (
	`id` text PRIMARY KEY NOT NULL,
	`collection_id` text NOT NULL,
	`name` text NOT NULL,
	`label` text NOT NULL,
	`type` text NOT NULL,
	`options` text DEFAULT '{}' NOT NULL,
	`sort_order` real DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`collection_id`) REFERENCES `collections`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "fields_type_chk" CHECK("__new_fields"."type" in ('text', 'rich_text', 'number', 'boolean', 'picture', 'video', 'link', 'reference', 'select'))
);
--> statement-breakpoint
INSERT INTO `__new_fields`("id", "collection_id", "name", "label", "type", "options", "sort_order", "created_at", "updated_at") SELECT "id", "collection_id", "name", "label", "type", "options", "sort_order", "created_at", "updated_at" FROM `fields`;--> statement-breakpoint
DROP TABLE `fields`;--> statement-breakpoint
ALTER TABLE `__new_fields` RENAME TO `fields`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `fields_collection_name_unq` ON `fields` (`collection_id`,`name`);--> statement-breakpoint
CREATE INDEX `fields_collection_sort_idx` ON `fields` (`collection_id`,`sort_order`);