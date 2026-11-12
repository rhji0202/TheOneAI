import { Module } from '@nestjs/common';
import { SkillsAdminController } from './skills-admin.controller.js';
import { SkillsAdminService } from './skills-admin.service.js';

/** Admin API: Skill 업로드 · 검증 · 버전 · 활성화 (API 프로세스 전용) */
@Module({
  controllers: [SkillsAdminController],
  providers: [SkillsAdminService],
})
export class SkillsAdminModule {}
