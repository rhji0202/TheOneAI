-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "vector";

-- CreateEnum
CREATE TYPE "member_role" AS ENUM ('owner', 'admin', 'operator', 'viewer');

-- CreateEnum
CREATE TYPE "agent_version_status" AS ENUM ('draft', 'published', 'archived');

-- CreateEnum
CREATE TYPE "provider_kind" AS ENUM ('anthropic', 'openai_compatible', 'bedrock', 'vertex');

-- CreateEnum
CREATE TYPE "model_role" AS ENUM ('planner', 'executor', 'evaluator');

-- CreateEnum
CREATE TYPE "message_role" AS ENUM ('user', 'assistant', 'system');

-- CreateEnum
CREATE TYPE "task_status" AS ENUM ('queued', 'running', 'waiting_approval', 'paused', 'recovering', 'completed', 'failed', 'cancelled');

-- CreateEnum
CREATE TYPE "step_type" AS ENUM ('context', 'plan', 'tool', 'skill', 'evaluate', 'respond');

-- CreateEnum
CREATE TYPE "step_status" AS ENUM ('pending', 'running', 'succeeded', 'failed', 'skipped', 'waiting_approval', 'cancelled');

-- CreateEnum
CREATE TYPE "mcp_transport" AS ENUM ('streamable_http', 'stdio_sandbox');

-- CreateEnum
CREATE TYPE "mcp_auth_type" AS ENUM ('none', 'api_key', 'oauth');

-- CreateEnum
CREATE TYPE "mcp_server_status" AS ENUM ('draft', 'pending_review', 'connected', 'error', 'disabled');

-- CreateEnum
CREATE TYPE "trust_status" AS ENUM ('verified', 'needs_review', 'rejected');

-- CreateEnum
CREATE TYPE "mcp_tool_state" AS ENUM ('active', 'pending_change', 'removed');

-- CreateEnum
CREATE TYPE "schema_check" AS ENUM ('valid', 'warning', 'error');

-- CreateEnum
CREATE TYPE "security_check" AS ENUM ('passed', 'warning', 'failed');

-- CreateEnum
CREATE TYPE "permission_level" AS ENUM ('read', 'write', 'external_send', 'delete', 'financial');

-- CreateEnum
CREATE TYPE "approval_mode" AS ENUM ('auto', 'require_approval', 'always_approval', 'block');

-- CreateEnum
CREATE TYPE "approver" AS ENUM ('user', 'operator', 'user_and_operator');

-- CreateEnum
CREATE TYPE "rule_effect" AS ENUM ('require_operator', 'block');

-- CreateEnum
CREATE TYPE "risk_level" AS ENUM ('low', 'medium', 'high');

-- CreateEnum
CREATE TYPE "approval_status" AS ENUM ('pending', 'approved', 'rejected', 'expired', 'cancelled');

-- CreateEnum
CREATE TYPE "approval_scope" AS ENUM ('once', 'task');

-- CreateEnum
CREATE TYPE "decision" AS ENUM ('approve', 'reject');

-- CreateEnum
CREATE TYPE "tool_source" AS ENUM ('mcp', 'sandbox', 'builtin', 'skill_script');

-- CreateEnum
CREATE TYPE "tool_execution_status" AS ENUM ('running', 'succeeded', 'failed', 'timeout', 'denied', 'cancelled');

-- CreateEnum
CREATE TYPE "skill_source" AS ENUM ('upload', 'git', 'marketplace');

-- CreateEnum
CREATE TYPE "skill_status" AS ENUM ('active', 'pending_review', 'inactive', 'verification_failed');

-- CreateEnum
CREATE TYPE "verification_status" AS ENUM ('pending', 'passed', 'failed');

-- CreateEnum
CREATE TYPE "memory_type" AS ENUM ('episodic', 'semantic', 'procedural');

-- CreateEnum
CREATE TYPE "memory_scope" AS ENUM ('user', 'agent');

-- CreateEnum
CREATE TYPE "memory_source_type" AS ENUM ('user_message', 'tool_result', 'external_document', 'reflection', 'manual');

-- CreateEnum
CREATE TYPE "memory_status" AS ENUM ('active', 'quarantined');

-- CreateEnum
CREATE TYPE "artifact_origin" AS ENUM ('user_upload', 'task_output');

-- CreateEnum
CREATE TYPE "feedback_rating" AS ENUM ('helpful', 'not_helpful');

-- CreateEnum
CREATE TYPE "identity_mode" AS ENUM ('anonymous', 'signed_token');

-- CreateEnum
CREATE TYPE "actor_type" AS ENUM ('user', 'end_user', 'agent', 'system');

-- CreateEnum
CREATE TYPE "eval_run_status" AS ENUM ('queued', 'running', 'completed', 'failed');

