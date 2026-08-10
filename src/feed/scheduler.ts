import type { AppConfig } from "../config.js";
import type { AppLogger } from "../logger.js";
import type { FeedService } from "./service.js";

export class FeedScheduler {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private stopped = false;

  constructor(
    private readonly service: FeedService,
    private readonly config: Pick<AppConfig, "fetchConcurrency" | "schedulerTickSeconds">,
    private readonly logger: AppLogger,
  ) {}

  start(): void {
    if (this.timer !== undefined) return;
    this.stopped = false;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.config.schedulerTickSeconds * 1000);
    this.timer.unref();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  async tick(): Promise<void> {
    if (this.running || this.stopped) return;
    this.running = true;
    try {
      while (!this.stopped) {
        const ids = await this.service.claimDueFeedIds(this.config.fetchConcurrency);
        if (ids.length === 0) break;
        await Promise.all(ids.map(async (id) => {
          try {
            await this.service.refreshFeed(id);
          } catch (error) {
            this.logger.warn({ err: error, feedId: id }, "scheduled feed refresh failed");
          }
        }));
      }
    } catch (error) {
      this.logger.error({ err: error }, "feed scheduler tick failed");
    } finally {
      this.running = false;
    }
  }
}
