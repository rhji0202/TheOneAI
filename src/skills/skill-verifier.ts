import { findInjectionRisks } from '../common/security/text-risk.js';
import type { PermissionLevel } from '../generated/prisma/client.js';
import { matchesToolPattern } from '../tools/tool-names.js';
import { type BundleFile, decodeText } from './bundle/skill-bundle.js';
import type { ParsedSkill } from './skill-md.js';

export type CheckName =
  'source' | 'hash' | 'signature' | 'script_static' | 'instruction_risk' | 'tool_scope';
export type CheckStatus = 'passed' | 'warning' | 'failed' | 'skipped';

/** skill_versions.verification 한 줄 */
export interface VerificationCheck {
  check: CheckName;
  status: CheckStatus;
  detail: string;
  findings?: string[];
}

export interface VerifyInput {
  source: { kind: 'upload'; uploadedBy: string };
  files: BundleFile[];
  contentHash: string;
  skill: ParsedSkill;
  /** 지금 Registry 의 Tool (이름 · 등급) — allowed-tools 범위 검사용 */
  knownTools: Array<{ name: string; level: PermissionLevel }>;
}

/**
 * Skill 신뢰 검증 (C-06 ⑥, 공급망). 하나라도 failed 면 활성화할 수 없다.
 * 스크립트는 아직 실행하지 않는다(Sandbox 단계) — 정적 검사 결과만 남긴다.
 */
export function verifySkill(input: VerifyInput): VerificationCheck[] {
  return [
    {
      check: 'source',
      status: 'passed',
      detail: `콘솔 업로드 (${input.source.uploadedBy})`,
    },
    {
      check: 'hash',
      status: 'passed',
      detail: `sha256:${input.contentHash} · 파일 ${input.files.length}개 · ${formatBytes(input.files.reduce((n, f) => n + f.size, 0))}`,
    },
    {
      check: 'signature',
      status: 'skipped',
      detail: '업로드 번들은 서명이 없습니다 (서명 검증은 Git · 마켓플레이스 출처에서)',
    },
    checkScripts(input.files),
    checkInstructions(input.files),
    checkToolScope(input.skill.allowedTools, input.knownTools),
  ];
}

export function overallStatus(checks: VerificationCheck[]): 'passed' | 'failed' {
  return checks.some((c) => c.status === 'failed') ? 'failed' : 'passed';
}

