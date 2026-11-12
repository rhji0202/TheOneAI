import { Injectable } from '@nestjs/common';
import type { Request, Response } from 'express';
import { PrismaService } from '../infrastructure/database/prisma.service.js';
import { RedisService } from '../infrastructure/redis/redis.service.js';
import { TERMINAL_STATUSES } from '../tasks/task-views.js';
import { taskChannel, type TaskEventEnvelope, TaskEventsService } from './task-events.service.js';

const PING_MS = 15_000;
const HEARTBEAT_MS = 30_000;

export function isTerminalEvent(envelope: TaskEventEnvelope): boolean {
  if (envelope.type === 'task.completed' || envelope.type === 'task.failed') return true;
  if (envelope.type === 'task.status') {
    const status = (envelope.data as { status?: string } | null)?.status;
    return status === 'cancelled';
  }
  return false;
}

/** "123" → 123n, 그 외 → undefined */
export function parseLastEventId(value: string | undefined): bigint | undefined {
  return value && /^\d{1,19}$/.test(value) ? BigInt(value) : undefined;
}

/**
 * 작업 이벤트 SSE 스트림 (docs/api-spec.md §3.1)
 *  1. Redis 채널을 먼저 구독하고 들어오는 이벤트는 잠시 버퍼에 담는다.
 *  2. task_events 에서 Last-Event-ID 이후 이벤트를 재전송한다.
 *  3. 재연결이면 생성 중인 응답 본문을 message.snapshot 으로 한 번 보낸다.
 *  4. 버퍼를 비우고 실시간 전달로 넘어간다. id 가 이미 보낸 것 이하이면 건너뛴다(중복 방지).
 *  5. 종료 이벤트(task.completed · task.failed · cancelled)를 보내면 스트림을 닫는다.
 */
@Injectable()
export class SseStreamService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly events: TaskEventsService,
  ) {}

  async stream(
    _req: Request,
    res: Response,
    options: { tenantId: string; taskId: string; lastEventId: bigint | undefined },
  ): Promise<void> {
    const { tenantId, taskId } = options;
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    let lastSent = options.lastEventId ?? 0n;
    let live = false;
    let ended = false;
    const pending: TaskEventEnvelope[] = [];
    const timers: NodeJS.Timeout[] = [];
    let unsubscribe: (() => Promise<void>) | null = null;

    const finish = (): void => {
      if (ended) return;
      ended = true;
      timers.forEach(clearInterval);
      void unsubscribe?.();
      res.end();
    };

    const send = (envelope: TaskEventEnvelope): void => {
      if (ended) return;
      if (envelope.id !== null) {
        const id = BigInt(envelope.id);
        if (id <= lastSent) return;
        lastSent = id;
        res.write(`id: ${envelope.id}\n`);
      }
      res.write(`event: ${envelope.type}\ndata: ${JSON.stringify(envelope.data)}\n\n`);
      if (isTerminalEvent(envelope)) finish();
    };

    // 클라이언트 연결 종료 감지는 응답 소켓 기준 (요청 스트림의 close 는 본문을 다 읽으면 바로 발생할 수 있다)
    res.on('close', finish);

    unsubscribe = await this.redis.subscribe(taskChannel(taskId), (raw) => {
      const envelope = safeParse(raw);
      if (!envelope) return;
      if (live) send(envelope);
      else pending.push(envelope);
    });
    if (ended) {
      await unsubscribe();
      return;
    }

    for (const envelope of await this.events.replay(tenantId, taskId, lastSent)) send(envelope);

    if (!ended && options.lastEventId !== undefined) {
      const snapshot = await this.events.snapshot(taskId);
      if (snapshot) send({ id: null, type: 'message.snapshot', data: snapshot });
    }

    live = true;
    for (const envelope of pending.splice(0)) send(envelope);
    if (ended) return;

    // 종료 이벤트가 이미 Last-Event-ID 이전에 지나갔다면 보낼 것이 없으므로 닫는다.
    const task = await this.prisma.withTenant(tenantId, (tx) =>
      tx.task.findUnique({ where: { id: taskId }, select: { status: true } }),
    );
    if (!task || TERMINAL_STATUSES.includes(task.status)) {
      finish();
      return;
    }

    timers.push(
      setInterval(() => {
        if (!ended) res.write(': ping\n\n');
      }, PING_MS),
      setInterval(
        () => send({ id: null, type: 'heartbeat', data: { serverTime: new Date().toISOString() } }),
        HEARTBEAT_MS,
      ),
    );
  }
}

function safeParse(raw: string): TaskEventEnvelope | null {
  try {
    const value = JSON.parse(raw) as TaskEventEnvelope;
    return typeof value?.type === 'string' ? value : null;
  } catch {
    return null;
  }
}