-- CreateTable
CREATE TABLE "tenants" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "plan" TEXT NOT NULL DEFAULT 'standard',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "tenants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" "member_role" NOT NULL DEFAULT 'viewer',
    "password_hash" TEXT,
    "sso_subject" TEXT,
    "last_login_at" TIMESTAMPTZ(3),
    "disabled_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "end_users" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "external_id" TEXT,
    "anonymous_id" TEXT,
    "pseudonym" TEXT NOT NULL,
    "locale" TEXT,
    "last_seen_at" TIMESTAMPTZ(3),
    "erased_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "end_users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agents" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "avatar_url" TEXT,
    "published_version_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "archived_at" TIMESTAMPTZ(3),

    CONSTRAINT "agents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_versions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "agent_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "agent_version_status" NOT NULL DEFAULT 'draft',
    "welcome_message" TEXT NOT NULL,
    "system_prompt" TEXT NOT NULL,
    "execution_policy" JSONB NOT NULL,
    "memory_policy" JSONB NOT NULL,
    "change_note" TEXT,
    "created_by_id" UUID,
    "published_by_id" UUID,
    "published_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "agent_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "providers" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "provider_kind" NOT NULL,
    "base_url" TEXT,
    "secret_ref" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "providers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "model_configs" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "agent_version_id" UUID NOT NULL,
    "role" "model_role" NOT NULL,
    "provider_id" UUID NOT NULL,
    "model" TEXT NOT NULL,
    "max_output_tokens" INTEGER NOT NULL,
    "temperature" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "fallback_provider_id" UUID,
    "fallback_model" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "model_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_version_mcp_servers" (
    "tenant_id" UUID NOT NULL,
    "agent_version_id" UUID NOT NULL,
    "mcp_server_id" UUID NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "agent_version_mcp_servers_pkey" PRIMARY KEY ("agent_version_id","mcp_server_id")
);

-- CreateTable
CREATE TABLE "agent_version_skills" (
    "tenant_id" UUID NOT NULL,
    "agent_version_id" UUID NOT NULL,
    "skill_id" UUID NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "agent_version_skills_pkey" PRIMARY KEY ("agent_version_id","skill_id")
);

