-- The preview already added display_name on some installations. Rebuild once
-- so either table shape can upgrade without losing its conversation references.
CREATE TABLE `__new_teams_conversation_references` (
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
	`display_name` text,
	PRIMARY KEY(`integration_id`, `external_id`),
	FOREIGN KEY (`integration_id`) REFERENCES `chat_integrations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO __new_teams_conversation_references (
  integration_id, external_id, tenant_id, app_id, service_url, conversation_id,
  team_id, scope_id, scope_type, thread_root, originator_id, display_name
)
SELECT integration_id, external_id, tenant_id, app_id, service_url, conversation_id,
       team_id, scope_id, scope_type, thread_root, originator_id, display_name
FROM teams_conversation_references
-- A natural left join keeps the existing display_name if the column is present
-- and supplies the NULL column from the right if it is missing.
NATURAL LEFT JOIN (SELECT NULL AS display_name);
--> statement-breakpoint
DROP TABLE teams_conversation_references;
--> statement-breakpoint
ALTER TABLE __new_teams_conversation_references RENAME TO teams_conversation_references;
--> statement-breakpoint
UPDATE teams_conversation_references AS ref
SET display_name = (
  SELECT coalesce(access.title, CASE WHEN ref.scope_type = 'personal' THEN access.first_user_name END)
  FROM chat_integration_access AS access
  WHERE access.integration_id = ref.integration_id AND access.external_chat_id = ref.external_id
)
WHERE ref.thread_root IS NULL AND ref.display_name IS NULL;
--> statement-breakpoint
DELETE FROM chat_integration_access
WHERE integration_id IN (SELECT id FROM chat_integrations WHERE provider = 'teams');
