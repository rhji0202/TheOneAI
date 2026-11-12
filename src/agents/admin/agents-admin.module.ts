import { Module } from '@nestjs/common';
import { AgentsAdminController, ProvidersAdminController } from './agents-admin.controller.js';
import { AgentsAdminService } from './agents-admin.service.js';

@Module({
  controllers: [AgentsAdminController, ProvidersAdminController],
  providers: [AgentsAdminService],
})
export class AgentsAdminModule {}
