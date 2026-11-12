import { isDeepStrictEqual } from 'node:util';
import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { AppError } from '../common/errors/app-error.js';
import { BillingService } from '../billing/billing.service.js';
import { isUniqueViolation } from '../common/errors/prisma-errors.js';
import { type Page, type PageQuery, toPage } from '../common/http/pagination.js';
import { TaskEventsService } from '../events/task-events.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService, type TenantTx } from '../infrastructure/database/prisma.service.js';
import { ToolRegistryService } from '../tools/tool-registry.service.js';
import { AGENT_TASKS_QUEUE, type AgentTaskJobData } from '../infrastructure/queue/queues.js';
import {
  BLOCKING_STATUSES,
  taskSummarySelect,
  toTaskSummary,
  type TaskSummaryView,
} from '../tasks/task-views.js';
import type { WidgetSession } from '../widget/widget-session.js';
import {
  type CreateConversationInput,
  type MessageView,
  type SendMessageInput,
  titleFromContent,
  toMessageView,
} from './message-views.js';

export interface ConversationView {
  id: string;
  title: string | null;
  lastMessageAt: string | null;
  createdAt: string;
}

export interface SendMessageResponse {
  message: MessageView;
  task: TaskSummaryView;
  eventsUrl: string;
}

@Injectable()
export class ConversationsService {
  private readonly logger = new Logger(ConversationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: TaskEventsService,
    private readonly registry: ToolRegistryService,
    @InjectQueue(AGENT_TASKS_QUEUE) private readonly queue: Queue<AgentTaskJobData>,
    private readonly billing: BillingService,
  ) {}

  async create(session: WidgetSession, input: CreateConversationInput): Promise<ConversationView> {
    const conversation = await this.prisma.withTenant(session.tenantId, (tx) =>
      tx.conversation.create({
        data: {
          tenantId: session.tenantId,
          agentId: session.agentId,
          endUserId: session.endUserId,
          title: input.title ?? null,
        },
      }),
    );
    return toConversationView(conversation);
  }

  async list(session: WidgetSession, page: PageQuery): Promise<Page<ConversationView>> {
    const rows = await this.prisma.withTenant(session.tenantId, (tx) =>
      tx.conversation.findMany({
        where: {
          endUserId: session.endUserId,
          agentId: session.agentId,
          ...(page.cursor ? { id: { lt: page.cursor } } : {}),
        },
        orderBy: { id: 'desc' },
        take: page.limit + 1,
      }),
    );
    return toPage(rows, page.limit, toConversationView);
  }

  /** 최신 메시지부터 (클라이언트에서 역순 표시) */
  async listMessages(
    session: WidgetSession,
    conversationId: string,
    page: PageQuery,
  ): Promise<Page<MessageView>> {
    const rows = await this.prisma.withTenant(session.tenantId, async (tx) => {
      await this.findOwnConversation(tx, session, conversationId);
      return tx.message.findMany({
        where: { conversationId, ...(page.cursor ? { id: { lt: page.cursor } } : {}) },
        orderBy: { id: 'desc' },
        take: page.limit + 1,
      });
    });
    return toPage(rows, page.limit, toMessageView);
  }