-- CreateTable
CREATE TABLE "conversations" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "agent_id" UUID NOT NULL,
    "end_user_id" UUID NOT NULL,
    "title" TEXT,
    "last_message_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "messages" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "role" "message_role" NOT NULL,
    "content" JSONB NOT NULL,
    "task_id" UUID,
    "idempotency_key" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tasks" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "agent_id" UUID NOT NULL,
    "agent_version_id" UUID NOT NULL,
    "registry_version_id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "end_user_id" UUID NOT NULL,
    "trigger_message_id" UUID,
    "title" TEXT NOT NULL,
    "status" "task_status" NOT NULL DEFAULT 'queued',
    "plan" JSONB,
    "plan_version" INTEGER NOT NULL DEFAULT 0,
    "total_steps" INTEGER,
    "completed_steps" INTEGER NOT NULL DEFAULT 0,
    "retry_count" INTEGER NOT NULL DEFAULT 0,
    "replan_count" INTEGER NOT NULL DEFAULT 0,
    "input_tokens" INTEGER NOT NULL DEFAULT 0,
    "output_tokens" INTEGER NOT NULL DEFAULT 0,
    "cost_amount" DECIMAL(14,6) NOT NULL DEFAULT 0,
    "cost_currency" CHAR(3) NOT NULL DEFAULT 'USD',
    "queue_job_id" TEXT,
    "worker_id" TEXT,
    "trace_id" TEXT,
    "last_checkpoint_step_id" UUID,
    "last_heartbeat_at" TIMESTAMPTZ(3),
    "pause_requested_at" TIMESTAMPTZ(3),
    "cancel_requested_at" TIMESTAMPTZ(3),
    "paused_reason" TEXT,
    "failure_code" TEXT,
    "failure_message" TEXT,
    "queued_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMPTZ(3),
    "finished_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_steps" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "plan_version" INTEGER NOT NULL,
    "plan_index" INTEGER,
    "type" "step_type" NOT NULL,
    "name" TEXT NOT NULL,
    "status" "step_status" NOT NULL DEFAULT 'pending',
    "parallel_group" TEXT,
    "summary" TEXT,
    "input" JSONB,
    "output" JSONB,
    "output_ref" TEXT,
    "evaluation" JSONB,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "input_tokens" INTEGER NOT NULL DEFAULT 0,
    "output_tokens" INTEGER NOT NULL DEFAULT 0,
    "checkpoint" JSONB,
    "checkpoint_ref" TEXT,
    "checkpoint_at" TIMESTAMPTZ(3),
    "started_at" TIMESTAMPTZ(3),
    "finished_at" TIMESTAMPTZ(3),
    "duration_ms" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "task_steps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_events" (
    "id" BIGSERIAL NOT NULL,
    "tenant_id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "task_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tool_registry_versions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "snapshot" JSONB NOT NULL,
    "change_summary" JSONB,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tool_registry_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mcp_servers" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "transport" "mcp_transport" NOT NULL,
    "endpoint_url" TEXT,
    "image" TEXT,
    "image_signature_verified" BOOLEAN NOT NULL DEFAULT false,
    "auth_type" "mcp_auth_type" NOT NULL DEFAULT 'none',
    "secret_ref" TEXT,
    "allowed_hosts" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "allow_private_network" BOOLEAN NOT NULL DEFAULT false,
    "status" "mcp_server_status" NOT NULL DEFAULT 'draft',
    "status_reason" TEXT,
    "trust" "trust_status" NOT NULL DEFAULT 'needs_review',
    "protocol_version" TEXT,
    "last_synced_at" TIMESTAMPTZ(3),
    "health_p95_ms" INTEGER,
    "health_error_rate" DOUBLE PRECISION,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "mcp_servers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mcp_tools" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "server_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "title" TEXT,
    "description" TEXT,
    "input_schema" JSONB NOT NULL,
    "output_schema" JSONB,
    "schema_hash" TEXT NOT NULL,
    "schema_check" "schema_check" NOT NULL,
    "schema_issues" JSONB,
    "security_check" "security_check" NOT NULL,
    "security_issues" JSONB,
    "permission_level" "permission_level" NOT NULL DEFAULT 'write',
    "approval_mode_override" "approval_mode",
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "state" "mcp_tool_state" NOT NULL DEFAULT 'active',
    "pending_change" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "mcp_tools_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tool_executions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "step_id" UUID NOT NULL,
    "registry_version_id" UUID NOT NULL,
    "source" "tool_source" NOT NULL,
    "mcp_tool_id" UUID,
    "tool_name" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "status" "tool_execution_status" NOT NULL DEFAULT 'running',
    "denied_reason" TEXT,
    "input" JSONB,
    "output" JSONB,
    "output_ref" TEXT,
    "error_code" TEXT,
    "error_message" TEXT,
    "sandbox" JSONB,
    "started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(3),
    "duration_ms" INTEGER,

    CONSTRAINT "tool_executions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tool_policies" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "level" "permission_level" NOT NULL,
    "mode" "approval_mode" NOT NULL,
    "approver" "approver",
    "allow_task_scope" BOOLEAN NOT NULL DEFAULT false,
    "ttl_seconds" INTEGER NOT NULL DEFAULT 900,
    "updated_by_id" UUID,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "tool_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tool_policy_rules" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "tool_pattern" TEXT,
    "level" "permission_level",
    "condition" JSONB NOT NULL,
    "effect" "rule_effect" NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "tool_policy_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approvals" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "step_id" UUID NOT NULL,
    "mcp_tool_id" UUID,
    "tool_name" TEXT NOT NULL,
    "permission_level" "permission_level" NOT NULL,
    "risk_level" "risk_level" NOT NULL,
    "args" JSONB NOT NULL,
    "args_hash" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "matched_rule_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "required_approver" "approver" NOT NULL,
    "status" "approval_status" NOT NULL DEFAULT 'pending',
    "scope" "approval_scope" NOT NULL DEFAULT 'once',
    "user_decision" "decision",
    "user_comment" TEXT,
    "user_decided_at" TIMESTAMPTZ(3),
    "operator_decision" "decision",
    "operator_id" UUID,
    "operator_comment" TEXT,
    "operator_decided_at" TIMESTAMPTZ(3),
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "resolved_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "approvals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "skills" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "source" "skill_source" NOT NULL,
    "git_repo_url" TEXT,
    "status" "skill_status" NOT NULL DEFAULT 'pending_review',
    "active_version_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "skills_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "skill_versions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "skill_id" UUID NOT NULL,
    "version" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "allowed_tools" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "frontmatter" JSONB NOT NULL,
    "content_hash" TEXT NOT NULL,
    "bundle_key" TEXT NOT NULL,
    "files" JSONB NOT NULL,
    "git_ref" TEXT,
    "git_commit" TEXT,
    "signature_verified" BOOLEAN NOT NULL DEFAULT false,
    "verification_status" "verification_status" NOT NULL DEFAULT 'pending',
    "verification" JSONB NOT NULL DEFAULT '[]',
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "skill_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memories" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "agent_id" UUID NOT NULL,
    "end_user_id" UUID,
    "type" "memory_type" NOT NULL,
    "scope" "memory_scope" NOT NULL,
    "title" TEXT,
    "content" TEXT NOT NULL,
    "embedding" vector(1536),
    "embedding_model" TEXT,
    "source_type" "memory_source_type" NOT NULL,
    "source_task_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "source_conversation_id" UUID,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "needs_verification" BOOLEAN NOT NULL DEFAULT false,
    "status" "memory_status" NOT NULL DEFAULT 'active',
    "quarantine_reason" TEXT,
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "use_count" INTEGER NOT NULL DEFAULT 0,
    "last_used_at" TIMESTAMPTZ(3),
    "expires_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "memories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "artifacts" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "task_id" UUID,
    "message_id" UUID,
    "end_user_id" UUID,
    "origin" "artifact_origin" NOT NULL,
    "file_name" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "size_bytes" BIGINT NOT NULL,
    "storage_key" TEXT NOT NULL,
    "sha256" TEXT,
    "previewable" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3),

    CONSTRAINT "artifacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "feedbacks" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "end_user_id" UUID NOT NULL,
    "rating" "feedback_rating" NOT NULL,
    "comment" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "feedbacks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "widget_configs" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "agent_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "public_key" TEXT NOT NULL,
    "secret_ref" TEXT NOT NULL,
    "previous_secret_ref" TEXT,
    "previous_secret_expires_at" TIMESTAMPTZ(3),
    "allowed_origins" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "identity_mode" "identity_mode" NOT NULL DEFAULT 'signed_token',
    "theme" JSONB NOT NULL,
    "behavior" JSONB NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "widget_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" BIGSERIAL NOT NULL,
    "tenant_id" UUID NOT NULL,
    "actor_type" "actor_type" NOT NULL,
    "actor_id" TEXT,
    "action" TEXT NOT NULL,
    "target_type" TEXT NOT NULL,
    "target_id" TEXT,
    "metadata" JSONB,
    "ip" INET,
    "user_agent" TEXT,
    "trace_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "metrics_daily" (
    "tenant_id" UUID NOT NULL,
    "agent_id" UUID NOT NULL,
    "date" DATE NOT NULL,
    "tasks_total" INTEGER NOT NULL DEFAULT 0,
    "tasks_succeeded" INTEGER NOT NULL DEFAULT 0,
    "tasks_failed" INTEGER NOT NULL DEFAULT 0,
    "tool_calls" INTEGER NOT NULL DEFAULT 0,
    "tool_succeeded" INTEGER NOT NULL DEFAULT 0,
    "tool_denied" INTEGER NOT NULL DEFAULT 0,
    "recoveries_attempted" INTEGER NOT NULL DEFAULT 0,
    "recoveries_succeeded" INTEGER NOT NULL DEFAULT 0,
    "human_interventions" INTEGER NOT NULL DEFAULT 0,
    "input_tokens" BIGINT NOT NULL DEFAULT 0,
    "output_tokens" BIGINT NOT NULL DEFAULT 0,
    "cost_amount" DECIMAL(16,6) NOT NULL DEFAULT 0,
    "total_duration_ms" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "metrics_daily_pkey" PRIMARY KEY ("tenant_id","agent_id","date")
);

