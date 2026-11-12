import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { AGENT_TASKS_QUEUE, type AgentTaskJobData, resumeJobId } from './queues.js';

const PENDING_STATES = new Set(['waiting', 'delayed', 'active', 'prioritized', 'waiting-children']);

/** agent-tasks 큐에 재개 · 복구 Job 을 넣는다 (API 의 재개 · 승인 결정, Worker 의 복구 · 종료 시 넘기기) */
@Injectable()
export class TaskQueueService {
  constructor(@InjectQueue(AGENT_TASKS_QUEUE) private readonly queue: Queue<AgentTaskJobData>) {}

  async enqueueResume(
    data: { tenantId: string; taskId: string; fromStepId?: string; restart?: boolean },
    jobId: { kind: 'resume' | 'recover'; n: number | string },
  ): Promise<string> {
    const id = resumeJobId(data.taskId, jobId.kind, jobId.n);
    await this.queue.add(
      'run',
      {
        tenantId: data.tenantId,
        taskId: data.taskId,
        mode: 'resume',
        ...(data.fromStepId ? { fromStepId: data.fromStepId } : {}),
        ...(data.restart ? { restart: true } : {}),
      },
      { jobId: id },
    );
    return id;
  }

  /** 아직 처리되지 않은 Job 이 있는가 (복구 잡이 같은 작업을 두 번 넣지 않도록) */
  async isPending(jobId: string): Promise<boolean> {
    const job = await this.queue.getJob(jobId);
    if (!job) return false;
    return PENDING_STATES.has(await job.getState());
  }

  async remove(jobId: string): Promise<void> {
    await this.queue.remove(jobId).catch(() => undefined);
  }
}
