CREATE TABLE `apikey` ( `id` text PRIMARY KEY, `projectId` text NOT NULL, `publicKey` text NOT NULL UNIQUE, `keyName` text, `spend` real DEFAULT 0 NOT NULL, `models` text DEFAULT '[]' NOT NULL, `metadata` text DEFAULT '{}' NOT NULL, `maxParallel` integer, `tpmLimit` integer, `rpmLimit` integer, `maxBudget` real, `budgetId` text, `isEnabled` integer DEFAULT true NOT NULL, `lastActive` text, `createdAt` text NOT NULL, `updatedAt` text NOT NULL, CONSTRAINT `fk_apikey_budgetId_budget_id_fk` FOREIGN KEY (`budgetId`) REFERENCES `budget`(`id`) );
--> statement-breakpoint
CREATE TABLE `auditlog` ( `id` text PRIMARY KEY, `projectId` text DEFAULT '' NOT NULL, `action` text NOT NULL, `tableName` text NOT NULL, `objectId` text NOT NULL, `beforeValue` text, `afterValue` text, `changedBy` text DEFAULT '' NOT NULL, `createdAt` text NOT NULL );
--> statement-breakpoint
CREATE TABLE `budget` ( `id` text PRIMARY KEY, `projectId` text NOT NULL, `maxBudget` real, `softBudget` real, `maxParallel` integer, `tpmLimit` integer, `rpmLimit` integer, `duration` text, `resetAt` text, `modelMaxBudget` text, `createdAt` text NOT NULL, `updatedAt` text NOT NULL );
--> statement-breakpoint
CREATE TABLE `credential` ( `id` text PRIMARY KEY, `projectId` text NOT NULL, `name` text NOT NULL, `values` text NOT NULL, `info` text, `createdAt` text NOT NULL, `updatedAt` text NOT NULL );
--> statement-breakpoint
CREATE TABLE `dailyspend` ( `id` text PRIMARY KEY, `projectId` text DEFAULT '' NOT NULL, `apiKey` text NOT NULL, `date` text NOT NULL, `model` text, `modelGroup` text, `provider` text, `promptTokens` integer DEFAULT 0 NOT NULL, `completionTokens` integer DEFAULT 0 NOT NULL, `spend` real DEFAULT 0 NOT NULL, `apiRequests` integer DEFAULT 0 NOT NULL, `successfulRequests` integer DEFAULT 0 NOT NULL, `failedRequests` integer DEFAULT 0 NOT NULL, `createdAt` text NOT NULL, `updatedAt` text NOT NULL );
--> statement-breakpoint
CREATE TABLE `errorlog` ( `id` text PRIMARY KEY, `projectId` text DEFAULT '' NOT NULL, `startTime` text NOT NULL, `endTime` text NOT NULL, `apiBase` text DEFAULT '' NOT NULL, `modelGroup` text DEFAULT '' NOT NULL, `providerModel` text DEFAULT '' NOT NULL, `modelId` text DEFAULT '' NOT NULL, `requestKwargs` text DEFAULT '{}' NOT NULL, `exceptionType` text DEFAULT '' NOT NULL, `exceptionString` text DEFAULT '' NOT NULL, `statusCode` text DEFAULT '' NOT NULL );
--> statement-breakpoint
CREATE TABLE `modeldeployment` ( `id` text PRIMARY KEY, `projectId` text NOT NULL, `modelName` text NOT NULL, `providerId` text NOT NULL, `providerModel` text NOT NULL, `litellmParams` text DEFAULT '{}' NOT NULL, `modelInfo` text, `isEnabled` integer DEFAULT true NOT NULL, `createdAt` text NOT NULL, `updatedAt` text NOT NULL, CONSTRAINT `fk_modeldeployment_providerId_provider_id_fk` FOREIGN KEY (`providerId`) REFERENCES `provider`(`id`) );
--> statement-breakpoint
CREATE TABLE `provider` ( `id` text PRIMARY KEY, `projectId` text NOT NULL, `name` text NOT NULL, `type` text NOT NULL, `credentialId` text, `baseUrl` text NOT NULL, `apiKeyEncrypted` text, `isEnabled` integer DEFAULT true NOT NULL, `budgetLimit` real, `budgetPeriod` text, `budgetSpend` real DEFAULT 0 NOT NULL, `budgetResetAt` text, `status` text DEFAULT 'healthy' NOT NULL, `cooldownUntil` text, `createdAt` text NOT NULL, `updatedAt` text NOT NULL );
--> statement-breakpoint
CREATE TABLE `spendlog` ( `id` text PRIMARY KEY, `projectId` text DEFAULT '' NOT NULL, `callType` text NOT NULL, `apiKey` text DEFAULT '' NOT NULL, `spend` real DEFAULT 0 NOT NULL, `totalTokens` integer DEFAULT 0 NOT NULL, `promptTokens` integer DEFAULT 0 NOT NULL, `completionTokens` integer DEFAULT 0 NOT NULL, `startTime` text NOT NULL, `endTime` text NOT NULL, `completionStartTime` text, `requestDurationMs` integer, `model` text DEFAULT '' NOT NULL, `modelId` text, `modelGroup` text, `provider` text, `apiBase` text, `protocol` text, `user` text, `metadata` text DEFAULT '{}' NOT NULL, `requestTags` text DEFAULT '[]' NOT NULL, `sessionId` text, `status` text, `messages` text, `response` text, `errorMessage` text, `traceId` text );
--> statement-breakpoint
CREATE INDEX `ApiKey_publicKey_idx` ON `apikey` (`publicKey`);
--> statement-breakpoint
CREATE INDEX `ApiKey_projectId_idx` ON `apikey` (`projectId`);
--> statement-breakpoint
CREATE INDEX `AuditLog_tableName_objectId_idx` ON `auditlog` (`tableName`,`objectId`);
--> statement-breakpoint
CREATE INDEX `AuditLog_createdAt_idx` ON `auditlog` (`createdAt`);
--> statement-breakpoint
CREATE INDEX `AuditLog_projectId_idx` ON `auditlog` (`projectId`);
--> statement-breakpoint
CREATE INDEX `Budget_projectId_idx` ON `budget` (`projectId`);
--> statement-breakpoint
CREATE UNIQUE INDEX `Credential_projectId_name_key` ON `credential` (`projectId`,`name`);
--> statement-breakpoint
CREATE INDEX `Credential_projectId_idx` ON `credential` (`projectId`);
--> statement-breakpoint
CREATE UNIQUE INDEX `DailySpend_projectId_apiKey_date_model_provider_key` ON `dailyspend` (`projectId`,`apiKey`,`date`,`model`,`provider`);
--> statement-breakpoint
CREATE INDEX `DailySpend_date_idx` ON `dailyspend` (`date`);
--> statement-breakpoint
CREATE INDEX `DailySpend_apiKey_date_idx` ON `dailyspend` (`apiKey`,`date`);
--> statement-breakpoint
CREATE INDEX `DailySpend_model_idx` ON `dailyspend` (`model`);
--> statement-breakpoint
CREATE INDEX `DailySpend_projectId_idx` ON `dailyspend` (`projectId`);
--> statement-breakpoint
CREATE INDEX `ErrorLog_startTime_idx` ON `errorlog` (`startTime`);
--> statement-breakpoint
CREATE INDEX `ErrorLog_projectId_idx` ON `errorlog` (`projectId`);
--> statement-breakpoint
CREATE INDEX `ModelDeployment_modelName_isEnabled_idx` ON `modeldeployment` (`modelName`,`isEnabled`);
--> statement-breakpoint
CREATE INDEX `ModelDeployment_projectId_idx` ON `modeldeployment` (`projectId`);
--> statement-breakpoint
CREATE UNIQUE INDEX `Provider_projectId_name_key` ON `provider` (`projectId`,`name`);
--> statement-breakpoint
CREATE INDEX `Provider_projectId_idx` ON `provider` (`projectId`);
--> statement-breakpoint
CREATE INDEX `SpendLog_startTime_idx` ON `spendlog` (`startTime`);
--> statement-breakpoint
CREATE INDEX `SpendLog_apiKey_startTime_idx` ON `spendlog` (`apiKey`,`startTime`);
--> statement-breakpoint
CREATE INDEX `SpendLog_model_startTime_idx` ON `spendlog` (`model`,`startTime`);
--> statement-breakpoint
CREATE INDEX `SpendLog_sessionId_idx` ON `spendlog` (`sessionId`);
--> statement-breakpoint
CREATE INDEX `SpendLog_projectId_idx` ON `spendlog` (`projectId`);
