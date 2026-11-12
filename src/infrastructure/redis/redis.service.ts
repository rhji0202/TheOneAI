import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { Redis } from 'ioredis';
import { APP_CONFIG, type AppConfig } from '../../config/app-config.js';
import { redisOptionsFromUrl } from './redis-options.js';

type Listener = (message: string) => void;

/**
 * Redis 명령용 연결 1개 + Pub/Sub 구독용 공유 연결 1개.
 * SSE 클라이언트마다 연결을 만들지 않고, 채널별 리스너를 프로세스 안에서 나눠 준다.
 */
@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  readonly client: Redis;
  private subscriber: Redis | null = null;
  private readonly listeners = new Map<string, Set<Listener>>();

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
    this.client = new Redis(redisOptionsFromUrl(config.redisUrl));
  }

  async publish(channel: string, message: string): Promise<void> {
    await this.client.publish(channel, message);
  }

  /** 채널을 구독하고, 구독 해제 함수를 돌려준다. */
  async subscribe(channel: string, listener: Listener): Promise<() => Promise<void>> {
    const sub = this.getSubscriber();
    let set = this.listeners.get(channel);
    if (!set) {
      set = new Set();
      this.listeners.set(channel, set);
      await sub.subscribe(channel);
    }
    set.add(listener);

    return async () => {
      const current = this.listeners.get(channel);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) {
        this.listeners.delete(channel);
        await sub.unsubscribe(channel).catch(() => undefined);
      }
    };
  }

  /** 진단 · 테스트용: 채널의 프로세스 내 리스너 수 */
  listenerCount(channel: string): number {
    return this.listeners.get(channel)?.size ?? 0;
  }

  async ping(): Promise<boolean> {
    return (await this.client.ping()) === 'PONG';
  }

  async onModuleDestroy(): Promise<void> {
    this.listeners.clear();
    await Promise.allSettled([this.client.quit(), this.subscriber?.quit()]);
  }

  private getSubscriber(): Redis {
    if (!this.subscriber) {
      this.subscriber = new Redis(redisOptionsFromUrl(this.config.redisUrl));
      this.subscriber.on('message', (channel: string, message: string) => {
        for (const listener of this.listeners.get(channel) ?? []) {
          try {
            listener(message);
          } catch (err) {
            this.logger.error(`구독 리스너 오류 (${channel}): ${String(err)}`);
          }
        }
      });
    }
    return this.subscriber;
  }
}
