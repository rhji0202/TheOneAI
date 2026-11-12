import { mcpResultToValue, ToolReportedError } from './mcp-result.js';

describe('mcpResultToValue', () => {
  it('structuredContent 를 우선한다', () => {
    expect(
      mcpResultToValue({
        content: [{ type: 'text', text: '{"a":1}' }],
        structuredContent: { status: 'shipped' },
      }),
    ).toEqual({ status: 'shipped' });
  });

  it('JSON 텍스트는 파싱, 일반 텍스트는 { text }', () => {
    expect(mcpResultToValue({ content: [{ type: 'text', text: '{"orderId":"A-1"}' }] })).toEqual({
      orderId: 'A-1',
    });
    expect(
      mcpResultToValue({
        content: [
          { type: 'text', text: '줄1' },
          { type: 'text', text: '줄2' },
        ],
      }),
    ).toEqual({
      text: '줄1\n줄2',
    });
  });

  it('이미지 · 리소스는 내용 없이 형식만 남긴다', () => {
    const value = mcpResultToValue({
      content: [
        { type: 'text', text: '첨부' },
        { type: 'image', data: 'AAAA', mimeType: 'image/png' },
        { type: 'resource', resource: { uri: 'file:///a.txt', text: 'hello' } },
        { type: 'resource_link', uri: 'https://x/y', name: 'y' },
      ],
    });
    expect(value).toEqual({
      content: [
        { type: 'text', text: '첨부' },
        { type: 'image', mimeType: 'image/png', note: 'binary content omitted' },
        { type: 'resource', uri: 'file:///a.txt', text: 'hello' },
        { type: 'resource_link', uri: 'https://x/y', name: 'y' },
      ],
    });
  });

  it('isError 는 ToolReportedError (재시도하지 않음)', () => {
    expect(() =>
      mcpResultToValue({ isError: true, content: [{ type: 'text', text: 'not found' }] }),
    ).toThrow(ToolReportedError);
  });
});
