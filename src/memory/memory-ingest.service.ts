import { Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import { memoryPolicySchema } from '../agents/agent-policies.js';
import type { TaskRunInfo } from '../agent-runtime/run-context.js';
import { ModelRouterFactory } from '../agent-runtime/model-router.js';
import { BillingService } from '../billing/billing.service.js';
import { UsageMeter } from '../billing/usage-meter.js';
import {
  MEMORY_EXTRACT_ROLE,
  renderNotes,
  systemPrompt,
  type WorkNote,
} from '../agent-runtime/prompts.js';
import { findInjectionRisks } from '../common/security/text-risk.js';
import { uuidv7 } from '../common/uuid.js';
import type { MemorySourceType } from '../generated/prisma/client.js';
import { PrismaService, type TenantTx } from '../infrastructure/database/prisma.service.js';
import { parseJsonOutput } from '../llm/json-output.js';
import { maskSensitive } from '../tools/masking.js';
import { EmbeddingService, toVectorLiteral } from './embedding.service.js';
import { MemoryRetriever } from './memory-retriever.service.js';

const extractionSchema = z.object({
  memories: z
    .array(
      z.object({
        type: z.enum(['semantic', 'episodic', 'procedural']),
        scope: z.enum(['user', 'agent']),
        title: z.string().trim().max(60).default(''),
        content: z.string().trim().min(1).max(300),
        confidence: z.number().min(0).max(1).default(0.7),
      }),
    )
    .max(4),
});

export interface IngestResult {
  saved: number;
  updated: number;
  quarantined: number;
  skipped?: string;
}

/** 같은 범위 · 종류의 기억과 이만큼 가까우면 새로 만들지 않고 합친다 */
const DUPLICATE_SCORE = 0.9;

/**
 * memory-ingest (docs/api-spec.md §6) — 작업이 끝나면 대화 · 작업 노트 · 답변에서 남길 만한 것을 뽑아 저장한다.
 *  - semantic(사용자 사실 · 선호) · episodic(요청과 결과 요약)은 user 범위, procedural(일하는 방법)은 agent 범위
 *  - 익명 사용자는 user 범위 기억을 남기지 않는다 · Memory 정책(enabled · types · retentionDays)을 따른다
 *  - 민감정보는 가리고, 지시문처럼 보이는 내용(프롬프트 주입)은 quarantined 로 격리해 Context 에 쓰지 않는다
 *  - 이미 있는 기억과 거의 같으면 새로 만들지 않고 출처 · 신뢰도만 갱신한다
 */
@Injectable()
export class MemoryIngestService {
  private readonly logger = new Logger(MemoryIngestService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly routers: ModelRouterFactory,
    private readonly embeddings: EmbeddingService,
    private readonly retriever: MemoryRetriever,
    private readonly billing: BillingService,
  ) {}

  async ingest(tenantId: string, taskId: string): Promise<IngestResult> {
    const loaded = await this.prisma.withTenant(tenantId, async (tx) => {
      // 관계를 include 로 한 번에 읽으면 같은 트랜잭션 연결에 쿼리가 겹쳐 나간다 — 차례로 읽는다
      const task = await tx.task.findUnique({ where: { id: taskId } });
      if (!task || task.status !== 'completed') return null;
      const version = await tx.agentVersion.findUniqueOrThrow({
        where: { id: task.agentVersionId },
        select: { memoryPolicy: true },
      });
      const endUser = await tx.endUser.findUniqueOrThrow({
        where: { id: task.endUserId },
        select: { externalId: true, erasedAt: true },
      });
      const trigger = task.triggerMessageId
        ? await tx.message.findUnique({
            where: { id: task.triggerMessageId },
            select: { content: true },
          })
        : null;
      const replies = await tx.message.findMany({
        where: { taskId, role: 'assistant' },
        orderBy: { id: 'asc' },
        select: { content: true },
      });
      // Reflection — 이 작업에서 잘못된 것 (처리 요령 기억의 근거)
      const failures = await tx.toolExecution.findMany({
        where: { taskId, status: { in: ['failed', 'timeout', 'denied'] } },
        orderBy: { startedAt: 'asc' },
        take: 10,
        select: { toolName: true, status: true, deniedReason: true, errorMessage: true },
      });
      const replans = await tx.taskEvent.findMany({
        where: { taskId, type: 'plan.revised' },
        orderBy: { id: 'asc' },
        take: 5,
        select: { payload: true },
      });
      const checks = await tx.taskStep.findMany({
        where: { taskId, type: 'evaluate', name: { startsWith: 'evaluator.verify' } },
        orderBy: { seq: 'asc' },
        select: { evaluation: true },
      });
      const checkpoint = task.lastCheckpointStepId
        ? await tx.taskStep.findUnique({
            where: { id: task.lastCheckpointStepId },
            select: { checkpoint: true },
          })
        : null;
      const memory = (checkpoint?.checkpoint as { workingMemory?: { notes?: WorkNote[] } } | null)
        ?.workingMemory;
      return {
        task,
        policy: version.memoryPolicy,
        endUser,
        request: textOf(trigger?.content),
        // 정정 메시지가 있으면 답변 뒤에 이어 붙인다
        answer: replies
          .map((r) => textOf(r.content))
          .filter(Boolean)
          .join('\n\n[Follow-up correction]\n'),
        lessons: [
          ...failures.map(
            (f) =>
              `Tool ${f.toolName} ${f.status === 'denied' ? `was refused (${f.deniedReason ?? 'denied'})` : f.status === 'timeout' ? 'timed out' : 'failed'}${f.errorMessage ? `: ${f.errorMessage.slice(0, 160)}` : ''}`,
          ),
          ...replans.flatMap((e) => {
            const reason = (e.payload as { reason?: unknown } | null)?.reason;
            return typeof reason === 'string' && reason ? [`The plan was revised: ${reason}`] : [];
          }),
          ...checks.flatMap((c) => {
            const issues = (c.evaluation as { issues?: unknown } | null)?.issues;
            return Array.isArray(issues)
              ? issues
                  .filter((i): i is string => typeof i === 'string')
                  .map((i) => `Answer check found: ${i}`)
              : [];
          }),
        ],
        notes: Array.isArray(memory?.notes) ? memory.notes : [],
      };
    });
    if (!loaded) return { saved: 0, updated: 0, quarantined: 0, skipped: 'not_completed' };
    const { task, notes, endUser, request, answer, lessons } = loaded;
    const policy = memoryPolicySchema.parse(loaded.policy ?? {});
    if (!policy.enabled) return { saved: 0, updated: 0, quarantined: 0, skipped: 'disabled' };

    if (!request) return { saved: 0, updated: 0, quarantined: 0, skipped: 'no_request' };

    const meter = new UsageMeter();
    const router = await this.routers.forTask(
      { tenantId, agentVersionId: task.agentVersionId } as TaskRunInfo,
      meter,
    );
    const res = await router
      .complete(
        'evaluator',
        {
          json: true,
          maxOutputTokens: 800,
          messages: [
            { role: 'system', content: systemPrompt('', MEMORY_EXTRACT_ROLE) },
            {
              role: 'user',
              content: [
                `User request:\n${request}`,
                `Working notes:\n${truncate(renderNotes(notes), 4_000)}`,
                `Final answer sent to the user:\n${truncate(answer, 3_000)}`,
                ...(lessons.length
                  ? [
                      `What went wrong or was corrected during the task (use for procedural lessons):\n${lessons.map((l) => `- ${l}`).join('\n')}`,
                    ]
                  : []),
              ].join('\n\n'),
            },
          ],
        },
        AbortSignal.timeout(60_000),
      )
      .finally(() =>
        // 기억 추출에 쓴 모델 사용량도 그 작업의 비용으로
        this.billing.flushQuietly(
          { tenantId, agentId: task.agentId, taskId, purpose: 'memory' },
          meter,
        ),
      );
    const parsed = parseJsonOutput(res.content, extractionSchema);
    if (!parsed.ok) {
      this.logger.warn(`기억 추출 형식 오류 (${taskId}): ${parsed.error}`);
      return { saved: 0, updated: 0, quarantined: 0, skipped: 'invalid_output' };
    }

    const candidates = parsed.value.memories.filter(
      (m) =>
        policy.types.includes(m.type) &&
        // 익명(외부 ID 없음) · 삭제된 사용자는 user 범위 기억을 남기지 않는다
        !(m.scope === 'user' && (endUser.externalId === null || endUser.erasedAt !== null)),
    );
    const result: IngestResult = { saved: 0, updated: 0, quarantined: 0 };
    if (!candidates.length) return result;
    const vectors = await this.embeddings.embed(
      candidates.map((m) => `${m.title}\n${maskSensitive(m.content) as string}`),
    );

    await this.prisma.withTenant(tenantId, async (tx) => {
      for (const [i, m] of candidates.entries()) {
        const content = maskSensitive(m.content) as string;
        const title = (maskSensitive(m.title) as string) || null;
        const risks = findInjectionRisks([title ?? '', content]);
        const endUserId = m.scope === 'user' ? task.endUserId : null;
        const vector = toVectorLiteral(vectors[i]!);

        if (!risks.length) {
          const [same] = await this.retriever.semantic(tx, {
            agentId: task.agentId,
            endUserId,
            text: `${title ?? ''}\n${content}`,
            limit: 1,
            types: [m.type],
            scope: m.scope,
            minScore: DUPLICATE_SCORE,
          });
          if (same && (m.scope === 'agent' || same.endUserId === endUserId)) {
            await tx.memory.update({
              where: { id: same.id },
              data: {
                content,
                title,
                confidence: Math.max(same.confidence, m.confidence),
                sourceTaskIds: [...new Set([...same.sourceTaskIds, taskId])],
                expiresAt: same.pinned ? null : expiry(policy.retentionDays),
              },
            });
            await setEmbedding(tx, same.id, vector, this.embeddings.model);
            result.updated++;
            continue;
          }
        }

        const id = uuidv7();
        await tx.memory.create({
          data: {
            id,
            tenantId,
            agentId: task.agentId,
            endUserId,
            type: m.type,
            scope: m.scope,
            title,
            content,
            sourceType: sourceTypeOf(m.type),
            sourceTaskIds: [taskId],
            sourceConversationId: task.conversationId,
            confidence: m.confidence,
            // 모델이 대화에서 뽑은 내용 — 사용자가 직접 확인한 사실은 아니다
            needsVerification: m.confidence < 0.8,
            status: risks.length ? 'quarantined' : 'active',
            quarantineReason: risks.length ? risks.join('; ') : null,
            expiresAt: expiry(policy.retentionDays),
          },
        });
        await setEmbedding(tx, id, vector, this.embeddings.model);
        if (risks.length) result.quarantined++;
        else result.saved++;
      }
    });
    return result;
  }
}

export async function setEmbedding(
  tx: TenantTx,
  id: string,
  vector: string,
  model: string,
): Promise<void> {
  await tx.$executeRaw`UPDATE memories SET embedding = ${vector}::vector, embedding_model = ${model} WHERE id = ${id}::uuid`;
}

function sourceTypeOf(type: 'semantic' | 'episodic' | 'procedural'): MemorySourceType {
  return type === 'semantic' ? 'user_message' : 'reflection';
}

function expiry(days: number): Date {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1_000);
}

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .flatMap((b: { type?: string; text?: string }) =>
      b?.type === 'text' && typeof b.text === 'string' ? [b.text] : [],
    )
    .join('\n')
    .trim();
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
