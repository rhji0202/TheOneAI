import { Inject, Injectable, Logger } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { type TaskEventEnvelope, TaskEventsService } from '../events/task-events.service.js';
import { PrismaService } from '../infrastructure/database/prisma.service.js';
import { resumeJobId } from '../infrastructure/queue/queues.js';
import { TaskQueueService } from '../infrastructure/queue/task-queue.service.js';

export type RecoveryOutcome = 'recovered' | 'failed' | 'skipped';

/**
 * agent-recovery — heartbeat 가 끊긴(Worker 가 죽은) 작업을 마지막 checkpoint 부터 다시 실행한다 (docs/api-spec.md §6).
 *  - running · recovering 이고 heartbeat 가 RECOVERY_STALE_SEC 넘게 끊긴 작업
 *  - 실행 중이던 단계는 failed(worker_lost)로 닫고, recovering 으로 바꾼 뒤 재개 Job 을 넣는다
 *  - 복구 한도(RECOVERY_MAX_ATTEMPTS)를 넘으면 failed — 사용자가 재개할 수 있다
 * 테넌트 횡단 조회는 SECURITY DEFINER 함수(app_find_stalled_tasks)로만 한다.
 */
@Injectable()
export class TaskRecoveryService {
  private readonly logger = new Logger(TaskRecoveryService.name);

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly prisma: PrismaService,
    private readonly events: TaskEventsService,
    private readonly queue: TaskQueueService,
  ) {}

  async tick(): Promise<number> {
    const rows = await this.prisma.$queryRaw<Array<{ task_id: string; tenant_id: string }>>`
      SELECT task_id, tenant_id
      FROM app_find_stalled_tasks(make_interval(secs => ${this.config.recovery.staleSec}), 100)`;
    let recovered = 0;
    for (const row of rows) {
      const outcome = await this.recover(row.tenant_id, row.task_id).catch((err: unknown) => {
        this.logger.error(`작업 복구 실패 (${row.task_id}): ${String(err)}`);
        return 'skipped' as const;
      });
      if (outcome === 'recovered') recovered++;
    }
    return recovered;
  }

  /** @param force heartbeat 가 아직 살아 있어도 복구 (운영 도구 · 테스트) */
  async recover(tenantId: string, taskId: string, force = false): Promise<RecoveryOutcome> {
    const staleBefore = new Date(Date.now() - this.config.recovery.staleSec * 1_000);
    const result = await this.prisma.withTenant(tenantId, async (tx) => {
      const [task] = await tx.$queryRaw<
        Array<{
          status: string;
          last_heartbeat_at: Date | null;
          recovery_count: number;
          last_checkpoint_step_id: string | null;
        }>
      >`
        SELECT status, last_heartbeat_at, recovery_count, last_checkpoint_step_id
        FROM tasks WHERE id = ${taskId}::uuid FOR UPDATE`;
      if (!task || (task.status !== 'running' && task.status !== 'recovering'))
        return { kind: 'skipped' as const, events: [] as TaskEventEnvelope[] };
      if (!force && task.last_heartbeat_at && task.last_heartbeat_at > staleBefore)
        return { kind: 'skipped' as const, events: [] as TaskEventEnvelope[] };
      // 이미 넣은 재개 Job 이 대기 중이면 (큐가 밀려 있는 경우) 다시 넣지 않는다
      if (
        task.status === 'recovering' &&
        (await this.queue.isPending(resumeJobId(taskId, 'recover', task.recovery_count)))
      ) {
        await tx.task.update({ where: { id: taskId }, data: { lastHeartbeatAt: new Date() } });
        return { kind: 'skipped' as const, events: [] as TaskEventEnvelope[] };
      }

      const checkpoint = task.last_checkpoint_step_id
        ? await tx.taskStep.findUnique({
            where: { id: task.last_checkpoint_step_id },
            select: { seq: true, planIndex: true },
          })
        : null;
      const events: TaskEventEnvelope[] = [];
      await tx.taskStep.updateMany({
        where: { taskId, status: 'running' },
        data: { status: 'failed', finishedAt: new Date(), output: { error: 'worker_lost' } },
      });

      if (task.recovery_count >= this.config.recovery.maxAttempts) {
        const message = `Worker 장애로 ${task.recovery_count}번 복구했지만 끝내지 못했습니다`;
        await tx.task.update({
          where: { id: taskId },
          data: {
            status: 'failed',
            failureCode: 'RECOVERY_LIMIT_EXCEEDED',
            failureMessage: message,
            finishedAt: new Date(),
            workerId: null,
          },
        });
        events.push(
          await this.events.append(tx, tenantId, taskId, 'task.failed', {
            code: 'RECOVERY_LIMIT_EXCEEDED',
            message,
            resumable: checkpoint !== null,
            lastCheckpoint: checkpoint,
          }),
        );
        return { kind: 'failed' as const, events };
      }

      const updated = await tx.task.update({
        where: { id: taskId },
        data: {
          status: 'recovering',
          workerId: null,
          lastHeartbeatAt: new Date(),
          recoveryCount: { increment: 1 },
        },
        select: { recoveryCount: true },
      });
      events.push(
        await this.events.append(tx, tenantId, taskId, 'task.recovering', {
          reason: 'worker_lost',
          fromPlanIndex: checkpoint?.planIndex != null ? checkpoint.planIndex + 1 : null,
        }),
      );
      return { kind: 'recovered' as const, events, n: updated.recoveryCount };
    });

    if (result.events.length) await this.events.publish(taskId, ...result.events);
    if (result.kind === 'recovered') {
      await this.queue.enqueueResume({ tenantId, taskId }, { kind: 'recover', n: result.n });
      this.logger.warn(`작업 ${taskId}: Worker 응답 없음 → 복구 ${result.n}회째`);
    }
    return result.kind;
  }
}
