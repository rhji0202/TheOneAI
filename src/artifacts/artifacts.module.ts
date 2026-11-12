import { Global, Module } from '@nestjs/common';
import { ArtifactsService } from './artifacts.service.js';
import { ArtifactToolsRegistrar } from './create-file.tool.js';

/** 첨부 · 산출물 저장 · builtin.create_file (API · Worker 공통). HTTP 는 ArtifactsHttpModule */
@Global()
@Module({
  providers: [ArtifactsService, ArtifactToolsRegistrar],
  exports: [ArtifactsService],
})
export class ArtifactsModule {}
