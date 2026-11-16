-- Litestone migration (database: chat)
-- Created:   2026-11-16T15:55:03.921Z
-- Class:     expand
-- Changes:
--     + Team  (new table)
--     + Profile  (new table)
--     + Channel  (new table)
--     + ChannelMember  (new table)
--     + Post  (new table)
--     + Thread  (new table)
--     + Reaction  (new table)
--     + FileInfo  (new table)


PRAGMA foreign_keys = OFF;
BEGIN;

-- ─── new tables ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "team" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "externalId" TEXT NOT NULL UNIQUE,
  "name" TEXT NOT NULL,
  "displayName" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "allowOpenInvite" INTEGER NOT NULL,
  "createdAt" TEXT,
  "updatedAt" TEXT,
  "deletedAt" TEXT,
  "missingSince" TEXT,
  CHECK ("type" IN ('open', 'invite'))
) STRICT;

CREATE TABLE IF NOT EXISTS "profile" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "externalId" TEXT NOT NULL UNIQUE,
  "username" TEXT NOT NULL,
  "firstName" TEXT NOT NULL,
  "lastName" TEXT NOT NULL,
  "nickname" TEXT NOT NULL,
  "email" TEXT,
  "roles" TEXT NOT NULL,
  "locale" TEXT,
  "isBot" INTEGER NOT NULL,
  "createdAt" TEXT,
  "updatedAt" TEXT,
  "deletedAt" TEXT,
  "missingSince" TEXT
) STRICT;

CREATE TABLE IF NOT EXISTS "channel" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "externalId" TEXT NOT NULL UNIQUE,
  "teamExternalId" TEXT,
  "creatorExternalId" TEXT,
  "type" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "displayName" TEXT NOT NULL,
  "header" TEXT NOT NULL,
  "purpose" TEXT NOT NULL,
  "lastPostAt" TEXT,
  "totalMessageCount" INTEGER NOT NULL,
  "totalMessageCountRoot" INTEGER NOT NULL DEFAULT 0,
  "lastRootPostAt" TEXT,
  "createdAt" TEXT,
  "updatedAt" TEXT,
  "deletedAt" TEXT,
  "missingSince" TEXT,
  CHECK ("type" IN ('open', 'private', 'direct', 'group'))
) STRICT;
CREATE INDEX IF NOT EXISTS "idx_channel_teamExternalId" ON "channel" ("teamExternalId");

CREATE TABLE IF NOT EXISTS "channel_member" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "externalId" TEXT NOT NULL UNIQUE,
  "channelExternalId" TEXT NOT NULL,
  "profileExternalId" TEXT NOT NULL,
  "roles" TEXT NOT NULL,
  "isAdmin" INTEGER NOT NULL,
  "lastViewedAt" TEXT,
  "messageCount" INTEGER NOT NULL,
  "mentionCount" INTEGER NOT NULL,
  "messageCountRoot" INTEGER NOT NULL DEFAULT 0,
  "mentionCountRoot" INTEGER NOT NULL DEFAULT 0,
  "muted" INTEGER NOT NULL DEFAULT 0,
  "updatedAt" TEXT,
  "missingSince" TEXT
) STRICT;
CREATE INDEX IF NOT EXISTS "idx_channel_member_channelExternalId_profileExternalId" ON "channel_member" ("channelExternalId", "profileExternalId");
CREATE INDEX IF NOT EXISTS "idx_channel_member_profileExternalId" ON "channel_member" ("profileExternalId");

CREATE TABLE IF NOT EXISTS "post" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "externalId" TEXT NOT NULL UNIQUE,
  "channelExternalId" TEXT NOT NULL,
  "profileExternalId" TEXT NOT NULL,
  "rootExternalId" TEXT,
  "message" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "isPinned" INTEGER NOT NULL,
  "props" TEXT NOT NULL,
  "hashtags" TEXT NOT NULL,
  "replyCount" INTEGER NOT NULL,
  "lastReplyAt" TEXT,
  "createdAt" TEXT,
  "updatedAt" TEXT,
  "editedAt" TEXT,
  "deletedAt" TEXT,
  "missingSince" TEXT
) STRICT;
CREATE INDEX IF NOT EXISTS "idx_post_channelExternalId_createdAt" ON "post" ("channelExternalId", "createdAt");
CREATE INDEX IF NOT EXISTS "idx_post_rootExternalId_createdAt" ON "post" ("rootExternalId", "createdAt");
CREATE INDEX IF NOT EXISTS "idx_post_profileExternalId" ON "post" ("profileExternalId");

CREATE TABLE IF NOT EXISTS "thread" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "externalId" TEXT NOT NULL UNIQUE,
  "rootExternalId" TEXT NOT NULL,
  "profileExternalId" TEXT NOT NULL,
  "replyCount" INTEGER NOT NULL,
  "lastReplyAt" TEXT,
  "lastViewedAt" TEXT,
  "unreadReplies" INTEGER NOT NULL,
  "unreadMentions" INTEGER NOT NULL,
  "isFollowing" INTEGER NOT NULL DEFAULT 1,
  "missingSince" TEXT
) STRICT;
CREATE INDEX IF NOT EXISTS "idx_thread_profileExternalId_lastReplyAt" ON "thread" ("profileExternalId", "lastReplyAt");
CREATE INDEX IF NOT EXISTS "idx_thread_rootExternalId" ON "thread" ("rootExternalId");

CREATE TABLE IF NOT EXISTS "reaction" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "externalId" TEXT NOT NULL UNIQUE,
  "postExternalId" TEXT NOT NULL,
  "profileExternalId" TEXT NOT NULL,
  "emojiName" TEXT NOT NULL,
  "createdAt" TEXT,
  "missingSince" TEXT
) STRICT;
CREATE INDEX IF NOT EXISTS "idx_reaction_postExternalId" ON "reaction" ("postExternalId");
CREATE INDEX IF NOT EXISTS "idx_reaction_profileExternalId" ON "reaction" ("profileExternalId");

CREATE TABLE IF NOT EXISTS "file_info" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "externalId" TEXT NOT NULL UNIQUE,
  "postExternalId" TEXT,
  "profileExternalId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "extension" TEXT NOT NULL,
  "size" INTEGER NOT NULL,
  "mimeType" TEXT NOT NULL,
  "width" INTEGER,
  "height" INTEGER,
  "hasPreviewImage" INTEGER NOT NULL,
  "createdAt" TEXT,
  "updatedAt" TEXT,
  "deletedAt" TEXT,
  "missingSince" TEXT
) STRICT;
CREATE INDEX IF NOT EXISTS "idx_file_info_postExternalId" ON "file_info" ("postExternalId");
CREATE INDEX IF NOT EXISTS "idx_file_info_profileExternalId" ON "file_info" ("profileExternalId");

COMMIT;
PRAGMA foreign_keys = ON;