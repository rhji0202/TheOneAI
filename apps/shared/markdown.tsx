import type { ReactNode } from 'react';

/**
 * 답변용 Markdown → React 요소 (HTML 을 그대로 넣지 않는다 — innerHTML 없음, 링크는 http(s) 만).
 * 지원: 문단 · 줄바꿈 · 제목(#~####) · 굵게 · 기울임 · 인라인 코드 · 코드 블록 · 목록 · 번호 목록 · 표 · 인용 · 구분선 · 링크
 */
export function Markdown({ text, className }: { text: string; className?: string }) {
  return <div className={className}>{blocks(text)}</div>;
}

const TABLE_SEPARATOR = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

function blocks(text: string): ReactNode[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const out: ReactNode[] = [];
  let i = 0;
  let key = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (/^\s*```/.test(line)) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i]!)) code.push(lines[i++]!);
      i++;
      out.push(
        <pre key={key++}>
          <code>{code.join('\n')}</code>
        </pre>,
      );
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      const level = Math.min(heading[1]!.length + 2, 6);
      const Tag = `h${level}` as 'h3';
      out.push(<Tag key={key++}>{inline(heading[2]!)}</Tag>);
      i++;
      continue;
    }
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
      out.push(<hr key={key++} />);
      i++;
      continue;
    }
    if (line.includes('|') && i + 1 < lines.length && TABLE_SEPARATOR.test(lines[i + 1]!)) {
      const header = cells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i]!.includes('|') && lines[i]!.trim())
        rows.push(cells(lines[i++]!));
      out.push(
        <div className="md-table" key={key++}>
          <table>
            <thead>
              <tr>
                {header.map((h, j) => (
                  <th key={j}>{inline(h)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, r) => (
                <tr key={r}>
                  {header.map((_, j) => (
                    <td key={j}>{inline(row[j] ?? '')}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }
    if (LIST_ITEM.test(line)) {
      const parsed = list(lines, i, indentOf(line), key++);
      out.push(parsed.node);
      i = parsed.next;
      continue;
    }
    if (/^\s*>/.test(line)) {
      const quoted: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i]!))
        quoted.push(lines[i++]!.replace(/^\s*>\s?/, ''));
      out.push(<blockquote key={key++}>{blocks(quoted.join('\n'))}</blockquote>);
      continue;
    }
    const paragraph: string[] = [];
    while (
      i < lines.length &&
      lines[i]!.trim() &&
      !/^\s*(```|#{1,4}\s|[-*+]\s|\d+[.)]\s|>)/.test(lines[i]!) &&
      !(lines[i]!.includes('|') && i + 1 < lines.length && TABLE_SEPARATOR.test(lines[i + 1]!))
    ) {
      paragraph.push(lines[i++]!);
    }
    out.push(
      <p key={key++}>
        {paragraph.map((p, j) => (
          <span key={j}>
            {j > 0 && <br />}
            {inline(p)}
          </span>
        ))}
      </p>,
    );
  }
  return out;
}

const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;

function indentOf(line: string): number {
  return (/^\s*/.exec(line)?.[0] ?? '').replace(/\t/g, '    ').length;
}

/** 목록 — 들여쓰기(2칸 이상)로 하위 목록을 만든다. 같은 깊이에서 종류(번호/기호)가 바뀌면 끝 */
function list(
  lines: string[],
  start: number,
  indent: number,
  key: number,
): { node: ReactNode; next: number } {
  const first = LIST_ITEM.exec(lines[start]!)!;
  const ordered = /\d/.test(first[2]!);
  const items: { text: string; children: ReactNode[] }[] = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) {
      // 빈 줄 다음에도 같은 목록이 이어지면 계속
      const nextLine = lines[i + 1];
      if (nextLine !== undefined && LIST_ITEM.test(nextLine) && indentOf(nextLine) >= indent) {
        i++;
        continue;
      }
      break;
    }
    const m = LIST_ITEM.exec(line);
    const depth = indentOf(line);
    if (m && depth <= indent + 1 && depth >= indent) {
      if (/\d/.test(m[2]!) !== ordered) break;
      items.push({ text: m[3]!, children: [] });
      i++;
    } else if (m && depth >= indent + 2 && items.length) {
      const nested = list(lines, i, depth, items.at(-1)!.children.length);
      items.at(-1)!.children.push(nested.node);
      i = nested.next;
    } else if (!m && depth >= indent + 2 && items.length) {
      items.at(-1)!.text += ` ${line.trim()}`;
      i++;
    } else break;
  }
  const List = ordered ? 'ol' : 'ul';
  return {
    node: (
      <List key={key}>
        {items.map((item, j) => (
          <li key={j}>
            {inline(item.text)}
            {item.children}
          </li>
        ))}
      </List>
    ),
    next: i,
  };
}

function cells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim());
}

const INLINE =
  /(`[^`]+`)|(\*\*[^*]+\*\*|__[^_]+__)|(\[[^\]]+\]\((https?:\/\/[^\s)]+)\))|(\*[^*\s][^*]*\*)/g;

function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let key = 0;
  for (const m of text.matchAll(INLINE)) {
    const index = m.index ?? 0;
    if (index > last) out.push(text.slice(last, index));
    const token = m[0];
    if (m[1]) out.push(<code key={key++}>{token.slice(1, -1)}</code>);
    else if (m[2]) out.push(<strong key={key++}>{inline(token.slice(2, -2))}</strong>);
    else if (m[3]) {
      const label = /^\[([^\]]+)\]/.exec(token)![1]!;
      out.push(
        <a key={key++} href={m[4]} target="_blank" rel="noopener noreferrer">
          {label}
        </a>,
      );
    } else if (m[5]) out.push(<em key={key++}>{token.slice(1, -1)}</em>);
    last = index + token.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