-- CreateTable
CREATE TABLE "eval_cases" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "agent_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "input" TEXT NOT NULL,
    "criteria" JSONB NOT NULL,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "eval_cases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "eval_runs" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "agent_version_id" UUID NOT NULL,
    "status" "eval_run_status" NOT NULL DEFAULT 'queued',
    "case_count" INTEGER NOT NULL DEFAULT 0,
    "passed_count" INTEGER NOT NULL DEFAULT 0,
    "results" JSONB,
    "created_by_id" UUID,
    "started_at" TIMESTAMPTZ(3),
    "finished_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "eval_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tenants_slug_key" ON "tenants"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "users_tenant_id_email_key" ON "users"("tenant_id", "email");

-- CreateIndex
CREATE UNIQUE INDEX "end_users_tenant_id_external_id_key" ON "end_users"("tenant_id", "external_id");

-- CreateIndex
CREATE UNIQUE INDEX "end_users_tenant_id_anonymous_id_key" ON "end_users"("tenant_id", "anonymous_id");

-- CreateIndex
CREATE UNIQUE INDEX "end_users_tenant_id_pseudonym_key" ON "end_users"("tenant_id", "pseudonym");

-- CreateIndex
CREATE UNIQUE INDEX "agents_published_version_id_key" ON "agents"("published_version_id");

-- CreateIndex
CREATE UNIQUE INDEX "agents_tenant_id_name_key" ON "agents"("tenant_id", "name");

