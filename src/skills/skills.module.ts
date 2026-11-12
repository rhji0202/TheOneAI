import { Global, Module } from '@nestjs/common';
import { SkillToolsRegistrar } from './skill-read-file.tool.js';
import { SkillRuntimeService } from './skill-runtime.service.js';
import { SkillStoreService } from './skill-store.service.js';

/** Skill 파일 저장 · 실행 시 로딩 (API · Worker 공통). 관리 API 는 SkillsAdminModule */
@Global()
@Module({
  providers: [SkillStoreService, SkillRuntimeService, SkillToolsRegistrar],
  exports: [SkillStoreService, SkillRuntimeService],
})
export class SkillsModule {}
