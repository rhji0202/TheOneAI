import { hostname } from 'node:os';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, type OnApplicationBootstrap } from '@nestjs/common';
import type { Job } from 'bullmq';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { AGENT_TASKS_QUEUE, type AgentTaskJobData } from '../infrastructure/queue/queues.js';
import { type ExecutionOutcome, TaskExecutionService } from './task-execution.service.js';

/** agent-tasks 큐 소비자. 작업 1건 = Job 1건. 승인 대기 · 일시정지 중에는 Worker 를 점유하지 않는다. */
@Processor(AGENT_TASKS_QUEUE)
export class AgentTaskProcessor extends WorkerHost implements OnApplicationBootstrap {
  private readonly workerId = `${hostname()}:${process.pid}`;

  constructor(
    private readonly execution: TaskExecutionService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {
    super();
  }

  onApplicationBootstrap(): void {
    // Worker 는 BullModule 의 onModuleInit 에서 만들어지므로 여기서 동시 실행 수를 맞춘다.
    this.worker.concurrency = this.config.worker.concurrency;
  }

  process(job: Job<AgentTaskJobData>): Promise<ExecutionOutcome> {
    return this.execution.execute(job.data, this.workerId);
  }
}
