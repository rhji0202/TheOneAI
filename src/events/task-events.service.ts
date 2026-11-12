import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService, type TenantTx } from '../infrastructure/database/prisma.service.js';
import { RedisService } from '../infrastructure/redis/redis.service.js';

/** SSE 로 나가는 이벤트. id 가 null 이면 저장하지 않는 일시 이벤트(message.delta 등). */
export interface TaskEventEnvelope {
  id: string | null;
  type: string;
  data: unknown;
}

export const taskChannel = (taskId: string): string => `task:${taskId}`;
const streamCurrentKey = (taskId: string): string => `task:${taskId}:stream:current`;
const streamTextKey = (taskId: string, messageId: string): string =>
  `task:${taskId}:stream:${messageId}`;
const STREAM_TTL_SEC = 3_600;
const REPLAY_PAGE = 500;

/**
 * 작업 이벤트 아웃박스 (docs/api-spec.md §3).
 *  1) task_events 에 저장 (트랜잭션 안에서 상태 변경과 함께) → 2) 커밋 후 Redis 로 발행
 * 발행이 실패해도 이벤트는 DB 에 남아 있어 SSE 재연결(Last-Event-ID) 때 전달된다.
 */
@Injectable()
export class TaskEventsService {
  private readonly logger = new Logger(TaskEventsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  async append(
    tx: TenantTx,
    tenantId: string,
    taskId: string,
    type: string,
    data: unknown,
  ): Promise<TaskEventEnvelope> {
    const row = await tx.taskEvent.create({
      data: { tenantId, taskId, type, payload: data as Prisma.InputJsonValue },
      select: { id: true },
    });
    return { id: row.id.toString(), type, data };
  }

  async publish(taskId: string, ...envelopes: TaskEventEnvelope[]): Promise<void> {
    for (const envelope of envelopes) {
      try {
        await this.redis.publish(taskChannel(taskId), JSON.stringify(envelope));
      } catch (err) {
        this.logger.warn(`이벤트 발행 실패 (${taskId} ${envelope.type}): ${String(err)}`);
      }
    }
  }

  /** 저장 + 발행 (상태 변경 없이 이벤트만 남길 때) */
  async emit(
    tenantId: string,
    taskId: string,
    type: string,
    data: unknown,
  ): Promise<TaskEventEnvelope> {
    const envelope = await this.prisma.withTenant(tenantId, (tx) =>
      this.append(tx, tenantId, taskId, type, data),
    );
    await this.publish(taskId, envelope);
    return envelope;
  }

  /** 토큰 스트림: 저장하지 않고 발행만 한다. 재연결용 누적 본문은 Redis 에 1시간 보관. */
  async streamDelta(taskId: string, messageId: string, text: string): Promise<void> {
    await this.redis.client
      .multi()
      .set(streamCurrentKey(taskId), messageId, 'EX', STREAM_TTL_SEC)
      .append(streamTextKey(taskId, messageId), text)
      .expire(streamTextKey(taskId, messageId), STREAM_TTL_SEC)
      .exec();
    await this.publish(taskId, { id: null, type: 'message.delta', data: { messageId, text } });
  }

  async clearStream(taskId: string, messageId: string): Promise<void> {
    await this.redis.client.del(streamCurrentKey(taskId), streamTextKey(taskId, messageId));
  }

  /** 생성 중인 응답의 누적 본문 (재연결 직후 message.snapshot) */
  async snapshot(taskId: string): Promise<{ messageId: string; text: string } | null> {
    const messageId = await this.redis.client.get(streamCurrentKey(taskId));
    if (!messageId) return null;
    const text = await this.redis.client.get(streamTextKey(taskId, messageId));
    return text ? { messageId, text } : null;
  }

  async replay(tenantId: string, taskId: string, afterId: bigint): Promise<TaskEventEnvelope[]> {
    const out: TaskEventEnvelope[] = [];
    let cursor = afterId;
    for (;;) {
      const rows = await this.prisma.withTenant(tenantId, (tx) =>
        tx.taskEvent.findMany({
          where: { taskId, id: { gt: cursor } },
          orderBy: { id: 'asc' },
          take: REPLAY_PAGE,
          select: { id: true, type: true, payload: true },
        }),
      );
      for (const row of rows)
        out.push({ id: row.id.toString(), type: row.type, data: row.payload });
      if (rows.length < REPLAY_PAGE) return out;
      cursor = rows[rows.length - 1]!.id;
    }
  }
}