  /**
   * 요청 전송 → 작업 생성 (docs/api-spec.md §2.2)
   * 한 트랜잭션에서 메시지 · 작업 · 첫 이벤트를 만들고, 커밋 후 BullMQ 에 넣는다.
   * HTTP 요청에서는 Agent 를 실행하지 않는다.
   */
  async sendMessage(
    session: WidgetSession,
    conversationId: string,
    input: SendMessageInput,
    idempotencyKey: string | undefined,
  ): Promise<SendMessageResponse> {
    const { tenantId } = session;
    const run = () =>
      this.prisma.withTenant(tenantId, async (tx) => {
        const conversation = await this.findOwnConversation(tx, session, conversationId);

        if (idempotencyKey) {
          const existing = await tx.message.findUnique({
            where: { conversationId_idempotencyKey: { conversationId, idempotencyKey } },
            include: { triggeredTask: { select: taskSummarySelect } },
          });
          if (existing) {
            if (!isDeepStrictEqual(existing.content, input.content) || !existing.triggeredTask) {
              throw new AppError(409, 'IDEMPOTENCY_KEY_REUSED');
            }
            return { message: existing, task: existing.triggeredTask, created: null };
          }
        }

        const attachmentIds = input.content.flatMap((b) =>
          b.type === 'attachment' ? [b.artifactId] : [],
        );
        if (attachmentIds.length > 0) {
          const usable = await tx.artifact.count({
            where: {
              id: { in: attachmentIds },
              origin: 'user_upload',
              endUserId: session.endUserId,
              messageId: null,
            },
          });
          if (usable !== attachmentIds.length) {
            throw new AppError(
              422,
              'ATTACHMENT_NOT_ALLOWED',
              '업로드가 완료된 내 파일만 첨부할 수 있습니다',
            );
          }
        }

        const active = await tx.task.findFirst({
          where: { conversationId, status: { in: BLOCKING_STATUSES } },
          select: { id: true },
        });
        if (active) {
          throw new AppError(
            409,
            'TASK_ALREADY_ACTIVE',
            `진행 중인 작업(${active.id})에 추가 지시를 보내세요`,
          );
        }

        // 월 비용 한도 — 넘었으면 새 작업을 받지 않는다
        await this.billing.assertWithinBudget(tx, tenantId);
        const agent = await tx.agent.findUnique({
          where: { id: session.agentId },
          select: { publishedVersionId: true, archivedAt: true },
        });
        if (!agent?.publishedVersionId || agent.archivedAt)
          throw new AppError(503, 'AGENT_NOT_PUBLISHED');
        // 작업은 생성 시점의 Tool Registry 버전을 끝까지 쓴다 (내장 Tool 이 바뀌었으면 새 버전 생성)
        const registryVersionId = await this.registry.ensureCurrentVersion(tx, tenantId);

        const title = titleFromContent(input.content);
        const message = await tx.message.create({
          data: {
            tenantId,
            conversationId,
            role: 'user',
            content: input.content as Prisma.InputJsonValue,
            idempotencyKey: idempotencyKey ?? null,
          },
        });
        const task = await tx.task.create({
          data: {
            tenantId,
            agentId: session.agentId,
            agentVersionId: agent.publishedVersionId,
            registryVersionId,
            conversationId,
            endUserId: session.endUserId,
            triggerMessageId: message.id,
            title,
          },
          select: taskSummarySelect,
        });
        const linked = await tx.message.update({
          where: { id: message.id },
          data: { taskId: task.id },
        });
        if (attachmentIds.length > 0) {
          await tx.artifact.updateMany({
            where: { id: { in: attachmentIds } },
            data: { messageId: message.id },
          });
        }
        await tx.conversation.update({
          where: { id: conversationId },
          data: { lastMessageAt: message.createdAt, ...(conversation.title ? {} : { title }) },
        });
        const event = await this.events.append(tx, tenantId, task.id, 'task.status', {
          status: 'queued',
        });
        return { message: linked, task, created: event };
      });

    let result: Awaited<ReturnType<typeof run>>;
    try {
      result = await run();
    } catch (err) {
      // 동시 요청 경쟁: DB 제약이 최종 판단한다.
      if (isUniqueViolation(err, 'tasks_one_active_per_conversation')) {
        throw new AppError(409, 'TASK_ALREADY_ACTIVE');
      }
      const lostRace =
        (idempotencyKey && isUniqueViolation(err, 'idempotency_key')) ||
        isUniqueViolation(err, 'tool_registry_versions_tenant_id_version_key');
      if (lostRace) {
        result = await run(); // 먼저 커밋된 요청 · Registry 버전을 기준으로 다시 처리한다.
      } else {
        throw err;
      }
    }

    if (result.created) {
      await this.events.publish(result.task.id, result.created);
      await this.enqueue(tenantId, result.task.id);
    }

    return {
      message: toMessageView(result.message),
      task: toTaskSummary(result.task),
      eventsUrl: `/v1/tasks/${result.task.id}/events`,
    };
  }

  private async enqueue(tenantId: string, taskId: string): Promise<void> {
    try {
      const job = await this.queue.add(
        'run',
        { tenantId, taskId, mode: 'start' },
        { jobId: taskId },
      );
      await this.prisma.withTenant(tenantId, (tx) =>
        tx.task.update({ where: { id: taskId }, data: { queueJobId: job.id ?? taskId } }),
      );
    } catch (err) {
      this.logger.error(`작업 큐 등록 실패 (${taskId}): ${String(err)}`);
      const failed = await this.prisma.withTenant(tenantId, async (tx) => {
        await tx.task.update({
          where: { id: taskId },
          data: {
            status: 'failed',
            failureCode: 'QUEUE_UNAVAILABLE',
            failureMessage: '작업 큐에 연결할 수 없습니다',
            finishedAt: new Date(),
          },
        });
        return this.events.append(tx, tenantId, taskId, 'task.failed', {
          code: 'QUEUE_UNAVAILABLE',
          message: '작업 큐에 연결할 수 없습니다',
          resumable: false,
          lastCheckpoint: null,
        });
      });
      await this.events.publish(taskId, failed);
      throw new AppError(
        503,
        'SERVICE_UNAVAILABLE',
        '작업을 시작하지 못했습니다. 잠시 후 다시 시도하세요.',
      );
    }
  }

  private async findOwnConversation(tx: TenantTx, session: WidgetSession, conversationId: string) {
    const conversation = await tx.conversation.findFirst({
      where: { id: conversationId, endUserId: session.endUserId, agentId: session.agentId },
      select: { id: true, title: true },
    });
    if (!conversation) throw AppError.notFound('대화를 찾을 수 없습니다');
    return conversation;
  }
}

function toConversationView(c: {
  id: string;
  title: string | null;
  lastMessageAt: Date | null;
  createdAt: Date;
}): ConversationView {
  return {
    id: c.id,
    title: c.title,
    lastMessageAt: c.lastMessageAt?.toISOString() ?? null,
    createdAt: c.createdAt.toISOString(),
  };
}
