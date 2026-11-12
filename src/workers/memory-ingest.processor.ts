import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { MEMORY_INGEST_QUEUE, type MemoryIngestJobData } from '../infrastructure/queue/queues.js';
import { type IngestResult, MemoryIngestService } from '../memory/memory-ingest.service.js';

/** memory-ingest 큐 — 완료된 작업에서 기억을 추출해 저장한다 (실패하면 3회까지 다시) */
@Processor(MEMORY_INGEST_QUEUE, { concurrency: 2 })
export class MemoryIngestProcessor extends WorkerHost {
  constructor(private readonly ingest: MemoryIngestService) {
    super();
  }

  process(job: Job<MemoryIngestJobData>): Promise<IngestResult> {
    return this.ingest.ingest(job.data.tenantId, job.data.taskId);
  }
}
