CREATE TABLE `categories` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`parent_id` text,
	`sort_order` real DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`parent_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `categories_slug_unq` ON `categories` (`slug`);--> statement-breakpoint
CREATE INDEX `categories_parent_idx` ON `categories` (`parent_id`);--> statement-breakpoint
CREATE INDEX `categories_sort_idx` ON `categories` (`sort_order`);--> statement-breakpoint
CREATE TABLE `product_fields` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`label` text NOT NULL,
	`type` text NOT NULL,
	`options` text DEFAULT '{}' NOT NULL,
	`sort_order` real DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "product_fields_type_chk" CHECK("product_fields"."type" in ('text', 'rich_text', 'number', 'boolean', 'picture', 'video', 'link'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `product_fields_name_unq` ON `product_fields` (`name`);--> statement-breakpoint
CREATE INDEX `product_fields_sort_idx` ON `product_fields` (`sort_order`);--> statement-breakpoint
CREATE TABLE `product_images` (
	`product_id` text NOT NULL,
	`media_id` text NOT NULL,
	`sort_order` real DEFAULT 0 NOT NULL,
	PRIMARY KEY(`product_id`, `media_id`),
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`media_id`) REFERENCES `media`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `product_images_product_sort_idx` ON `product_images` (`product_id`,`sort_order`);--> statement-breakpoint
CREATE TABLE `products` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`status` text DEFAULT 'draft' NOT NULL,
	`price_amount` integer DEFAULT 0 NOT NULL,
	`sku` text,
	`stock` integer,
	`category_id` text,
	`custom_data` text DEFAULT '{}' NOT NULL,
	`sort_order` real DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`created_by` text,
	`updated_by` text,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`updated_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "products_status_chk" CHECK("products"."status" in ('draft', 'active', 'archived'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `products_slug_unq` ON `products` (`slug`);--> statement-breakpoint
CREATE UNIQUE INDEX `products_sku_unq` ON `products` (`sku`) WHERE "products"."sku" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `products_status_sort_idx` ON `products` (`status`,`sort_order`);--> statement-breakpoint
CREATE INDEX `products_category_idx` ON `products` (`category_id`);