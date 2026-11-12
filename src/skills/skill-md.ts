import { isMap, isScalar, LineCounter, parseDocument, type YAMLMap } from 'yaml';

/**
 * SKILL.md 파서 — Agent Skills 형식 (YAML frontmatter + Markdown 지침).
 *   name          필수. 소문자 · 숫자 · 하이픈 1~64자 (하이픈으로 시작 · 끝 · 연속 불가)
 *   description   필수. 1~1024자 — Skill Selector 가 이것만 보고 고른다
 *   allowed-tools 선택. 이 Skill 단계에서 쓸 Tool (Registry 이름, `서버.*` 와일드카드). 공백 · 쉼표 구분 문자열 또는 배열
 *   version       선택. semver (없으면 metadata.version, 그것도 없으면 등록 시 자동 증가)
 *   title · example_prompt  선택. 위젯 추천 카드 (W-01)
 *   license · compatibility · metadata  선택 (표준 필드)
 * 오류는 파일 기준 줄 번호와 함께 돌려준다 (C-06 미리보기).
 */
export interface ParsedSkill {
  frontmatter: Record<string, unknown>;
  name: string;
  description: string;
  allowedTools: string[];
  version: string | null;
  title: string | null;
  examplePrompt: string | null;
  body: string;
  /** 본문이 시작하는 줄 (1부터) */
  bodyStartLine: number;
  warnings: string[];
}

export interface SkillParseIssue {
  line: number;
  message: string;
}

export class SkillParseError extends Error {
  constructor(readonly issues: SkillParseIssue[]) {
    super(issues.map((i) => `${i.line}: ${i.message}`).join('\n'));
    this.name = 'SkillParseError';
  }
}

const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const KNOWN_KEYS = new Set([
  'name',
  'description',
  'allowed-tools',
  'version',
  'title',
  'example_prompt',
  'license',
  'compatibility',
  'metadata',
]);
const MAX_BODY_BYTES = 100 * 1024;
const RECOMMENDED_BODY_LINES = 500;

