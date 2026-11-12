import { createHash } from 'node:crypto';
import type { Tool } from '@modelcontextprotocol/client';
import type { PermissionLevel, SchemaCheck, SecurityCheck } from '../generated/prisma/client.js';
import { canonicalJson, compileSchema } from '../tools/json-schema.js';

/** MCP Tool 이름 — 모델 function 이름(서버명__Tool명, 64자 이내)으로 바꿀 수 있어야 한다 */
export const MCP_TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_DESCRIPTION = 2_000;
const MAX_SCHEMA_BYTES = 20_000;

export interface CheckResult<T> {
  result: T;
  issues: string[];
}

export interface CheckedTool {
  name: string;
  title: string | null;
  description: string | null;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown> | null;
  schemaHash: string;
  schema: CheckResult<SchemaCheck>;
  security: CheckResult<SecurityCheck>;
  suggestedLevel: PermissionLevel;
  /** 스키마 오류 · 보안 경고 · 삭제 · 금전 등급이면 기본 제외 */
  defaultInclude: boolean;
}

/** C-05 ② Tool 탐색 · 검증 — 스키마 유효성 + 보안 검사 + 제안 등급 */
export function checkTool(tool: Tool, serverName: string): CheckedTool {
  const description = tool.description?.trim() || null;
  const title = (tool.title ?? tool.annotations?.title)?.trim() || null;
  const inputSchema = (tool.inputSchema ?? {}) as Record<string, unknown>;
  const outputSchema = (tool.outputSchema ?? null) as Record<string, unknown> | null;

  const schema = checkSchema(tool.name, serverName, description, inputSchema);
  const security = checkSecurity(tool.name, title, description, inputSchema);
  const suggestedLevel = suggestLevel(tool, description);
  return {
    name: tool.name,
    title,
    description,
    inputSchema,
    outputSchema,
    schemaHash: hashTool(title, description, inputSchema, outputSchema),
    schema,
    security,
    suggestedLevel,
    defaultInclude:
      schema.result !== 'error' &&
      security.result === 'passed' &&
      suggestedLevel !== 'delete' &&
      suggestedLevel !== 'financial',
  };
}

export function hashTool(
  title: string | null,
  description: string | null,
  inputSchema: unknown,
  outputSchema: unknown,
): string {
  return createHash('sha256')
    .update(canonicalJson({ t: title, d: description, i: inputSchema, o: outputSchema }))
    .digest('hex');
}

function checkSchema(
  name: string,
  serverName: string,
  description: string | null,
  inputSchema: Record<string, unknown>,
): CheckResult<SchemaCheck> {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!MCP_TOOL_NAME.test(name)) errors.push('이름에 영문 · 숫자 · _ · - 외의 문자가 있습니다');
  if (`${serverName}__${name}`.length > 64) errors.push('서버 이름 + Tool 이름이 64자를 넘습니다');
  if (inputSchema.type !== 'object') errors.push('inputSchema 의 type 이 object 가 아닙니다');
  const compiled = compileSchema(inputSchema);
  if (!compiled.ok) errors.push(`JSON Schema 오류: ${compiled.error}`);
  if (Buffer.byteLength(JSON.stringify(inputSchema)) > MAX_SCHEMA_BYTES) {
    warnings.push(`스키마가 큽니다 (${MAX_SCHEMA_BYTES / 1000}KB 초과)`);
  }
  if (!description) warnings.push('설명이 없습니다');
  else if (description.length > MAX_DESCRIPTION)
    warnings.push(`설명이 ${MAX_DESCRIPTION}자를 넘습니다`);
  const props = (inputSchema.properties ?? {}) as Record<string, { description?: unknown }>;
  const undocumented = Object.entries(props)
    .filter(([, p]) => !p || typeof p !== 'object' || !p.description)
    .map(([k]) => k);
  if (undocumented.length) warnings.push(`설명 없는 인자: ${undocumented.slice(0, 5).join(', ')}`);
  return {
    result: errors.length ? 'error' : warnings.length ? 'warning' : 'valid',
    issues: [...errors, ...warnings],
  };
}

