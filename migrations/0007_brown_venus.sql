CREATE TABLE `checkout_hits` (
	`key` text PRIMARY KEY NOT NULL,
	`count` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `counters` (
	`name` text PRIMARY KEY NOT NULL,
	`value` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `order_items` (
	`id` text PRIMARY KEY NOT NULL,
	`order_id` text NOT NULL,
	`product_id` text,
	`name` text NOT NULL,
	`sku` text,
	`unit_amount` integer NOT NULL,
	`quantity` integer NOT NULL,
	`total_amount` integer NOT NULL,
	`image_media_id` text,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`image_media_id`) REFERENCES `media`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "order_items_quantity_chk" CHECK("order_items"."quantity" > 0)
);
--> statement-breakpoint
CREATE INDEX `order_items_order_idx` ON `order_items` (`order_id`);--> statement-breakpoint
CREATE TABLE `orders` (
	`id` text PRIMARY KEY NOT NULL,
	`number` integer NOT NULL,
	`access_token` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`email` text NOT NULL,
	`customer_name` text,
	`customer_phone` text,
	`shipping_address` text,
	`note` text,
	`currency` text NOT NULL,
	`subtotal_amount` integer NOT NULL,
	`shipping_amount` integer DEFAULT 0 NOT NULL,
	`total_amount` integer NOT NULL,
	`stock_conflict` integer DEFAULT 0 NOT NULL,
	`idempotency_key` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`paid_at` integer,
	`fulfilled_at` integer,
	`cancelled_at` integer,
	CONSTRAINT "orders_status_chk" CHECK("orders"."status" in ('pending', 'awaiting_payment', 'paid', 'fulfilled', 'cancelled', 'failed', 'refunded'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `orders_number_unq` ON `orders` (`number`);--> statement-breakpoint
CREATE UNIQUE INDEX `orders_idempotency_key_unq` ON `orders` (`idempotency_key`) WHERE "orders"."idempotency_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `orders_status_created_idx` ON `orders` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `orders_email_idx` ON `orders` (`email`);--> statement-breakpoint
CREATE INDEX `orders_created_idx` ON `orders` (`created_at`);--> statement-breakpoint
CREATE TABLE `payment_events` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`event_id` text NOT NULL,
	`type` text NOT NULL,
	`order_id` text,
	`payload` text,
	`processed_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `payment_events_provider_event_unq` ON `payment_events` (`provider`,`event_id`);--> statement-breakpoint
CREATE TABLE `payments` (
	`id` text PRIMARY KEY NOT NULL,
	`order_id` text NOT NULL,
	`provider` text NOT NULL,
	`provider_ref` text,
	`status` text NOT NULL,
	`amount` integer NOT NULL,
	`currency` text NOT NULL,
	`error_code` text,
	`error_message` text,
	`raw` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "payments_status_chk" CHECK("payments"."status" in ('created', 'paid', 'failed', 'refunded'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `payments_provider_ref_unq` ON `payments` (`provider`,`provider_ref`) WHERE "payments"."provider_ref" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `payments_order_idx` ON `payments` (`order_id`);--> statement-breakpoint
INSERT INTO `counters` ("name", "value") VALUES ('order_number', 0);