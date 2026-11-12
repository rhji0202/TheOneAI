import { Module } from '@nestjs/common';
import { SkillsAdminModule } from '../skills/admin/skills-admin.module.js';
import { MarketplaceSigner } from './marketplace-signer.service.js';
import { MarketplaceController } from './marketplace.controller.js';
import { MarketplaceService } from './marketplace.service.js';

/** 마켓플레이스 — Skill · MCP 서버 템플릿 공유 (플랫폼 서명) */
@Module({
  imports: [SkillsAdminModule],
  controllers: [MarketplaceController],
  providers: [MarketplaceService, MarketplaceSigner],
})
export class MarketplaceModule {}
