import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { APPROVAL_EXPIRY_QUEUE } from '../infrastructure/queue/queues.js';
import { ApprovalExpiryService } from './approval-expiry.service.js';

const SCHEDULER_ID = 'approval-expiry-tick';

/** approval-expiry 큐 — APPROVAL_EXPIRY_TICK_SEC 마다 만료된 승인을 처리한다 (스케줄러는 Redis 에 하나) */
@Processor(APPROVAL_EXPIRY_QUEUE, { concurrency: 1 })
export class ApprovalExpiryProcessor extends WorkerHost implements OnApplicationBootstrap {
  private readonly logger = new Logger(ApprovalExpiryProcessor.name);

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @InjectQueue(APPROVAL_EXPIRY_QUEUE) private readonly queue: Queue,
    private readonly expiry: ApprovalExpiryService,
  ) {
    super();
  }

  async onApplicationBootstrap(): Promise<void> {
    const { expiryTickSec } = this.config.approvals;
    if (expiryTickSec === 0) {
      await this.queue.removeJobScheduler(SCHEDULER_ID);
      return;
    }
    await this.queue.upsertJobScheduler(
      SCHEDULER_ID,
      { every: expiryTickSec * 1_000 },
      { name: 'tick', opts: { removeOnComplete: { count: 100 }, removeOnFail: { count: 100 } } },
    );
    this.logger.log(`승인 만료 주기 잡 등록 (확인 ${expiryTickSec}s)`);
  }

  async process(): Promise<{ expired: number }> {
    return { expired: await this.expiry.tick() };
  }
}
