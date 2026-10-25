-- CreateTable
CREATE TABLE "Project" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "folderId" TEXT NOT NULL,
    "rootPath" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "genre" TEXT NOT NULL,
    "subGenre" TEXT,
    "targetAudience" TEXT,
    "totalChapters" INTEGER,
    "wordsPerChapter" INTEGER,
    "narrativePov" TEXT,
    "coreIdea" TEXT,
    "premise" TEXT,
    "theme" TEXT,
    "toneContract" TEXT,
    "anchorLocked" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archivedAt" DATETIME
);

-- CreateTable
CREATE TABLE "EntityRevision" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "parentRevisionId" TEXT,
    "payload" TEXT NOT NULL,
    "changeSource" TEXT NOT NULL,
    "changeReason" TEXT,
    "generationRunId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "EntityRevision_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Character" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "gender" TEXT,
    "age" TEXT,
    "appearance" TEXT,
    "personality" TEXT,
    "background" TEXT,
    "abilities" TEXT,
    "motivation" TEXT,
    "relationships" TEXT,
    "arc" TEXT,
    "notes" TEXT,
    "curLocation" TEXT,
    "curTierId" TEXT,
    "curPhysical" TEXT,
    "curMental" TEXT,
    "curItems" TEXT,
    "curEvents" TEXT,
    "stateChapter" INTEGER,
    "stateProvenance" TEXT,
    "stateStale" BOOLEAN NOT NULL DEFAULT false,
    "stateStaleSince" INTEGER,
    "visualAnchor" TEXT,
    "deletedAt" DATETIME,
    CONSTRAINT "Character_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CharacterRelation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "fromId" TEXT NOT NULL,
    "toId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "strength" INTEGER NOT NULL DEFAULT 3,
    "sinceChapter" INTEGER,
    "untilChapter" INTEGER,
    "note" TEXT,
    CONSTRAINT "CharacterRelation_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CharacterSignature" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "characterId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "frequency" TEXT NOT NULL DEFAULT 'key_moment',
    "examples" TEXT,
    "firstUsedChapter" INTEGER,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "deletedAt" DATETIME,
    CONSTRAINT "CharacterSignature_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PowerSystem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    CONSTRAINT "PowerSystem_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PowerTier" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "systemId" TEXT NOT NULL,
    "level" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "breakthrough" TEXT,
    CONSTRAINT "PowerTier_systemId_fkey" FOREIGN KEY ("systemId") REFERENCES "PowerSystem" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "WorldRule" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "priority" TEXT NOT NULL,
    "deletedAt" DATETIME,
    CONSTRAINT "WorldRule_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "StoryArc" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "startChapter" INTEGER NOT NULL,
    "endChapter" INTEGER NOT NULL,
    "purpose" TEXT,
    "turningPoint" INTEGER,
    "order" INTEGER NOT NULL,
    CONSTRAINT "StoryArc_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Blueprint" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "chapterNo" INTEGER NOT NULL,
    "title" TEXT,
    "goal" TEXT NOT NULL,
    "conflict" TEXT NOT NULL,
    "turn" TEXT,
    "hook" TEXT NOT NULL,
    "castIds" TEXT NOT NULL,
    "locationId" TEXT,
    "storyDay" INTEGER,
    "storyTime" TEXT,
    "beatType" TEXT NOT NULL DEFAULT 'rising',
    "tensionLevel" INTEGER NOT NULL DEFAULT 3,
    "userGuidance" TEXT,
    "deletedAt" DATETIME,
    CONSTRAINT "Blueprint_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PlotThread" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "plantedChapter" INTEGER,
    "advancedChapters" TEXT NOT NULL,
    "resolvedChapter" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'active',
    "payoffHint" TEXT,
    "payoffWindow" INTEGER,
    "deletedAt" DATETIME,
    CONSTRAINT "PlotThread_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "StyleAsset" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "samples" TEXT NOT NULL,
    "bannedWords" TEXT NOT NULL,
    "bannedPatterns" TEXT NOT NULL,
    "quantLimits" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "deletedAt" DATETIME,
    CONSTRAINT "StyleAsset_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "WritingTechnique" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "arcId" TEXT,
    "chapterNo" INTEGER,
    "characterId" TEXT,
    "examples" TEXT,
    "priority" INTEGER NOT NULL DEFAULT 3,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    CONSTRAINT "WritingTechnique_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Location" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "region" TEXT,
    "description" TEXT,
    "x" REAL,
    "y" REAL,
    "deletedAt" DATETIME,
    CONSTRAINT "Location_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Route" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "fromId" TEXT NOT NULL,
    "toId" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "days" INTEGER NOT NULL,
    "condition" TEXT,
    "bidirectional" BOOLEAN NOT NULL DEFAULT true,
    CONSTRAINT "Route_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "LoreReference" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "query" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "title" TEXT,
    "url" TEXT,
    "snippet" TEXT,
    "content" TEXT,
    "fetchedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "usedInRunIds" TEXT,
    "approved" BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "LoreReference_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Chapter" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "chapterNo" INTEGER NOT NULL,
    "title" TEXT,
    "status" TEXT NOT NULL DEFAULT 'planned',
    "wordCount" INTEGER NOT NULL DEFAULT 0,
    "summary" TEXT,
    "summaryHash" TEXT,
    "summaryStale" BOOLEAN NOT NULL DEFAULT true,
    "finalizedAt" DATETIME,
    CONSTRAINT "Chapter_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ScenePlan" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "chapterNo" INTEGER NOT NULL,
    "sceneNo" INTEGER NOT NULL,
    "summary" TEXT NOT NULL,
    "locationId" TEXT,
    "castIds" TEXT,
    "transition" TEXT,
    "wordBudget" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'planned',
    "stale" BOOLEAN NOT NULL DEFAULT false,
    "latestRunId" TEXT,
    CONSTRAINT "ScenePlan_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "DraftSegment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "chapterNo" INTEGER NOT NULL,
    "sceneNo" INTEGER NOT NULL,
    "segId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "filePath" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "wordCount" INTEGER,
    "status" TEXT NOT NULL,
    "sourceRunId" TEXT,
    "acceptedAt" DATETIME,
    "deletedAt" DATETIME,
    CONSTRAINT "DraftSegment_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ProjectSetting" (
    "projectId" TEXT NOT NULL PRIMARY KEY,
    "unresolvedThreshold" INTEGER NOT NULL DEFAULT 5,
    "unresolvedMaxItems" INTEGER NOT NULL DEFAULT 10,
    "runningGagThreshold" INTEGER NOT NULL DEFAULT 8,
    "budgetWarnRatio" REAL NOT NULL DEFAULT 0.70,
    "budgetPromptRatio" REAL NOT NULL DEFAULT 0.85,
    "budgetForceRatio" REAL NOT NULL DEFAULT 0.95,
    "budgetTokens" INTEGER,
    "generationMode" TEXT NOT NULL DEFAULT 'whole',
    "versionMode" TEXT NOT NULL DEFAULT 'git',
    "defaultTextModel" TEXT NOT NULL DEFAULT 'deepseek-flash',
    "defaultImageModel" TEXT NOT NULL DEFAULT 'Tongyi-MAI/Z-Image-Turbo',
    "defaultVisionModel" TEXT,
    CONSTRAINT "ProjectSetting_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ModelProfile" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "contextWindow" INTEGER NOT NULL,
    "maxOutput" INTEGER NOT NULL,
    "inputPricePerM" REAL,
    "outputPricePerM" REAL,
    "cacheHitPricePerM" REAL,
    "supportsVision" BOOLEAN NOT NULL DEFAULT false,
    "supportsCache" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    CONSTRAINT "ModelProfile_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PromptTemplate" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "key" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "GenerationRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "chapterNo" INTEGER,
    "sceneNo" INTEGER,
    "parentRunId" TEXT,
    "commitState" TEXT NOT NULL DEFAULT 'pending',
    "purpose" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "params" TEXT,
    "promptTemplateId" TEXT,
    "assembledPrompt" TEXT NOT NULL,
    "tokenEstimate" INTEGER,
    "output" TEXT,
    "usageInput" INTEGER,
    "usageOutput" INTEGER,
    "cacheHitTokens" INTEGER,
    "costCents" INTEGER,
    "status" TEXT NOT NULL,
    "errorMessage" TEXT,
    "degradedReason" TEXT,
    "warnings" TEXT,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" DATETIME,
    CONSTRAINT "GenerationRun_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "QualityReview" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "runId" TEXT NOT NULL,
    "chapterNo" INTEGER NOT NULL,
    "score" INTEGER NOT NULL,
    "issues" TEXT,
    "note" TEXT,
    "promptVersion" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Asset" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "ownerType" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "assetType" TEXT NOT NULL,
    "prompt" TEXT,
    "provider" TEXT,
    "model" TEXT,
    "params" TEXT,
    "filePath" TEXT NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "mimeType" TEXT,
    "visualAnchor" TEXT,
    "anchorSource" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" DATETIME,
    CONSTRAINT "Asset_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "Project_folderId_key" ON "Project"("folderId");

-- CreateIndex
CREATE INDEX "EntityRevision_projectId_entityType_entityId_idx" ON "EntityRevision"("projectId", "entityType", "entityId");

-- CreateIndex
CREATE INDEX "EntityRevision_generationRunId_idx" ON "EntityRevision"("generationRunId");

-- CreateIndex
CREATE UNIQUE INDEX "EntityRevision_entityType_entityId_version_key" ON "EntityRevision"("entityType", "entityId", "version");

-- CreateIndex
CREATE INDEX "Character_projectId_deletedAt_idx" ON "Character"("projectId", "deletedAt");

-- CreateIndex
CREATE INDEX "CharacterRelation_projectId_fromId_idx" ON "CharacterRelation"("projectId", "fromId");

-- CreateIndex
CREATE INDEX "CharacterRelation_projectId_toId_idx" ON "CharacterRelation"("projectId", "toId");

-- CreateIndex
CREATE INDEX "CharacterSignature_projectId_characterId_idx" ON "CharacterSignature"("projectId", "characterId");

-- CreateIndex
CREATE UNIQUE INDEX "PowerTier_systemId_level_key" ON "PowerTier"("systemId", "level");

-- CreateIndex
CREATE INDEX "WorldRule_projectId_priority_idx" ON "WorldRule"("projectId", "priority");

-- CreateIndex
CREATE INDEX "StoryArc_projectId_order_idx" ON "StoryArc"("projectId", "order");

-- CreateIndex
CREATE UNIQUE INDEX "Blueprint_projectId_chapterNo_key" ON "Blueprint"("projectId", "chapterNo");

-- CreateIndex
CREATE INDEX "PlotThread_projectId_status_idx" ON "PlotThread"("projectId", "status");

-- CreateIndex
CREATE INDEX "WritingTechnique_projectId_scope_idx" ON "WritingTechnique"("projectId", "scope");

-- CreateIndex
CREATE INDEX "Route_projectId_fromId_toId_idx" ON "Route"("projectId", "fromId", "toId");

-- CreateIndex
CREATE INDEX "LoreReference_projectId_approved_idx" ON "LoreReference"("projectId", "approved");

-- CreateIndex
CREATE INDEX "Chapter_projectId_status_idx" ON "Chapter"("projectId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Chapter_projectId_chapterNo_key" ON "Chapter"("projectId", "chapterNo");

-- CreateIndex
CREATE UNIQUE INDEX "ScenePlan_projectId_chapterNo_sceneNo_key" ON "ScenePlan"("projectId", "chapterNo", "sceneNo");

-- CreateIndex
CREATE INDEX "DraftSegment_projectId_chapterNo_sceneNo_seq_idx" ON "DraftSegment"("projectId", "chapterNo", "sceneNo", "seq");

-- CreateIndex
CREATE INDEX "DraftSegment_projectId_chapterNo_status_idx" ON "DraftSegment"("projectId", "chapterNo", "status");

-- CreateIndex
CREATE UNIQUE INDEX "DraftSegment_projectId_segId_key" ON "DraftSegment"("projectId", "segId");

-- CreateIndex
CREATE UNIQUE INDEX "PromptTemplate_key_version_key" ON "PromptTemplate"("key", "version");

-- CreateIndex
CREATE INDEX "GenerationRun_projectId_chapterNo_idx" ON "GenerationRun"("projectId", "chapterNo");

-- CreateIndex
CREATE INDEX "GenerationRun_commitState_startedAt_idx" ON "GenerationRun"("commitState", "startedAt");

-- CreateIndex
CREATE INDEX "Asset_projectId_ownerType_ownerId_idx" ON "Asset"("projectId", "ownerType", "ownerId");
