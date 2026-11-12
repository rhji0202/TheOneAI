/**
 * Secret 조회 추상화. DB 에는 vault://… 참조만 저장하고 값은 여기서 가져온다.
 * 운영 구현(Vault · 클라우드 Secret Manager)은 같은 인터페이스로 추가한다.
 */
export abstract class SecretStore {
  /** 참조가 없으면 null */
  abstract get(ref: string): Promise<string | null>;
}

/** 개발 · 테스트 전용: DEV_SECRETS JSON 에서 조회한다. production 에서는 설정 단계에서 거부된다. */
export class LocalSecretStore extends SecretStore {
  constructor(private readonly secrets: Record<string, string>) {
    super();
  }

  async get(ref: string): Promise<string | null> {
    return this.secrets[ref] ?? null;
  }
}
