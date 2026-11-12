import { Module } from '@nestjs/common';
import { MemoriesAdminController } from './memories-admin.controller.js';
import { MemoriesAdminService } from './memories-admin.service.js';

@Module({
  controllers: [MemoriesAdminController],
  providers: [MemoriesAdminService],
})
export class MemoriesAdminModule {}
