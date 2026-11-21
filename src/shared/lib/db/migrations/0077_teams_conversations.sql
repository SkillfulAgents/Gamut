-- A database from the Teams preview already has these tables and their data.
CREATE TABLE IF NOT EXISTS `teams_cards` (
	`token` text PRIMARY KEY NOT NULL,
	`integration_id` text NOT NULL,
	`external_id` text NOT NULL,
	`request_id` text,
	`respondent_id` text NOT NULL,
	`activity_id` text,
	`payload` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`integration_id`) REFERENCES `chat_integrations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `teams_cards_request_idx` ON `teams_cards` (`integration_id`,`request_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `teams_conversation_references` (
	`integration_id` text NOT NULL,
	`external_id` text NOT NULL,
	`tenant_id` text NOT NULL,
	`app_id` text NOT NULL,
	`service_url` text NOT NULL,
	`conversation_id` text NOT NULL,
	`team_id` text,
	`scope_id` text NOT NULL,
	`scope_type` text NOT NULL,
	`thread_root` text,
	`originator_id` text NOT NULL,
	PRIMARY KEY(`integration_id`, `external_id`),
	FOREIGN KEY (`integration_id`) REFERENCES `chat_integrations`(`id`) ON UPDATE no action ON DELETE cascade
);
