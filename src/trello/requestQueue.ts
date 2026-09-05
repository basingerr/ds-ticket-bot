/** Shared token budget for bot traffic. Only explicit 429 rejections are retried;
 * ambiguous network failures on writes must not create duplicate cards/comments. */
export class TrelloRequestQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private nextAt = 0;
  constructor(
    private readonly send: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise(resolve => setTimeout(resolve, ms)),
  ) {}

  request(url: string, init?: RequestInit): Promise<Response> {
    const run = this.tail.then(async () => {
      for (let attempt = 0; ; attempt++) {
        await this.sleep(Math.max(0, this.nextAt - this.now()));
        this.nextAt = this.now() + 250; // <= 40 requests/10s, leaving room for other tools
        const response = await this.send(url, { ...init, signal: init?.signal ?? AbortSignal.timeout(30_000) });
        if (response.status !== 429) return response;
        const retrySeconds = Number(response.headers.get("retry-after"));
        this.nextAt = this.now() + Math.max(10_000 * 2 ** attempt,
          Number.isFinite(retrySeconds) ? retrySeconds * 1000 : 0);
        if (attempt >= 2) return response;
        await response.arrayBuffer();
      }
    });
    this.tail = run.catch(() => undefined);
    return run;
  }
}
