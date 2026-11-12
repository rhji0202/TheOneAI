import { z } from 'zod';

const HOST_PATTERN = /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i;

/** 서버 이름은 Tool 이름 접두어가 된다 (예: crm-internal.lookup_order) */
export const serverNameSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{1,40}$/, '영문 소문자 · 숫자 · - 로 2~41자')
  .refine((n) => n !== 'builtin' && n !== 'skill', '예약된 이름입니다');

export const createServerSchema = z.object({
  name: serverNameSchema,
  description: z.string().trim().max(500).optional(),
  transport: z.enum(['streamable_http', 'stdio_sandbox']),
  endpointUrl: z.string().trim().max(2_000).optional(),
  image: z.string().trim().max(500).optional(),
  authType: z.enum(['none', 'api_key', 'oauth']).default('none'),
  /** write-only → Secret 저장소. 응답에 포함하지 않는다 */
  secret: z.string().min(1).max(8_000).optional(),
  allowedHosts: z
    .array(z.string().trim().regex(HOST_PATTERN, '호스트 이름 형식'))
    .max(20)
    .default([]),
  allowPrivateNetwork: z.boolean().default(false),
});
export type CreateServerInput = z.infer<typeof createServerSchema>;

export const updateServerSchema = z
  .object({
    description: z.string().trim().max(500).nullable(),
    endpointUrl: z.string().trim().max(2_000),
    authType: z.enum(['none', 'api_key', 'oauth']),
    secret: z.string().min(1).max(8_000),
    allowedHosts: z.array(z.string().trim().regex(HOST_PATTERN, '호스트 이름 형식')).max(20),
    allowPrivateNetwork: z.boolean(),
  })
  .partial();
export type UpdateServerInput = z.infer<typeof updateServerSchema>;

export const serverListQuerySchema = z.object({
  status: z.enum(['draft', 'pending_review', 'connected', 'error', 'disabled']).optional(),
  q: z.string().trim().max(100).optional(),
});
export type ServerListQuery = z.infer<typeof serverListQuerySchema>;

const permissionLevel = z.enum(['read', 'write', 'external_send', 'delete', 'financial']);
const approvalMode = z.enum(['auto', 'require_approval', 'always_approval', 'block']);

export const toolSelectionSchema = z.object({
  tools: z
    .array(
      z.object({
        name: z.string().min(1).max(64),
        include: z.boolean(),
        permissionLevel: permissionLevel.optional(),
        approvalModeOverride: approvalMode.nullable().optional(),
      }),
    )
    .min(1)
    .max(500),
});
export type ToolSelectionInput = z.infer<typeof toolSelectionSchema>;

export const toolPolicySchema = z
  .object({
    permissionLevel,
    approvalModeOverride: approvalMode.nullable(),
    enabled: z.boolean(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, '바꿀 값이 없습니다');
export type ToolPolicyInput = z.infer<typeof toolPolicySchema>;

export const approveChangesSchema = z.object({
  toolNames: z.array(z.string().min(1).max(64)).min(1).max(500),
});
export type ApproveChangesInput = z.infer<typeof approveChangesSchema>;

export const registryDiffQuerySchema = z.object({
  from: z.coerce.number().int().min(1).optional(),
});