/** 설명 · 파라미터 속 숨은 지시문(프롬프트 주입), 숨김 문자, 민감정보 · 대량 반출 징후 */
const INJECTION_PATTERNS: Array<[RegExp, string]> = [
  [
    /ignore\s+(all\s+|any\s+|the\s+)?(previous|prior|above|earlier)\s+(instructions|prompts|rules)/i,
    '이전 지시 무시 요구',
  ],
  [/(system|developer)\s+prompt/i, '시스템 프롬프트 언급'],
  [/<\s*\/?\s*(important|instructions?|system|secret)\s*>/i, '숨은 지시 태그'],
  [
    /(do\s*not|don't|never)\s+(tell|inform|mention|reveal|show)\b.{0,40}\buser/i,
    '사용자에게 숨기라는 지시',
  ],
  [/before\s+(using|calling)\s+(this|any)\s+(other\s+)?tool/i, '다른 Tool 사용 전 행동 지시'],
  [
    /(read|send|upload|include)\b.{0,40}(~\/\.ssh|id_rsa|\.env|credentials|api[_ ]?keys?)/i,
    '자격 증명 반출 지시',
  ],
  [/이전\s*(의\s*)?지시.{0,10}무시/, '이전 지시 무시 요구'],
  [/시스템\s*프롬프트/, '시스템 프롬프트 언급'],
  [/사용자에게\s*(말하지|알리지|보여주지)\s*마/, '사용자에게 숨기라는 지시'],
];
const HIDDEN_CHARS = /[​-‏‪-‮⁠-⁤⁦-⁩﻿]|[\u{E0000}-\u{E007F}]/u;
const SENSITIVE_INPUT =
  /(password|passwd|비밀번호|api[_-]?key|secret|access[_-]?token|credit[_-]?card|card[_-]?number|ssn|주민(등록)?번호)/i;
const BULK_EXPORT =
  /\b(all[_ ]?(users|customers|members|records)|export[_ ]?all|dump|bulk[_ ]?export|전체\s*(회원|고객)\s*(목록|정보))\b/i;

function checkSecurity(
  name: string,
  title: string | null,
  description: string | null,
  inputSchema: Record<string, unknown>,
): CheckResult<SecurityCheck> {
  const failed: string[] = [];
  const warnings: string[] = [];
  const texts = [name, title ?? '', description ?? '', ...collectSchemaText(inputSchema)];
  const joined = texts.join('\n');

  for (const [pattern, label] of INJECTION_PATTERNS) {
    if (pattern.test(joined)) failed.push(`숨은 지시문 의심: ${label}`);
  }
  if (HIDDEN_CHARS.test(joined))
    failed.push('보이지 않는 문자(제로폭 · 방향 제어 · 태그 문자)가 있습니다');
  if (/https?:\/\/\S+/i.test(description ?? '')) warnings.push('설명에 외부 URL 이 있습니다');
  const props = Object.keys((inputSchema.properties ?? {}) as Record<string, unknown>);
  const sensitive = props.filter((p) => SENSITIVE_INPUT.test(p));
  if (sensitive.length) warnings.push(`민감정보를 인자로 받습니다: ${sensitive.join(', ')}`);
  if (BULK_EXPORT.test(`${name} ${description ?? ''}`)) warnings.push('대량 개인정보 반출 가능성');

  return {
    result: failed.length ? 'failed' : warnings.length ? 'warning' : 'passed',
    issues: [...new Set([...failed, ...warnings])],
  };
}

/** 스키마 안의 설명 · 제목 · enum 문자열 (주입 문구가 파라미터 설명에 숨어 있을 수 있다) */
function collectSchemaText(node: unknown, depth = 0, out: string[] = []): string[] {
  if (depth > 8 || !node || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const item of node) {
      if (typeof item === 'string') out.push(item);
      else collectSchemaText(item, depth + 1, out);
    }
    return out;
  }
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if ((key === 'description' || key === 'title') && typeof value === 'string') out.push(value);
    else if (key === 'default' && typeof value === 'string') out.push(value);
    else collectSchemaText(value, depth + 1, out);
  }
  return out;
}

const LEVEL_RANK: Record<PermissionLevel, number> = {
  read: 0,
  write: 1,
  external_send: 2,
  delete: 3,
  financial: 4,
};

/**
 * 제안 등급. 서버의 annotations(readOnlyHint · destructiveHint)와 이름 · 설명 키워드 중 더 엄격한 쪽을 쓴다.
 * annotations 는 서버가 주장하는 값이라 그대로 믿지 않는다 — 운영자가 C-05 ③에서 확정한다.
 */
export function suggestLevel(
  tool: Pick<Tool, 'name' | 'annotations'>,
  description: string | null,
): PermissionLevel {
  const text =
    `${tool.name.replace(/([a-z])([A-Z])/g, '$1_$2')} ${description ?? ''}`.toLowerCase();
  const keyword: PermissionLevel =
    /\b(pay|payment|charge|refund|transfer|purchase|invoice|billing|withdraw)/.test(text) ||
    /(결제|환불|송금|이체)/.test(text)
      ? 'financial'
      : /\b(delete|remove|destroy|drop|purge|erase|revoke)/.test(text) || /(삭제|제거)/.test(text)
        ? 'delete'
        : /\b(send|email|mail|post|publish|notify|message|share|tweet|sms|invite)/.test(text) ||
            /(발송|전송|공유|게시)/.test(text)
          ? 'external_send'
          : /^(get|list|search|find|read|fetch|lookup|look_up|query|describe|show|count|check|view)[_-]/.test(
                tool.name.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase() + '_',
              )
            ? 'read'
            : 'write';

  // annotations 가 없으면 키워드만, 있으면 더 엄격한 쪽 (readOnlyHint 는 이름이 모호(write 추정)할 때만 인정)
  const hints = tool.annotations ?? {};
  const annotated: PermissionLevel | null =
    hints.readOnlyHint === true ? 'read' : hints.destructiveHint === true ? 'delete' : null;
  if (!annotated) return keyword;
  if (annotated === 'read') return keyword === 'write' ? 'read' : keyword;
  return LEVEL_RANK[keyword] >= LEVEL_RANK[annotated] ? keyword : annotated;
}
