import { isOriginAllowed, normalizeOrigin } from './origin.js';

describe('normalizeOrigin', () => {
  it('scheme · host · port 만 남기고 소문자로 맞춘다', () => {
    expect(normalizeOrigin('https://Shop.Example.com:443/path?q=1')).toBe(
      'https://shop.example.com',
    );
    expect(normalizeOrigin('http://localhost:5173')).toBe('http://localhost:5173');
  });

  it('http(s) 가 아니거나 형식이 잘못되면 null', () => {
    expect(normalizeOrigin('chrome-extension://abc')).toBeNull();
    expect(normalizeOrigin('not a url')).toBeNull();
    expect(normalizeOrigin('null')).toBeNull();
  });
});

describe('isOriginAllowed', () => {
  const allowed = [
    'https://www.example.com',
    'https://*.shop.example.com',
    'http://localhost:5173',
  ];

  it.each([
    ['https://www.example.com', true],
    ['https://WWW.example.com', true],
    ['http://www.example.com', false],
    ['https://www.example.com:8443', false],
    ['https://a.shop.example.com', true],
    ['https://a.b.shop.example.com', false],
    ['https://shop.example.com', false],
    ['https://evilshop.example.com', false],
    ['http://localhost:5173', true],
    ['http://localhost:3000', false],
    ['null', false],
  ])('%s → %s', (origin, expected) => {
    expect(isOriginAllowed(origin, allowed)).toBe(expected);
  });
});
