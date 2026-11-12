import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { METRICS_ROLLUP_QUEUE } from '../infrastructure/queue/queues.js';
import { MetricsRollupService } from './metrics-rollup.service.js';

const SCHEDULER_ID = 'metrics-rollup-tick';

/** metrics-rollup 큐 — METRICS_ROLLUP_TICK_SEC 마다 metrics_daily 갱신 (스케줄러는 Redis 에 하나) */
@Processor(METRICS_ROLLUP_QUEUE, { concurrency: 1 })
export class MetricsRollupProcessor extends WorkerHost implements OnApplicationBootstrap {
  private readonly logger = new Logger(MetricsRollupProcessor.name);

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @InjectQueue(METRICS_ROLLUP_QUEUE) private readonly queue: Queue,
    private readonly rollup: MetricsRollupService,
  ) {
    super();
  }

  async onApplicationBootstrap(): Promise<void> {
    const tickSec = this.config.metrics.rollupTickSec;
    if (tickSec === 0) {
      await this.queue.removeJobScheduler(SCHEDULER_ID);
      return;
    }
    await this.queue.upsertJobScheduler(
      SCHEDULER_ID,
      { every: tickSec * 1_000 },
      { name: 'tick', opts: { removeOnComplete: { count: 100 }, removeOnFail: { count: 100 } } },
    );
    this.logger.log(`지표 집계 주기 잡 등록 (${tickSec}s)`);
  }

  async process(): Promise<{ rows: number }> {
    return { rows: await this.rollup.tick() };
  }
}
