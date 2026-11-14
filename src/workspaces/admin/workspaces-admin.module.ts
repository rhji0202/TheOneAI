import { Module } from '@nestjs/common';
import { WorkspacesAdminController } from './workspaces-admin.controller.js';
import { WorkspacesAdminService } from './workspaces-admin.service.js';

@Module({
  controllers: [WorkspacesAdminController],
  providers: [WorkspacesAdminService],
})
export class WorkspacesAdminModule {}