export function parseSkillMd(source: string): ParsedSkill {
  const text = source.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const lines = text.split('\n');
  if (lines[0]?.trim() !== '---') {
    throw new SkillParseError([
      { line: 1, message: 'SKILL.md 는 --- 로 시작하는 YAML frontmatter 가 필요합니다' },
    ]);
  }
  const end = lines.findIndex((l, i) => i > 0 && (l.trim() === '---' || l.trim() === '...'));
  if (end < 0)
    throw new SkillParseError([{ line: 1, message: 'frontmatter 를 닫는 --- 가 없습니다' }]);

  const yamlText = lines.slice(1, end).join('\n');
  const counter = new LineCounter();
  const doc = parseDocument(yamlText, {
    lineCounter: counter,
    uniqueKeys: true,
    prettyErrors: false,
  });
  // frontmatter 의 n 번째 줄 = 파일의 n + 1 번째 줄
  const lineAt = (offset: number) => counter.linePos(offset).line + 1;
  if (doc.errors.length) {
    throw new SkillParseError(
      doc.errors.map((e) => ({
        line: lineAt(e.pos[0]),
        message: `YAML 오류: ${e.message.split('\n')[0]}`,
      })),
    );
  }
  if (!isMap(doc.contents)) {
    throw new SkillParseError([
      { line: 2, message: 'frontmatter 는 key: value 형식이어야 합니다' },
    ]);
  }
  const map = doc.contents;
  const keyLine = (key: string) => {
    const pair = map.items.find((p) => isScalar(p.key) && p.key.value === key);
    const range = pair && isScalar(pair.key) ? pair.key.range : undefined;
    return range ? lineAt(range[0]) : 2;
  };

  const issues: SkillParseIssue[] = [];
  if (hasProtoKey(map)) issues.push({ line: 2, message: '__proto__ 키는 쓸 수 없습니다' });
  const fm = doc.toJS({ maxAliasCount: 20 }) as Record<string, unknown>;
  const warnings: string[] = [];

  const name = fm.name;
  if (typeof name !== 'string' || !name)
    issues.push({ line: keyLine('name'), message: 'name 이 필요합니다' });
  else if (name.length > 64 || !NAME.test(name)) {
    issues.push({
      line: keyLine('name'),
      message: 'name 은 소문자 · 숫자 · 하이픈 1~64자 (예: report-writer)',
    });
  }

  const description = fm.description;
  if (typeof description !== 'string' || !description.trim()) {
    issues.push({
      line: keyLine('description'),
      message: 'description 이 필요합니다 (언제 이 Skill 을 쓰는지)',
    });
  } else if (description.length > 1024) {
    issues.push({ line: keyLine('description'), message: 'description 은 1024자 이하' });
  }

  const allowedTools = parseToolList(fm['allowed-tools']);
  if (allowedTools === null) {
    issues.push({
      line: keyLine('allowed-tools'),
      message: 'allowed-tools 는 문자열(공백 · 쉼표 구분) 또는 문자열 배열',
    });
  }

  const metadata = fm.metadata;
  if (
    metadata !== undefined &&
    (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata))
  ) {
    issues.push({ line: keyLine('metadata'), message: 'metadata 는 key: value 형식' });
  }
  const rawVersion =
    fm.version ??
    (metadata && typeof metadata === 'object'
      ? (metadata as Record<string, unknown>).version
      : undefined);
  const version = rawVersion === undefined ? null : String(rawVersion);
  if (version !== null && !SEMVER.test(version)) {
    issues.push({
      line: keyLine(fm.version !== undefined ? 'version' : 'metadata'),
      message: 'version 은 semver (예: 1.2.0)',
    });
  }

  for (const [key, max] of [
    ['title', 80],
    ['example_prompt', 300],
    ['license', 200],
    ['compatibility', 500],
  ] as const) {
    const value = fm[key];
    if (value !== undefined && (typeof value !== 'string' || value.length > max)) {
      issues.push({ line: keyLine(key), message: `${key} 는 ${max}자 이하 문자열` });
    }
  }
  const unknown = Object.keys(fm).filter((k) => !KNOWN_KEYS.has(k));
  if (unknown.length) warnings.push(`알 수 없는 frontmatter 키 (무시): ${unknown.join(', ')}`);

  const body = lines
    .slice(end + 1)
    .join('\n')
    .trim();
  const bodyStartLine = end + 2;
  if (!body)
    issues.push({ line: bodyStartLine, message: 'frontmatter 아래에 지침(본문)이 없습니다' });
  else if (Buffer.byteLength(body) > MAX_BODY_BYTES) {
    issues.push({
      line: bodyStartLine,
      message: `지침이 ${MAX_BODY_BYTES / 1024}KB 를 넘습니다 — 자세한 내용은 references/ 로 나누세요`,
    });
  } else if (body.split('\n').length > RECOMMENDED_BODY_LINES) {
    warnings.push(
      `지침이 ${RECOMMENDED_BODY_LINES}줄을 넘습니다 — references/ 로 나누면 Context 를 아낄 수 있습니다`,
    );
  }

  if (issues.length) throw new SkillParseError(issues.sort((a, b) => a.line - b.line));
  return {
    frontmatter: fm,
    name: name as string,
    description: (description as string).trim(),
    allowedTools: allowedTools ?? [],
    version,
    title: typeof fm.title === 'string' ? fm.title : null,
    examplePrompt: typeof fm.example_prompt === 'string' ? fm.example_prompt : null,
    body,
    bodyStartLine,
    warnings,
  };
}

function parseToolList(value: unknown): string[] | null {
  if (value === undefined || value === null) return [];
  const items =
    typeof value === 'string' ? value.split(/[\s,]+/) : Array.isArray(value) ? value : null;
  if (!items || items.some((v) => typeof v !== 'string')) return null;
  return [...new Set((items as string[]).map((v) => v.trim()).filter(Boolean))];
}

function hasProtoKey(map: YAMLMap, depth = 0): boolean {
  if (depth > 10) return false;
  return map.items.some(
    (p) =>
      (isScalar(p.key) && p.key.value === '__proto__') ||
      (isMap(p.value) && hasProtoKey(p.value, depth + 1)),
  );
}
