PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_signals` (
	`id` text PRIMARY KEY NOT NULL,
	`watcher_name` text NOT NULL,
	`source_type` text NOT NULL,
	`title` text NOT NULL,
	`url` text NOT NULL,
	`summary` text,
	`published_at` text,
	`detected_at` text NOT NULL,
	`metadata` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_signals`("id", "watcher_name", "source_type", "title", "url", "summary", "published_at", "detected_at", "metadata") SELECT "id", "watcher_name", "source_type", "title", "url", "summary", "published_at", "detected_at", "metadata" FROM `signals`;--> statement-breakpoint
DROP TABLE `signals`;--> statement-breakpoint
ALTER TABLE `__new_signals` RENAME TO `signals`;--> statement-breakpoint
PRAGMA foreign_keys=ON;