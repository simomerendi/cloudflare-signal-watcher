CREATE TABLE `signals` (
	`id` text PRIMARY KEY NOT NULL,
	`watcher_name` text NOT NULL,
	`source_type` text NOT NULL,
	`title` text NOT NULL,
	`url` text NOT NULL,
	`summary` text,
	`published_at` text,
	`detected_at` text DEFAULT (datetime('now')) NOT NULL,
	`metadata` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `watchers` (
	`name` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`schedule` text NOT NULL,
	`config` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`last_checked_at` text
);