-- CreateIndex
CREATE INDEX "agent_versions_tenant_id_agent_id_status_idx" ON "agent_versions"("tenant_id", "agent_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "agent_versions_agent_id_version_key" ON "agent_versions"("agent_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "providers_tenant_id_name_key" ON "providers"("tenant_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "model_configs_agent_version_id_role_key" ON "model_configs"("agent_version_id", "role");

-- CreateIndex
CREATE INDEX "conversations_tenant_id_end_user_id_last_message_at_idx" ON "conversations"("tenant_id", "end_user_id", "last_message_at" DESC);

-- CreateIndex
CREATE INDEX "messages_conversation_id_created_at_idx" ON "messages"("conversation_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "messages_conversation_id_idempotency_key_key" ON "messages"("conversation_id", "idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "tasks_trigger_message_id_key" ON "tasks"("trigger_message_id");

-- CreateIndex
CREATE INDEX "tasks_tenant_id_status_idx" ON "tasks"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "tasks_tenant_id_end_user_id_created_at_idx" ON "tasks"("tenant_id", "end_user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "tasks_tenant_id_agent_id_created_at_idx" ON "tasks"("tenant_id", "agent_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "tasks_status_last_heartbeat_at_idx" ON "tasks"("status", "last_heartbeat_at");

-- CreateIndex
CREATE INDEX "task_steps_task_id_checkpoint_at_idx" ON "task_steps"("task_id", "checkpoint_at");

-- CreateIndex
CREATE UNIQUE INDEX "task_steps_task_id_seq_key" ON "task_steps"("task_id", "seq");

-- CreateIndex
CREATE INDEX "task_events_task_id_id_idx" ON "task_events"("task_id", "id");

-- CreateIndex
CREATE INDEX "task_events_created_at_idx" ON "task_events"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "tool_registry_versions_tenant_id_version_key" ON "tool_registry_versions"("tenant_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "mcp_servers_tenant_id_name_key" ON "mcp_servers"("tenant_id", "name");

-- CreateIndex
CREATE INDEX "mcp_tools_tenant_id_enabled_idx" ON "mcp_tools"("tenant_id", "enabled");

-- CreateIndex
CREATE UNIQUE INDEX "mcp_tools_server_id_name_key" ON "mcp_tools"("server_id", "name");

-- CreateIndex
CREATE INDEX "tool_executions_task_id_idx" ON "tool_executions"("task_id");

-- CreateIndex
CREATE INDEX "tool_executions_tenant_id_started_at_idx" ON "tool_executions"("tenant_id", "started_at");

-- CreateIndex
CREATE INDEX "tool_executions_tenant_id_status_started_at_idx" ON "tool_executions"("tenant_id", "status", "started_at");

-- CreateIndex
CREATE UNIQUE INDEX "tool_policies_tenant_id_level_key" ON "tool_policies"("tenant_id", "level");

-- CreateIndex
CREATE INDEX "tool_policy_rules_tenant_id_enabled_priority_idx" ON "tool_policy_rules"("tenant_id", "enabled", "priority");

-- CreateIndex
CREATE INDEX "approvals_tenant_id_status_expires_at_idx" ON "approvals"("tenant_id", "status", "expires_at");

-- CreateIndex
CREATE INDEX "approvals_task_id_idx" ON "approvals"("task_id");

-- CreateIndex
CREATE UNIQUE INDEX "skills_active_version_id_key" ON "skills"("active_version_id");

-- CreateIndex
CREATE UNIQUE INDEX "skills_tenant_id_name_key" ON "skills"("tenant_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "skill_versions_skill_id_version_key" ON "skill_versions"("skill_id", "version");

-- CreateIndex
CREATE INDEX "memories_tenant_id_agent_id_type_status_idx" ON "memories"("tenant_id", "agent_id", "type", "status");

-- CreateIndex
CREATE INDEX "memories_tenant_id_end_user_id_idx" ON "memories"("tenant_id", "end_user_id");

-- CreateIndex
CREATE INDEX "memories_expires_at_idx" ON "memories"("expires_at");

-- CreateIndex
CREATE INDEX "memories_content_trgm" ON "memories" USING GIN ("content" gin_trgm_ops);

-- CreateIndex
CREATE UNIQUE INDEX "artifacts_storage_key_key" ON "artifacts"("storage_key");

-- CreateIndex
CREATE INDEX "artifacts_task_id_idx" ON "artifacts"("task_id");

-- CreateIndex
CREATE INDEX "artifacts_tenant_id_created_at_idx" ON "artifacts"("tenant_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "feedbacks_task_id_end_user_id_key" ON "feedbacks"("task_id", "end_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "widget_configs_public_key_key" ON "widget_configs"("public_key");

-- CreateIndex
CREATE INDEX "widget_configs_tenant_id_idx" ON "widget_configs"("tenant_id");

-- CreateIndex
CREATE INDEX "audit_logs_tenant_id_created_at_idx" ON "audit_logs"("tenant_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "audit_logs_tenant_id_target_type_target_id_idx" ON "audit_logs"("tenant_id", "target_type", "target_id");

-- CreateIndex
CREATE INDEX "eval_runs_tenant_id_agent_version_id_idx" ON "eval_runs"("tenant_id", "agent_version_id");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "end_users" ADD CONSTRAINT "end_users_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agents" ADD CONSTRAINT "agents_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agents" ADD CONSTRAINT "agents_published_version_id_fkey" FOREIGN KEY ("published_version_id") REFERENCES "agent_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_versions" ADD CONSTRAINT "agent_versions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_versions" ADD CONSTRAINT "agent_versions_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "providers" ADD CONSTRAINT "providers_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "model_configs" ADD CONSTRAINT "model_configs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "model_configs" ADD CONSTRAINT "model_configs_agent_version_id_fkey" FOREIGN KEY ("agent_version_id") REFERENCES "agent_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "model_configs" ADD CONSTRAINT "model_configs_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "providers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "model_configs" ADD CONSTRAINT "model_configs_fallback_provider_id_fkey" FOREIGN KEY ("fallback_provider_id") REFERENCES "providers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_version_mcp_servers" ADD CONSTRAINT "agent_version_mcp_servers_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_version_mcp_servers" ADD CONSTRAINT "agent_version_mcp_servers_agent_version_id_fkey" FOREIGN KEY ("agent_version_id") REFERENCES "agent_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_version_mcp_servers" ADD CONSTRAINT "agent_version_mcp_servers_mcp_server_id_fkey" FOREIGN KEY ("mcp_server_id") REFERENCES "mcp_servers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_version_skills" ADD CONSTRAINT "agent_version_skills_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_version_skills" ADD CONSTRAINT "agent_version_skills_agent_version_id_fkey" FOREIGN KEY ("agent_version_id") REFERENCES "agent_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_version_skills" ADD CONSTRAINT "agent_version_skills_skill_id_fkey" FOREIGN KEY ("skill_id") REFERENCES "skills"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_end_user_id_fkey" FOREIGN KEY ("end_user_id") REFERENCES "end_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_agent_version_id_fkey" FOREIGN KEY ("agent_version_id") REFERENCES "agent_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_registry_version_id_fkey" FOREIGN KEY ("registry_version_id") REFERENCES "tool_registry_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_end_user_id_fkey" FOREIGN KEY ("end_user_id") REFERENCES "end_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_trigger_message_id_fkey" FOREIGN KEY ("trigger_message_id") REFERENCES "messages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_steps" ADD CONSTRAINT "task_steps_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_steps" ADD CONSTRAINT "task_steps_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_events" ADD CONSTRAINT "task_events_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_events" ADD CONSTRAINT "task_events_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tool_registry_versions" ADD CONSTRAINT "tool_registry_versions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mcp_tools" ADD CONSTRAINT "mcp_tools_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mcp_tools" ADD CONSTRAINT "mcp_tools_server_id_fkey" FOREIGN KEY ("server_id") REFERENCES "mcp_servers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tool_executions" ADD CONSTRAINT "tool_executions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tool_executions" ADD CONSTRAINT "tool_executions_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tool_executions" ADD CONSTRAINT "tool_executions_step_id_fkey" FOREIGN KEY ("step_id") REFERENCES "task_steps"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tool_executions" ADD CONSTRAINT "tool_executions_registry_version_id_fkey" FOREIGN KEY ("registry_version_id") REFERENCES "tool_registry_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tool_executions" ADD CONSTRAINT "tool_executions_mcp_tool_id_fkey" FOREIGN KEY ("mcp_tool_id") REFERENCES "mcp_tools"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tool_policies" ADD CONSTRAINT "tool_policies_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tool_policy_rules" ADD CONSTRAINT "tool_policy_rules_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_step_id_fkey" FOREIGN KEY ("step_id") REFERENCES "task_steps"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_mcp_tool_id_fkey" FOREIGN KEY ("mcp_tool_id") REFERENCES "mcp_tools"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "skills" ADD CONSTRAINT "skills_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "skills" ADD CONSTRAINT "skills_active_version_id_fkey" FOREIGN KEY ("active_version_id") REFERENCES "skill_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "skill_versions" ADD CONSTRAINT "skill_versions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "skill_versions" ADD CONSTRAINT "skill_versions_skill_id_fkey" FOREIGN KEY ("skill_id") REFERENCES "skills"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memories" ADD CONSTRAINT "memories_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memories" ADD CONSTRAINT "memories_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memories" ADD CONSTRAINT "memories_end_user_id_fkey" FOREIGN KEY ("end_user_id") REFERENCES "end_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_end_user_id_fkey" FOREIGN KEY ("end_user_id") REFERENCES "end_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feedbacks" ADD CONSTRAINT "feedbacks_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feedbacks" ADD CONSTRAINT "feedbacks_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feedbacks" ADD CONSTRAINT "feedbacks_end_user_id_fkey" FOREIGN KEY ("end_user_id") REFERENCES "end_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "widget_configs" ADD CONSTRAINT "widget_configs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "widget_configs" ADD CONSTRAINT "widget_configs_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "metrics_daily" ADD CONSTRAINT "metrics_daily_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "metrics_daily" ADD CONSTRAINT "metrics_daily_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "eval_cases" ADD CONSTRAINT "eval_cases_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "eval_cases" ADD CONSTRAINT "eval_cases_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "eval_runs" ADD CONSTRAINT "eval_runs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "eval_runs" ADD CONSTRAINT "eval_runs_agent_version_id_fkey" FOREIGN KEY ("agent_version_id") REFERENCES "agent_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ============ prisma/sql/001_rls_and_indexes.sql ============
-- =============================================================================
-- 001_rls_and_indexes.sql
--
-- Prisma 가 만들지 않는 DB 객체:
--   1) 애플리케이션 역할과 권한
--   2) Tenant 격리 RLS 정책
--   3) 테넌트가 정해지기 전에 필요한 조회용 SECURITY DEFINER 함수
--   4) 부분 · 벡터 인덱스, CHECK 제약
--      (Prisma 는 부분 인덱스 · CHECK 제약을 관리하지 않으므로 이후 마이그레이션에서도 지워지지 않는다.
--       일반 인덱스는 schema.prisma 에 선언해야 한다 — 선언하지 않으면 다음 migrate 에서 DROP 된다.)
--
-- 적용 방법
--   첫 마이그레이션을 `prisma migrate dev --create-only` 로 만든 뒤 migration.sql 끝에
--   이 파일 내용을 붙여 넣는다. 재실행해도 안전하도록 작성했다(idempotent).
--
-- 테넌트 컨텍스트
--   애플리케이션은 트랜잭션마다 아래를 먼저 실행한다 (docs/data-model.md §3).
--     SELECT set_config('app.tenant_id', '<tenant uuid>', true);
--   값이 없으면 app_current_tenant() 가 NULL 이 되어 어떤 행도 보이지 않는다 (fail-closed).
-- =============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- 1) 역할
--   app_rw          API 서버 · agent.worker 가 사용하는 역할. RLS 적용 대상.
--   app_maintenance recovery · metrics-rollup · 보존 정리 잡 전용. 테넌트 횡단이 필요해 BYPASSRLS.
--                   아래 SECURITY DEFINER 함수의 소유자이기도 하다.
--   실제 접속 계정은 운영 환경에서 만들고 이 역할을 부여한다:
--     CREATE ROLE theoneai_api LOGIN PASSWORD '...' IN ROLE app_rw;
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_rw') THEN
    CREATE ROLE app_rw NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_maintenance') THEN
    CREATE ROLE app_maintenance NOLOGIN BYPASSRLS;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO app_rw, app_maintenance;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_rw, app_maintenance;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_rw, app_maintenance;
-- 마이그레이션 이력 테이블은 애플리케이션이 볼 필요가 없다 (shadow DB 에는 없으므로 존재할 때만).
DO $$
BEGIN
  IF to_regclass('public._prisma_migrations') IS NOT NULL THEN
    REVOKE ALL ON TABLE "_prisma_migrations" FROM app_rw, app_maintenance;
  END IF;
END $$;

-- 감사 로그는 append-only. 보존 기간 정리는 app_maintenance 만 한다.
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE audit_logs FROM app_rw;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2) RLS
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION app_current_tenant() RETURNS uuid
  LANGUAGE sql STABLE
AS $$ SELECT nullif(current_setting('app.tenant_id', true), '')::uuid $$;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'users', 'end_users',
    'agents', 'agent_versions', 'providers', 'model_configs',
    'agent_version_mcp_servers', 'agent_version_skills',
    'conversations', 'messages',
    'tasks', 'task_steps', 'task_events',
    'tool_registry_versions', 'mcp_servers', 'mcp_tools', 'tool_executions',
    'tool_policies', 'tool_policy_rules', 'approvals',
    'skills', 'skill_versions',
    'memories', 'artifacts', 'feedbacks',
    'widget_configs', 'audit_logs', 'metrics_daily',
    'eval_cases', 'eval_runs'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    -- 테이블 소유자에게도 RLS 를 적용한다 (소유자 계정으로 앱을 띄우는 실수 방지).
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I
         USING (tenant_id = app_current_tenant())
         WITH CHECK (tenant_id = app_current_tenant())', t);
  END LOOP;
END $$;

ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_self ON tenants;
CREATE POLICY tenant_self ON tenants
  USING (id = app_current_tenant())
  WITH CHECK (id = app_current_tenant());

-- ─────────────────────────────────────────────────────────────────────────────
-- 3) 테넌트가 정해지기 전에 필요한 조회 (SECURITY DEFINER, 최소 컬럼만 반환)
--    소유자는 BYPASSRLS 역할인 app_maintenance. app_rw 에는 EXECUTE 만 허용한다.
-- ─────────────────────────────────────────────────────────────────────────────

-- 위젯 bootstrap: 공개 키 → 테넌트 · 위젯 설정 (POST /v1/widget/bootstrap)
CREATE OR REPLACE FUNCTION app_resolve_widget(p_public_key text)
  RETURNS TABLE (widget_id uuid, tenant_id uuid, agent_id uuid, allowed_origins text[], identity_mode identity_mode)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
  SELECT w.id, w.tenant_id, w.agent_id, w.allowed_origins, w.identity_mode
  FROM widget_configs w
  WHERE w.public_key = p_public_key AND w.enabled
$$;

-- 콘솔 로그인: 테넌트 slug → tenant id (POST /v1/admin/auth/login)
CREATE OR REPLACE FUNCTION app_resolve_tenant(p_slug text)
  RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$ SELECT t.id FROM tenants t WHERE t.slug = p_slug $$;

-- recovery.worker: heartbeat 가 끊긴 작업 찾기 (id 와 tenant 만 반환)
CREATE OR REPLACE FUNCTION app_find_stalled_tasks(p_stale_after interval, p_limit int DEFAULT 100)
  RETURNS TABLE (task_id uuid, tenant_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
  SELECT t.id, t.tenant_id
  FROM tasks t
  WHERE t.status IN ('running', 'recovering')
    AND t.last_heartbeat_at < now() - p_stale_after
  ORDER BY t.last_heartbeat_at
  LIMIT p_limit
$$;

ALTER FUNCTION app_resolve_widget(text) OWNER TO app_maintenance;
ALTER FUNCTION app_resolve_tenant(text) OWNER TO app_maintenance;
ALTER FUNCTION app_find_stalled_tasks(interval, int) OWNER TO app_maintenance;
REVOKE ALL ON FUNCTION app_resolve_widget(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_resolve_tenant(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_find_stalled_tasks(interval, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_resolve_widget(text) TO app_rw;
GRANT EXECUTE ON FUNCTION app_resolve_tenant(text) TO app_rw;
GRANT EXECUTE ON FUNCTION app_find_stalled_tasks(interval, int) TO app_rw;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4) 인덱스 · 제약
-- ─────────────────────────────────────────────────────────────────────────────

-- Agent 당 초안(draft)은 하나
CREATE UNIQUE INDEX IF NOT EXISTS agent_versions_one_draft
  ON agent_versions (agent_id) WHERE status = 'draft';

-- Memory 의미 검색 (코사인 거리). 활성 항목만 색인.
CREATE INDEX IF NOT EXISTS memories_embedding_hnsw
  ON memories USING hnsw (embedding vector_cosine_ops) WHERE status = 'active';

-- 만료 처리 잡이 훑는 대기 중 승인
CREATE INDEX IF NOT EXISTS approvals_pending_expiry
  ON approvals (expires_at) WHERE status = 'pending';

-- scope = user 이면 end_user_id 필수, scope = agent 이면 사용자 정보 없음
ALTER TABLE memories DROP CONSTRAINT IF EXISTS memories_scope_end_user_chk;
ALTER TABLE memories ADD CONSTRAINT memories_scope_end_user_chk
  CHECK ((scope = 'user') = (end_user_id IS NOT NULL));

-- 전송 방식별 필수 값
ALTER TABLE mcp_servers DROP CONSTRAINT IF EXISTS mcp_servers_transport_chk;
ALTER TABLE mcp_servers ADD CONSTRAINT mcp_servers_transport_chk
  CHECK (
    (transport = 'streamable_http' AND endpoint_url IS NOT NULL)
    OR (transport = 'stdio_sandbox' AND image IS NOT NULL)
  );

-- 이중 승인 · 사용자 승인 주체 정합성
ALTER TABLE approvals DROP CONSTRAINT IF EXISTS approvals_operator_fields_chk;
ALTER TABLE approvals ADD CONSTRAINT approvals_operator_fields_chk
  CHECK ((operator_decision IS NULL) = (operator_id IS NULL));

-- 승인 만료 시간 범위 (1분 ~ 24시간)
ALTER TABLE tool_policies DROP CONSTRAINT IF EXISTS tool_policies_ttl_chk;
ALTER TABLE tool_policies ADD CONSTRAINT tool_policies_ttl_chk
  CHECK (ttl_seconds BETWEEN 60 AND 86400);
