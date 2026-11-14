import type { Request } from 'express';
import type { MemberRole } from '../../generated/prisma/client.js';
import type { VerifiedMembership } from './admin-token.service.js';

/** 콘솔 멤버 세션 (access token 에서 꺼내고 DB 로 다시 확인한 값) */
export interface AdminSession {
  tenantId: string;
  userId: string;
  email: string;
  name: string;
  role: MemberRole;
  /** 이 로그인에서 비밀번호를 확인한 워크스페이스 멤버십 (현재 워크스페이스 포함) */
  verified: VerifiedMembership[];
  /** 로그인이 끝나는 시각 — 전환 · 새 워크스페이스 토큰도 이 시각을 넘지 않는다 */
  expiresAt: Date;
}

export type AdminRequest = Request & { adminSession?: AdminSession; traceId?: string };

const RANK: Record<MemberRole, number> = { viewer: 0, operator: 1, admin: 2, owner: 3 };

/** role 이 required 이상인가 (Owner > Admin > Operator > Viewer) */
export function hasRole(role: MemberRole, required: MemberRole): boolean {
  return RANK[role] >= RANK[required];
}
