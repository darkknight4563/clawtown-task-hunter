-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "AgentStatus" AS ENUM ('active', 'inactive', 'suspended');

-- CreateEnum
CREATE TYPE "AccountOwnerType" AS ENUM ('agent', 'system');

-- CreateEnum
CREATE TYPE "TaskCategory" AS ENUM ('development', 'research', 'design', 'automation', 'data', 'content', 'moderation', 'other');

-- CreateEnum
CREATE TYPE "Currency" AS ENUM ('TTT', 'USDC', 'ETH');

-- CreateEnum
CREATE TYPE "TaskStatus" AS ENUM ('open', 'bidding', 'awarded', 'in_progress', 'delivered', 'completed', 'cancelled', 'disputed');

-- CreateEnum
CREATE TYPE "BidStatus" AS ENUM ('pending', 'auto', 'accepted', 'rejected', 'withdrawn');

-- CreateEnum
CREATE TYPE "DeliverableStatus" AS ENUM ('submitted', 'approved', 'rejected', 'disputed');

-- CreateEnum
CREATE TYPE "DisputePartyType" AS ENUM ('creator', 'agent', 'admin');

-- CreateEnum
CREATE TYPE "DisputeStatus" AS ENUM ('open', 'under_review', 'resolved', 'escalated');

-- CreateEnum
CREATE TYPE "LedgerTxType" AS ENUM ('escrow_lock', 'escrow_release', 'bid_fee', 'platform_fee', 'refund', 'reward', 'stake_lock', 'stake_release', 'stake_slash', 'payout', 'dispute_split', 'penalty');

-- CreateEnum
CREATE TYPE "LedgerRefType" AS ENUM ('task', 'bid', 'dispute', 'stake', 'manual');

-- CreateEnum
CREATE TYPE "LedgerTxStatus" AS ENUM ('pending', 'completed', 'failed', 'reversed');

-- CreateEnum
CREATE TYPE "StakeStatus" AS ENUM ('locked', 'released', 'slashed');

-- CreateEnum
CREATE TYPE "SettingValueType" AS ENUM ('string', 'number', 'boolean', 'json');

-- CreateEnum
CREATE TYPE "SettingCategory" AS ENUM ('fees', 'bidding', 'matching', 'notifications', 'safety', 'general', 'slack', 'monitoring', 'kill_switch', 'pulse', 'rescue', 'stalled');

-- CreateEnum
CREATE TYPE "AuditRunType" AS ENUM ('task_created', 'bid_placed', 'award_requested', 'award_confirm_started', 'award_confirm_completed', 'award_state_reconciled', 'award_confirmed', 'award_rejected', 'deliverable_submitted', 'deliverable_approved', 'dispute_opened', 'dispute_resolved', 'outbox_dispatch', 'channel_self_heal', 'creator_dm_sent', 'agent_dm_sent', 'slack_connected', 'slack_command', 'market_pulse', 'no_bid_rescue', 'stalled_chase', 'invariant_check', 'manual');

-- CreateEnum
CREATE TYPE "AuditStatus" AS ENUM ('ok', 'partial', 'error', 'pending_confirm', 'halted', 'skipped');

-- CreateEnum
CREATE TYPE "OutboxStatus" AS ENUM ('pending', 'sent', 'failed');

-- CreateEnum
CREATE TYPE "EventType" AS ENUM ('TASK_CREATED', 'TASK_UPDATED', 'TASK_AWARDED', 'TASK_COMPLETED', 'TASK_CANCELLED', 'TASK_STATUS_CHANGED', 'BID_PLACED', 'BID_ACCEPTED', 'BID_REJECTED', 'ESCROW_LOCK', 'STAKE_LOCK', 'STAKE_RELEASE', 'STAKE_SLASH', 'LEDGER_TX', 'PAYOUT', 'REFUND', 'DISPUTE_OPENED', 'DISPUTE_RESOLVED', 'DELIVERABLE_SUBMITTED', 'DELIVERABLE_APPROVED', 'AWARD_CONFIRM_COMPLETED', 'AWARD_STATE_RECONCILED', 'CREATOR_DM', 'AGENT_DM', 'DM_SENT', 'MARKET_PULSE', 'NO_BID_RESCUE', 'NO_BID_RESCUE_SUMMARY', 'STALLED_CHASE', 'STALLED_CHASE_SUMMARY', 'INVARIANT_FAIL', 'AUTOMATION_ERROR', 'DUPLICATE_BID_DETECTED', 'NEGATIVE_BALANCE', 'SUSPICIOUS_ACTIVITY', 'DEAD_LETTER', 'ERROR', 'SYSTEM_ALERT', 'BALANCE_LOW', 'SLACK_COMMAND_REQUEST');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "name" TEXT,
    "email" TEXT,
    "emailVerified" TIMESTAMP(3),
    "image" TEXT,
    "isAdmin" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Account" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerAccountId" TEXT NOT NULL,
    "refresh_token" TEXT,
    "access_token" TEXT,
    "expires_at" INTEGER,
    "token_type" TEXT,
    "scope" TEXT,
    "id_token" TEXT,
    "session_state" TEXT,

    CONSTRAINT "Account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "sessionToken" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expires" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VerificationToken" (
    "identifier" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expires" TIMESTAMP(3) NOT NULL
);

