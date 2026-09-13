-- Keys can be absent or shared in imported events; daily accounting is always
-- isolated by project. Replacing the index preserves all historical rows.
DROP INDEX IF EXISTS `DailySpend_apiKey_date_model_provider_key`;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `DailySpend_projectId_apiKey_date_model_provider_key`
  ON `DailySpend` (`projectId`, `apiKey`, `date`, `model`, `provider`);
