import type { z } from 'zod';
import type { ApprovalMode, PermissionLevel } from '../generated/prisma/client.js';

/** Tool 실행 시점의 호출자 정보 (Tool 구현이 테넌트 · 사용자 범위를 벗어나지 않도록) */
export interface ToolContext {
  tenantId: string;
  taskId: string;
  endUserId: string;
  conversationId: string;
  /** 작업이 고정한 Registry 버전 · Agent 버전 (Skill 파일 읽기 등) */
  registryVersionId: string;
  agentVersionId: string;
  signal: AbortSignal;
}

/** 코드로 제공하는 Tool. 외부 Tool 은 MCP(개발 순서 5단계)로 붙는다. */
export interface BuiltinTool<A = unknown> {
  /** 레지스트리 이름 (예: builtin.calculate). 소문자 · 숫자 · _ · . · - */
  name: string;
  description: string;
  level: PermissionLevel;
  /** 같은 인자로 다시 실행해도 결과가 같은가 (자동 재시도 · 재개 판단) */
  idempotent: boolean;
  timeoutMs?: number;
  input: z.ZodType<A>;
  execute(args: A, ctx: ToolContext): Promise<unknown>;
}

/** tool_registry_versions.snapshot 의 Tool 한 줄 */
export interface SnapshotTool {
  name: string;
  source: 'builtin' | 'mcp';
  description: string;
  /** LLM 에 보여 줄 JSON Schema */
  inputSchema: Record<string, unknown>;
  schemaHash: string;
  level: PermissionLevel;
  /** Tool 단위 승인 정책 재정의 (없으면 등급 기본 정책) */
  modeOverride: ApprovalMode | null;
  /** 같은 인자로 다시 실행해도 안전한가 (자동 재시도). 없으면 내장 Tool 정의 · 등급(read)으로 판단 */
  idempotent?: boolean;
  /** source = mcp 일 때: 호출할 서버 · 서버 쪽 원래 Tool 이름 */
  mcpToolId?: string;
  mcpServerId?: string;
  mcpToolName?: string;
}

/** tool_registry_versions.snapshot 의 Skill 한 줄 — 작업은 이 버전(내용 해시)으로 고정된다 */
export interface SnapshotSkill {
  name: string;
  skillId: string;
  versionId: string;
  version: string;
  description: string;
  allowedTools: string[];
  contentHash: string;
}

/** tool_registry_versions.snapshot */
export interface RegistrySnapshot {
  /** 이 버전을 만들 때의 내장 Tool 구성 해시. 배포로 내장 Tool 이 바뀌면 새 버전을 만든다. */
  builtinsHash: string;
  tools: SnapshotTool[];
  skills: SnapshotSkill[];
}

/** 권한 판단 결과 */
export type PermissionDecision =
  | { decision: 'allow'; mode: ApprovalMode; matchedRuleIds: string[] }
  | {
      decision: 'require_approval';
      mode: ApprovalMode;
      approver: 'user' | 'operator' | 'user_and_operator';
      matchedRuleIds: string[];
      reason: string;
    }
  | {
      decision: 'deny';
      mode: ApprovalMode;
      matchedRuleIds: string[];
      reason: string;
      deniedReason: DeniedReason;
    };

/**
 * tool_executions.denied_reason
 *  - unknown_tool · not_allowed · blocked_by_policy · blocked_by_rule : “무단 Tool 호출” 지표에 포함
 *    (not_allowed = 이 Agent 의 허용 목록에 없는 MCP 서버의 Tool)
 *  - approval_required : 승인이 필요해 실행하지 않음 (지표 제외, 승인 흐름은 개발 순서 10단계)
 *  - tool_unavailable : 작업 중에 서버가 오류 · 비활성 상태가 되었거나 운영자가 Tool 을 껐음 (지표 제외)
 */
export type DeniedReason =
  | 'unknown_tool'
  | 'not_allowed'
  | 'blocked_by_policy'
  | 'blocked_by_rule'
  | 'approval_required'
  | 'tool_unavailable';

export const UNAUTHORIZED_REASONS: DeniedReason[] = [
  'unknown_tool',
  'not_allowed',
  'blocked_by_policy',
  'blocked_by_rule',
];