-- CreateTable
CREATE TABLE "Agent" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "name" TEXT NOT NULL,
    "handle" TEXT NOT NULL,
    "bio" TEXT,
    "skillTags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "reputationScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "totalTasksCompleted" INTEGER NOT NULL DEFAULT 0,
    "totalTasksWon" INTEGER NOT NULL DEFAULT 0,
    "winRate" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "status" "AgentStatus" NOT NULL DEFAULT 'active',
    "walletAddress" TEXT,
    "contactChannel" TEXT,
    "contactHandle" TEXT,
    "slackUserId" TEXT,
    "slackDmEnabled" BOOLEAN NOT NULL DEFAULT false,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Agent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Task" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "category" "TaskCategory" NOT NULL DEFAULT 'other',
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "budget" DOUBLE PRECISION NOT NULL,
    "currency" "Currency" NOT NULL DEFAULT 'TTT',
    "status" "TaskStatus" NOT NULL DEFAULT 'open',
    "creatorId" TEXT NOT NULL,
    "creatorHandle" TEXT,
    "creatorSlackUserId" TEXT,
    "awardedAgentId" TEXT,
    "awardedBidId" TEXT,
    "deadline" TIMESTAMP(3),
    "autoBidAttempted" BOOLEAN NOT NULL DEFAULT false,
    "autoBidAgentId" TEXT,
    "notes" TEXT,
    "isTest" BOOLEAN NOT NULL DEFAULT false,
    "lastActivityAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rescueRemindersSent" INTEGER NOT NULL DEFAULT 0,
    "stalledPingsSent" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Task_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Bid" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "agentHandle" TEXT,
    "bidAmount" DOUBLE PRECISION NOT NULL,
    "currency" "Currency" NOT NULL DEFAULT 'TTT',
    "etaHours" DOUBLE PRECISION,
    "message" TEXT,
    "status" "BidStatus" NOT NULL DEFAULT 'pending',
    "isAutoBid" BOOLEAN NOT NULL DEFAULT false,
    "matchScore" DOUBLE PRECISION,
    "matchReason" TEXT,
    "isTest" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Bid_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Deliverable" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "bidId" TEXT,
    "agentId" TEXT NOT NULL,
    "title" TEXT,
    "description" TEXT,
    "fileUrl" TEXT,
    "externalLink" TEXT,
    "status" "DeliverableStatus" NOT NULL DEFAULT 'submitted',
    "reviewerNotes" TEXT,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedAt" TIMESTAMP(3),
    "isTest" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "Deliverable_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Dispute" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "bidId" TEXT,
    "raisedById" TEXT,
    "raisedByType" "DisputePartyType" NOT NULL,
    "againstId" TEXT,
    "reason" TEXT NOT NULL,
    "evidenceUrls" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" "DisputeStatus" NOT NULL DEFAULT 'open',
    "resolutionNotes" TEXT,
    "resolvedById" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "payoutCreator" DOUBLE PRECISION,
    "payoutAgent" DOUBLE PRECISION,
    "isTest" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Dispute_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LedgerAccount" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "ownerType" "AccountOwnerType" NOT NULL,
    "agentId" TEXT,
    "currency" "Currency" NOT NULL DEFAULT 'TTT',
    "balance" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LedgerAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LedgerTransaction" (
    "id" TEXT NOT NULL,
    "fromAccountId" TEXT,
    "toAccountId" TEXT,
    "amount" DOUBLE PRECISION NOT NULL,
    "currency" "Currency" NOT NULL DEFAULT 'TTT',
    "type" "LedgerTxType" NOT NULL,
    "referenceId" TEXT,
    "referenceType" "LedgerRefType" NOT NULL,
    "description" TEXT,
    "status" "LedgerTxStatus" NOT NULL DEFAULT 'completed',
    "idempotencyKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LedgerTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Stake" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "bidId" TEXT,
    "agentId" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "currency" "Currency" NOT NULL DEFAULT 'TTT',
    "status" "StakeStatus" NOT NULL DEFAULT 'locked',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Stake_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlatformSetting" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "valueType" "SettingValueType" NOT NULL DEFAULT 'string',
    "description" TEXT,
    "category" "SettingCategory" NOT NULL DEFAULT 'general',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatformSetting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "taskId" TEXT,
    "runType" "AuditRunType" NOT NULL,
    "triggeredBy" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "matches" JSONB,
    "bidsPlaced" JSONB,
    "bidsSkipped" JSONB,
    "notificationsSent" JSONB,
    "ledgerActions" JSONB,
    "errors" JSONB,
    "status" "AuditStatus" NOT NULL,
    "rawPayload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EventOutbox" (
    "id" TEXT NOT NULL,
    "eventType" "EventType" NOT NULL,
    "referenceId" TEXT,
    "referenceType" TEXT,
    "payload" JSONB,
    "channel" TEXT,
    "recipientId" TEXT,
    "recipientHandle" TEXT,
    "message" TEXT,
    "status" "OutboxStatus" NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "sentAt" TIMESTAMP(3),
    "error" TEXT,
    "metadata" JSONB,
    "idempotencyKey" TEXT,
    "isTest" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EventOutbox_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Account_provider_providerAccountId_key" ON "Account"("provider", "providerAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "Session_sessionToken_key" ON "Session"("sessionToken");

-- CreateIndex
CREATE UNIQUE INDEX "VerificationToken_identifier_token_key" ON "VerificationToken"("identifier", "token");

-- CreateIndex
CREATE UNIQUE INDEX "Agent_userId_key" ON "Agent"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Agent_handle_key" ON "Agent"("handle");

-- CreateIndex
CREATE UNIQUE INDEX "LedgerAccount_ownerId_currency_key" ON "LedgerAccount"("ownerId", "currency");

-- CreateIndex
CREATE UNIQUE INDEX "LedgerTransaction_idempotencyKey_key" ON "LedgerTransaction"("idempotencyKey");

-- CreateIndex
CREATE INDEX "LedgerTransaction_referenceId_idx" ON "LedgerTransaction"("referenceId");

-- CreateIndex
CREATE UNIQUE INDEX "PlatformSetting_key_key" ON "PlatformSetting"("key");

-- CreateIndex
CREATE INDEX "AuditLog_taskId_idx" ON "AuditLog"("taskId");

-- CreateIndex
CREATE UNIQUE INDEX "EventOutbox_idempotencyKey_key" ON "EventOutbox"("idempotencyKey");

-- CreateIndex
CREATE INDEX "EventOutbox_status_idx" ON "EventOutbox"("status");

-- AddForeignKey
ALTER TABLE "Account" ADD CONSTRAINT "Account_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Agent" ADD CONSTRAINT "Agent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "Agent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_awardedAgentId_fkey" FOREIGN KEY ("awardedAgentId") REFERENCES "Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Bid" ADD CONSTRAINT "Bid_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Bid" ADD CONSTRAINT "Bid_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deliverable" ADD CONSTRAINT "Deliverable_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deliverable" ADD CONSTRAINT "Deliverable_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Dispute" ADD CONSTRAINT "Dispute_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerAccount" ADD CONSTRAINT "LedgerAccount_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerTransaction" ADD CONSTRAINT "LedgerTransaction_fromAccountId_fkey" FOREIGN KEY ("fromAccountId") REFERENCES "LedgerAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerTransaction" ADD CONSTRAINT "LedgerTransaction_toAccountId_fkey" FOREIGN KEY ("toAccountId") REFERENCES "LedgerAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Stake" ADD CONSTRAINT "Stake_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Stake" ADD CONSTRAINT "Stake_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

