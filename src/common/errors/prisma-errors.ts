import { Prisma } from '../../generated/prisma/client.js';

/** 유니크 제약 위반(P2002). constraint 를 주면 해당 인덱스 · 필드 이름이 포함된 경우만 true. */
export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') return false;
  if (!constraint) return true;
  return JSON.stringify(err.meta ?? {}).includes(constraint) || err.message.includes(constraint);
}