/** 스크립트 정적 검사 — 원격 코드 실행 · 난독화 실행은 실패, 네트워크 · 프로세스 · 자격 증명 접근은 경고 */
const SCRIPT_FAIL: Array<[RegExp, string]> = [
  [/\b(curl|wget)\b[^|\n]*\|\s*(ba|z)?sh\b/, '내려받은 코드를 바로 실행 (curl | sh)'],
  [/base64\s+(-d|--decode)[^|\n]*\|\s*(ba|z)?sh\b/, '난독화된 코드 실행 (base64 | sh)'],
  [
    /\b(eval|exec)\s*\(\s*(atob|base64|b64decode|Buffer\.from|codecs\.decode|zlib\.decompress)/,
    '난독화된 코드 실행 (eval/exec + 디코드)',
  ],
  [/\/dev\/tcp\/|\bnc\s+(-\w+\s+)*-e\b|\bbash\s+-i\s*>&/, '리버스 셸'],
  [/\brm\s+-rf\s+(\/|~|\$HOME)(\s|$)/, '루트 · 홈 디렉터리 삭제'],
];
const SCRIPT_WARN: Array<[RegExp, string]> = [
  [
    /\b(requests|urllib|httpx|aiohttp|http\.client|socket)\b|\bfetch\s*\(|\baxios\b|\b(curl|wget)\b/,
    '네트워크 접근',
  ],
  [
    /\bsubprocess\b|\bos\.system\b|\bchild_process\b|\b(eval|exec)\s*\(/,
    '프로세스 실행 · 동적 코드',
  ],
  [
    /\bos\.environ\b|\bprocess\.env\b|~\/\.ssh|\.aws\/credentials|\bid_rsa\b|\.netrc\b/,
    '환경 변수 · 자격 증명 접근',
  ],
];

function checkScripts(files: BundleFile[]): VerificationCheck {
  const scripts = files.filter((f) => f.kind === 'script');
  if (!scripts.length) return { check: 'script_static', status: 'passed', detail: '스크립트 없음' };
  const failed: string[] = [];
  const warned: string[] = [];
  for (const file of scripts) {
    const text = decodeText(file.data);
    if (text === null) {
      failed.push(`${file.path}: 텍스트가 아닌 실행 파일`);
      continue;
    }
    for (const [pattern, label] of SCRIPT_FAIL)
      if (pattern.test(text)) failed.push(`${file.path}: ${label}`);
    for (const [pattern, label] of SCRIPT_WARN)
      if (pattern.test(text)) warned.push(`${file.path}: ${label}`);
  }
  const note = `스크립트 ${scripts.length}개 — 실행은 Sandbox 단계에서 지원 (지금은 읽기만 가능)`;
  if (failed.length)
    return {
      check: 'script_static',
      status: 'failed',
      detail: note,
      findings: [...failed, ...warned],
    };
  if (warned.length)
    return { check: 'script_static', status: 'warning', detail: note, findings: warned };
  return { check: 'script_static', status: 'passed', detail: note };
}

/** 지침 · 참조 문서 · 템플릿 속 숨은 지시문 · 보이지 않는 문자 (실패), 외부 URL · 데이터 반출 지시 (경고) */
function checkInstructions(files: BundleFile[]): VerificationCheck {
  const failed: string[] = [];
  const warned: string[] = [];
  for (const file of files) {
    if (file.kind !== 'skill' && file.kind !== 'doc' && file.kind !== 'template') continue;
    const text = decodeText(file.data);
    if (text === null) continue;
    for (const risk of findInjectionRisks([text])) failed.push(`${file.path}: ${risk}`);
    if (
      /(send|post|upload|forward)\b.{0,40}\b(conversation|chat history|user data|personal data)/i.test(
        text,
      ) ||
      /(대화\s*내용|개인\s*정보).{0,20}(전송|보내|업로드)/.test(text)
    ) {
      warned.push(`${file.path}: 대화 · 개인정보를 외부로 보내라는 지시`);
    }
    const hosts = [...text.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)].map((m) => m[1]!.toLowerCase());
    if (hosts.length)
      warned.push(`${file.path}: 외부 URL (${[...new Set(hosts)].slice(0, 5).join(', ')})`);
  }
  if (failed.length) {
    return {
      check: 'instruction_risk',
      status: 'failed',
      detail: '숨은 지시문 · 보이지 않는 문자가 있습니다',
      findings: [...failed, ...warned],
    };
  }
  if (warned.length)
    return {
      check: 'instruction_risk',
      status: 'warning',
      detail: '확인이 필요한 지침이 있습니다',
      findings: warned,
    };
  return { check: 'instruction_risk', status: 'passed', detail: '위험 패턴 없음' };
}

const RISKY_LEVELS: PermissionLevel[] = ['external_send', 'delete', 'financial'];

/** allowed-tools 범위 — 등록되지 않은 Tool · 전체 허용 · 위험 등급은 경고 (실행 시에도 권한 정책은 그대로 적용) */
function checkToolScope(
  allowed: string[],
  known: Array<{ name: string; level: PermissionLevel }>,
): VerificationCheck {
  if (!allowed.length) {
    return {
      check: 'tool_scope',
      status: 'passed',
      detail: 'allowed-tools 없음 — Skill 단계에서 Tool 없이 지침 · 참조 자료만 씁니다',
    };
  }
  const warned: string[] = [];
  const matched = new Map<string, PermissionLevel>();
  for (const entry of allowed) {
    if (entry === '*' || entry === '*.*') {
      warned.push(`'${entry}': 모든 Tool 허용 — 필요한 Tool 만 적어 주세요`);
      known.forEach((t) => matched.set(t.name, t.level));
      continue;
    }
    const hits = known.filter((t) => matchesToolPattern(t.name, entry));
    if (!hits.length)
      warned.push(`'${entry}': 지금 Registry 에 없는 Tool (등록되기 전까지 쓸 수 없음)`);
    hits.forEach((t) => matched.set(t.name, t.level));
  }
  const risky = [...matched]
    .filter(([, level]) => RISKY_LEVELS.includes(level))
    .map(([name, level]) => `${name} (${level})`);
  if (risky.length)
    warned.push(
      `위험 등급 Tool 포함: ${risky.join(', ')} — 실행 시 권한 정책(승인)이 그대로 적용됩니다`,
    );
  const detail = `허용 Tool ${matched.size}개: ${[...matched.keys()].slice(0, 10).join(', ') || '없음'}`;
  return warned.length
    ? { check: 'tool_scope', status: 'warning', detail, findings: warned }
    : { check: 'tool_scope', status: 'passed', detail };
}

function formatBytes(n: number): string {
  return n < 1024
    ? `${n}B`
    : n < 1024 * 1024
      ? `${(n / 1024).toFixed(1)}KB`
      : `${(n / 1024 / 1024).toFixed(1)}MB`;
}
