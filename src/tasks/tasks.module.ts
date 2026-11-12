import { Module } from '@nestjs/common';
import {
  ConversationsAdminController,
  TasksAdminController,
} from './admin/tasks-admin.controller.js';
import { TasksAdminService } from './admin/tasks-admin.service.js';
import { TaskControlService } from './task-control.service.js';
import { TasksController } from './tasks.controller.js';
import { TasksService } from './tasks.service.js';

@Module({
  controllers: [TasksController, TasksAdminController, ConversationsAdminController],
  providers: [TasksService, TaskControlService, TasksAdminService],
  exports: [TaskControlService],
})
export class TasksModule {}
