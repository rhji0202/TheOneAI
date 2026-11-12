import type { Request } from 'express';
import type { MemberRole } from '../../generated/prisma/client.js';

/** 콘솔 멤버 세션 (access token 에서 꺼내고 DB 로 다시 확인한 값) */
export interface AdminSession {
  tenantId: string;
  userId: string;
  email: string;
  name: string;
  role: MemberRole;
}

export type AdminRequest = Request & { adminSession?: AdminSession; traceId?: string };

const RANK: Record<MemberRole, number> = { viewer: 0, operator: 1, admin: 2, owner: 3 };

/** role 이 required 이상인가 (Owner > Admin > Operator > Viewer) */
export function hasRole(role: MemberRole, required: MemberRole): boolean {
  return RANK[role] >= RANK[required];
}
