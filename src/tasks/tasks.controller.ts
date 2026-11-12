import { Controller, Get, HttpCode, Param, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import type { Page } from '../common/http/pagination.js';
import { parseLastEventId, SseStreamService } from '../events/sse-stream.service.js';
import { CurrentSession, WidgetSessionGuard } from '../widget/widget-session.guard.js';
import type { WidgetSession } from '../widget/widget-session.js';
import type { TaskSummaryView } from './task-views.js';
import {
  type TaskDetailView,
  type TaskListQuery,
  taskListQuerySchema,
  TasksService,
} from './tasks.service.js';

const taskId = { schema: z.uuid() };

@Controller({ path: 'tasks', version: '1' })
@UseGuards(WidgetSessionGuard)
export class TasksController {
  constructor(
    private readonly tasks: TasksService,
    private readonly sse: SseStreamService,
  ) {}

  /** W-05 · 작업 목록 */
  @Get()
  list(
    @CurrentSession() session: WidgetSession,
    @Query({ schema: taskListQuerySchema }) query: TaskListQuery,
  ): Promise<Page<TaskSummaryView>> {
    return this.tasks.list(session, query);
  }

  /** W-02 · 작업 상태 · 계획 · 대기 중 승인 · 결과 */
  @Get(':id')
  get(
    @CurrentSession() session: WidgetSession,
    @Param('id', taskId) id: string,
  ): Promise<TaskDetailView> {
    return this.tasks.get(session, id);
  }

  /** W-02 · 중지 */
  @Post(':id/cancel')
  @HttpCode(202)
  cancel(
    @CurrentSession() session: WidgetSession,
    @Param('id', taskId) id: string,
  ): Promise<TaskSummaryView> {
    return this.tasks.cancel(session, id);
  }

  /** W-02 ~ W-05 · 실행 이벤트 SSE. Last-Event-ID 헤더(또는 ?lastEventId=)로 이어 받기 */
  @Get(':id/events')
  async events(
    @CurrentSession() session: WidgetSession,
    @Param('id', taskId) id: string,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    await this.tasks.assertOwned(session, id);
    const lastEventId = parseLastEventId(
      req.header('last-event-id') ??
        (typeof req.query.lastEventId === 'string' ? req.query.lastEventId : undefined),
    );
    await this.sse.stream(req, res, { tenantId: session.tenantId, taskId: id, lastEventId });
  }
}
