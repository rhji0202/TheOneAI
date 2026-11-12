import { hashPassword, verifyPassword } from './password.js';

describe('password', () => {
  it('scrypt 해시 · 검증', async () => {
    const hash = await hashPassword('correct horse battery');
    expect(hash).toMatch(/^scrypt\$16384\$8\$1\$[^$]+\$[^$]+$/);
    expect(await verifyPassword('correct horse battery', hash)).toBe(true);
    expect(await verifyPassword('wrong', hash)).toBe(false);
  });

  it('같은 비밀번호도 salt 가 달라 해시가 다르다', async () => {
    expect(await hashPassword('pw')).not.toBe(await hashPassword('pw'));
  });

  it('계정이 없거나(null) 형식이 틀리면 false', async () => {
    expect(await verifyPassword('pw', null)).toBe(false);
    expect(await verifyPassword('pw', 'md5$abc')).toBe(false);
  });
});
