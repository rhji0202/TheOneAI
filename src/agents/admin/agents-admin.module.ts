import { Module } from '@nestjs/common';
import { AgentsAdminController } from './agents-admin.controller.js';
import { AgentsAdminService } from './agents-admin.service.js';

@Module({
  controllers: [AgentsAdminController],
  providers: [AgentsAdminService],
})
export class AgentsAdminModule {}
