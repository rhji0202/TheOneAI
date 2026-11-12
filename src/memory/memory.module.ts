import { Global, Module } from '@nestjs/common';
import { EmbeddingService } from './embedding.service.js';
import { MemoryRetriever } from './memory-retriever.service.js';

/** Memory 임베딩 · 검색 (API · Worker 공통). 저장(memory-ingest)은 Worker, 관리 API 는 MemoriesAdminModule */
@Global()
@Module({
  providers: [EmbeddingService, MemoryRetriever],
  exports: [EmbeddingService, MemoryRetriever],
})
export class MemoryModule {}
