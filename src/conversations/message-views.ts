import { z } from 'zod';
import type { Message } from '../generated/prisma/client.js';

const textBlock = z.object({ type: z.literal('text'), text: z.string().trim().min(1).max(8_000) });
const attachmentBlock = z.object({ type: z.literal('attachment'), artifactId: z.uuid() });
export const contentBlockSchema = z.discriminatedUnion('type', [textBlock, attachmentBlock]);
export type ContentBlock = z.infer<typeof contentBlockSchema>;

export const sendMessageSchema = z.object({
  content: z
    .array(contentBlockSchema)
    .min(1)
    .max(6)
    .refine((blocks) => blocks.some((b) => b.type === 'text'), '텍스트 블록이 하나 이상 필요합니다')
    .refine(
      (blocks) => blocks.filter((b) => b.type === 'attachment').length <= 5,
      '첨부는 5개까지 가능합니다',
    ),
});
export type SendMessageInput = z.infer<typeof sendMessageSchema>;

export const createConversationSchema = z
  .object({ title: z.string().trim().max(200).optional() })
  .default({});
export type CreateConversationInput = z.infer<typeof createConversationSchema>;

export const idempotencyKeySchema = z
  .string()
  .regex(/^[A-Za-z0-9_.:-]{8,200}$/, 'Idempotency-Key 는 8~200자의 영문 · 숫자 · _ . : - 입니다')
  .optional();

/** 응답의 첨부 블록 — 파일 이름 · 형식 · 크기를 채워 보낸다 (이미지 미리보기 · 파일 구분용) */
export interface AttachmentInfo {
  fileName: string;
  mimeType: string;
  sizeBytes: number;
}
export type ContentBlockView =
  | Extract<ContentBlock, { type: 'text' }>
  | (Extract<ContentBlock, { type: 'attachment' }> & Partial<AttachmentInfo>);

/** docs/api-spec.md §0 MessageView */
export interface MessageView {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: ContentBlockView[];
  taskId: string | null;
  createdAt: string;
}

export function toMessageView(message: Message): MessageView {
  const parsed = z.array(contentBlockSchema).safeParse(message.content);
  return {
    id: message.id,
    role: message.role,
    content: parsed.success ? parsed.data : [],
    taskId: message.taskId,
    createdAt: message.createdAt.toISOString(),
  };
}

/** 첫 텍스트 블록에서 작업 제목을 만든다 (60자). */
export function titleFromContent(content: ContentBlock[]): string {
  const text = content.find((b) => b.type === 'text')?.text ?? '새 작업';
  const firstLine = text.split('\n')[0]!.trim();
  return firstLine.length > 60 ? `${firstLine.slice(0, 59)}…` : firstLine;
}
