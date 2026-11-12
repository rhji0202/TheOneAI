import type { AppConfig } from '../config/app-config.js';
import type { SecretStore } from '../infrastructure/secrets/secret-store.js';
import { MarketplaceSigner } from './marketplace-signer.service.js';

const memoryStore = () => {
  const values = new Map<string, string>();
  return {
    values,
    store: {
      get: async (ref: string) => values.get(ref) ?? null,
      put: async (ref: string, value: string) => void values.set(ref, value),
      delete: async (ref: string) => void values.delete(ref),
    } as unknown as SecretStore,
  };
};
const config = (env: AppConfig['env']) =>
  ({ env, marketplace: { signingKeyRef: 'vault://test/key' } }) as unknown as AppConfig;
const content = {
  kind: 'skill',
  name: 'refund-guide',
  version: '1.0.0',
  contentHash: 'abc',
  manifest: { files: [{ path: 'SKILL.md', sha256: 'f1' }], allowedTools: ['builtin.calculate'] },
};

describe('MarketplaceSigner', () => {
  it('서명한 내용은 확인되고, 키 순서가 달라도 같다', async () => {
    const { store, values } = memoryStore();
    const signer = new MarketplaceSigner(config('test'), store);
    const { signature, keyId } = await signer.sign(content);
    expect(values.get('vault://test/key')).toContain('PRIVATE KEY');
    expect(await signer.verify({ ...content }, signature, keyId)).toBe(true);
    const reordered = {
      manifest: content.manifest,
      contentHash: 'abc',
      version: '1.0.0',
      name: 'refund-guide',
      kind: 'skill',
    };
    expect(await signer.verify(reordered, signature, keyId)).toBe(true);
  });

  it('내용 · 서명 · 키가 하나라도 다르면 false', async () => {
    const { store } = memoryStore();
    const signer = new MarketplaceSigner(config('test'), store);
    const { signature, keyId } = await signer.sign(content);
    const tampered = { ...content, manifest: { ...content.manifest, allowedTools: ['*'] } };
    expect(await signer.verify(tampered, signature, keyId)).toBe(false);
    expect(await signer.verify(content, Buffer.from('nope').toString('base64'), keyId)).toBe(false);
    expect(await signer.verify(content, signature, 'other-key')).toBe(false);

    // 다른 키(다른 플랫폼)로는 확인되지 않는다
    const other = new MarketplaceSigner(config('test'), memoryStore().store);
    expect(await other.verify(content, signature, keyId)).toBe(false);
  });

  it('production 에서는 키를 만들지 않는다', async () => {
    const signer = new MarketplaceSigner(config('production'), memoryStore().store);
    await expect(signer.sign(content)).rejects.toThrow('마켓플레이스 서명 키가 없습니다');
  });
});
