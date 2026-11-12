/**
 * API 오류. ProblemDetailsFilter 가 RFC 9457 problem+json 으로 변환한다.
 * 코드 목록: docs/api-spec.md §5
 */
export type ErrorCode =
  | 'VALIDATION_FAILED'
  | 'UNAUTHENTICATED'
  | 'IDENTITY_TOKEN_INVALID'
  | 'IDENTITY_TOKEN_REQUIRED'
  | 'FORBIDDEN'
  | 'ORIGIN_NOT_ALLOWED'
  | 'WIDGET_DISABLED'
  | 'NOT_FOUND'
  | 'TASK_ALREADY_ACTIVE'
  | 'TASK_NOT_ACTIVE'
  | 'TASK_NOT_RESUMABLE'
  | 'CHECKPOINT_NOT_FOUND'
  | 'BUDGET_EXCEEDED'
  | 'APPROVAL_EXPIRED'
  | 'APPROVAL_ALREADY_RESOLVED'
  | 'APPROVAL_SCOPE_NOT_ALLOWED'
  | 'FORBIDDEN_APPROVER'
  | 'IDEMPOTENCY_KEY_REUSED'
  | 'ATTACHMENT_NOT_ALLOWED'
  | 'AGENT_NOT_PUBLISHED'
  | 'AGENT_DRAFT_INVALID'
  | 'NAME_TAKEN'
  | 'REGISTRY_CHANGED'
  | 'MCP_SSRF_BLOCKED'
  | 'MCP_HANDSHAKE_FAILED'
  | 'MCP_TRANSPORT_UNSUPPORTED'
  | 'MCP_AUTH_UNSUPPORTED'
  | 'MCP_TOOL_INVALID'
  | 'MCP_SERVER_STATE'
  | 'SKILL_PARSE_FAILED'
  | 'SKILL_VERIFICATION_FAILED'
  | 'SKILL_VERSION_EXISTS'
  | 'MARKETPLACE_SIGNATURE_INVALID'
  | 'PAYLOAD_TOO_LARGE'
  | 'RATE_LIMITED'
  | 'SERVICE_UNAVAILABLE'
  | 'INTERNAL_ERROR';

export interface FieldIssue {
  path: string;
  message: string;
  /** 파일 안 위치 (SKILL.md 파싱 오류) */
  line?: number;
}

const TITLES: Record<ErrorCode, string> = {
  VALIDATION_FAILED: '요청 값이 올바르지 않습니다',
  UNAUTHENTICATED: '인증이 필요합니다',
  IDENTITY_TOKEN_INVALID: '사용자 인증 토큰이 올바르지 않습니다',
  IDENTITY_TOKEN_REQUIRED: '사용자 인증 토큰이 필요합니다',
  FORBIDDEN: '권한이 없습니다',
  ORIGIN_NOT_ALLOWED: '허용되지 않은 도메인입니다',
  WIDGET_DISABLED: '사용할 수 없는 위젯입니다',
  NOT_FOUND: '찾을 수 없습니다',
  TASK_ALREADY_ACTIVE: '이 대화에서 진행 중인 작업이 있습니다',
  TASK_NOT_ACTIVE: '진행 중인 작업이 아닙니다',
  TASK_NOT_RESUMABLE: '실패했거나 일시정지된 작업만 재개할 수 있습니다',
  CHECKPOINT_NOT_FOUND: '재개할 checkpoint 가 없습니다',
  BUDGET_EXCEEDED: '이번 달 사용 한도에 도달했습니다',
  APPROVAL_EXPIRED: '승인 요청이 만료되었습니다',
  APPROVAL_ALREADY_RESOLVED: '이미 처리된 승인 요청입니다',
  APPROVAL_SCOPE_NOT_ALLOWED: '이 작업 동안 승인할 수 없는 권한 등급입니다',
  FORBIDDEN_APPROVER: '이 승인 요청을 처리할 권한이 없습니다',
  IDEMPOTENCY_KEY_REUSED: '같은 Idempotency-Key 로 다른 요청을 보냈습니다',
  ATTACHMENT_NOT_ALLOWED: '첨부할 수 없는 파일입니다',
  AGENT_NOT_PUBLISHED: '배포된 Agent 가 없습니다',
  AGENT_DRAFT_INVALID: 'Agent 초안을 배포할 수 없습니다',
  NAME_TAKEN: '이미 사용 중인 이름입니다',
  REGISTRY_CHANGED: '검토하는 동안 Tool 구성이 바뀌었습니다',
  MCP_SSRF_BLOCKED: '허용되지 않은 네트워크 대상입니다',
  MCP_HANDSHAKE_FAILED: 'MCP 서버와 연결하지 못했습니다',
  MCP_TRANSPORT_UNSUPPORTED: '아직 지원하지 않는 연결 방식입니다',
  MCP_AUTH_UNSUPPORTED: '아직 지원하지 않는 인증 방식입니다',
  MCP_TOOL_INVALID: '등록할 수 없는 Tool 입니다',
  MCP_SERVER_STATE: '지금 상태에서는 할 수 없는 작업입니다',
  SKILL_PARSE_FAILED: 'Skill 번들 · SKILL.md 를 읽을 수 없습니다',
  SKILL_VERIFICATION_FAILED: '신뢰 검증을 통과하지 못한 Skill 버전입니다',
  SKILL_VERSION_EXISTS: '같은 버전이 이미 다른 내용으로 등록되어 있습니다',
  MARKETPLACE_SIGNATURE_INVALID: '마켓플레이스 서명 · 파일 해시를 확인하지 못했습니다',
  PAYLOAD_TOO_LARGE: '요청이 너무 큽니다',
  RATE_LIMITED: '요청이 너무 많습니다',
  SERVICE_UNAVAILABLE: '일시적으로 처리할 수 없습니다',
  INTERNAL_ERROR: '서버 오류가 발생했습니다',
};

export class AppError extends Error {
  readonly title: string;

  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    readonly detail?: string,
    readonly errors?: FieldIssue[],
  ) {
    super(detail ?? TITLES[code]);
    this.name = 'AppError';
    this.title = TITLES[code];
  }

  static notFound(detail?: string): AppError {
    return new AppError(404, 'NOT_FOUND', detail);
  }

  static unauthenticated(detail?: string): AppError {
    return new AppError(401, 'UNAUTHENTICATED', detail);
  }
}
