import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { AGENT_RECOVERY_QUEUE } from '../infrastructure/queue/queues.js';
import { TaskRecoveryService } from './task-recovery.service.js';

const SCHEDULER_ID = 'agent-recovery-tick';

/** agent-recovery 큐 — RECOVERY_TICK_SEC 마다 heartbeat 가 끊긴 작업을 찾는다 (스케줄러는 Redis 에 하나) */
@Processor(AGENT_RECOVERY_QUEUE, { concurrency: 1 })
export class TaskRecoveryProcessor extends WorkerHost implements OnApplicationBootstrap {
  private readonly logger = new Logger(TaskRecoveryProcessor.name);

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @InjectQueue(AGENT_RECOVERY_QUEUE) private readonly queue: Queue,
    private readonly recovery: TaskRecoveryService,
  ) {
    super();
  }

  async onApplicationBootstrap(): Promise<void> {
    const { tickSec, staleSec } = this.config.recovery;
    if (tickSec === 0) {
      await this.queue.removeJobScheduler(SCHEDULER_ID);
      return;
    }
    await this.queue.upsertJobScheduler(
      SCHEDULER_ID,
      { every: tickSec * 1_000 },
      { name: 'tick', opts: { removeOnComplete: { count: 100 }, removeOnFail: { count: 100 } } },
    );
    this.logger.log(
      `작업 복구 주기 잡 등록 (확인 ${tickSec}s, heartbeat ${staleSec}s 끊기면 복구)`,
    );
  }

  async process(): Promise<{ recovered: number }> {
    return { recovered: await this.recovery.tick() };
  }
}
