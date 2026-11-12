import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { AppError } from '../common/errors/app-error.js';
import { type Page, type PageQuery, pageQuerySchema } from '../common/http/pagination.js';
import { CurrentSession, WidgetSessionGuard } from '../widget/widget-session.guard.js';
import type { WidgetSession } from '../widget/widget-session.js';
import {
  type ConversationView,
  ConversationsService,
  type SendMessageResponse,
} from './conversations.service.js';
import {
  type CreateConversationInput,
  createConversationSchema,
  idempotencyKeySchema,
  type MessageView,
  type SendMessageInput,
  sendMessageSchema,
} from './message-views.js';

const conversationId = { schema: z.uuid() };

@Controller({ path: 'conversations', version: '1' })
@UseGuards(WidgetSessionGuard)
export class ConversationsController {
  constructor(private readonly conversations: ConversationsService) {}

  @Post()
  @HttpCode(201)
  create(
    @CurrentSession() session: WidgetSession,
    @Body({ schema: createConversationSchema }) body: CreateConversationInput,
  ): Promise<ConversationView> {
    return this.conversations.create(session, body);
  }

  @Get()
  list(
    @CurrentSession() session: WidgetSession,
    @Query({ schema: pageQuerySchema }) page: PageQuery,
  ): Promise<Page<ConversationView>> {
    return this.conversations.list(session, page);
  }

  @Get(':id/messages')
  listMessages(
    @CurrentSession() session: WidgetSession,
    @Param('id', conversationId) id: string,
    @Query({ schema: pageQuerySchema }) page: PageQuery,
  ): Promise<Page<MessageView>> {
    return this.conversations.listMessages(session, id, page);
  }

  /** W-02 · 요청 전송 → 작업 생성 (202) */
  @Post(':id/messages')
  @HttpCode(202)
  send(
    @CurrentSession() session: WidgetSession,
    @Param('id', conversationId) id: string,
    @Body({ schema: sendMessageSchema }) body: SendMessageInput,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ): Promise<SendMessageResponse> {
    const key = idempotencyKeySchema.safeParse(idempotencyKey);
    if (!key.success) {
      throw new AppError(400, 'VALIDATION_FAILED', undefined, [
        { path: 'Idempotency-Key', message: key.error.issues[0]?.message ?? '형식 오류' },
      ]);
    }
    return this.conversations.sendMessage(session, id, body, key.data);
  }
}
