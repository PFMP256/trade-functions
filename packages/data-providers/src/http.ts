/** Read-only transport. Exchange writes must never use this retrying client. */
export class ProviderError extends Error {
  constructor(readonly code: string, readonly retryable = false) {
    super(code);
    this.name = 'ProviderError';
  }
}

export interface PublicHttpOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
  maxRetries?: number;
  retryDelayMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
}

export class PublicJsonHttpClient {
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private readonly sleep: (milliseconds: number) => Promise<void>;

  constructor(options: PublicHttpOptions = {}) {
    this.fetcher = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 4_000;
    this.maxRetries = options.maxRetries ?? 1;
    this.retryDelayMs = options.retryDelayMs ?? 200;
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    if (!Number.isInteger(this.maxRetries) || this.maxRetries < 0 || this.maxRetries > 2 ||
        !Number.isFinite(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 15_000 ||
        !Number.isFinite(this.retryDelayMs) || this.retryDelayMs < 0 || this.retryDelayMs > 2_000) {
      throw new ProviderError('INVALID_PROVIDER_HTTP_CONFIGURATION');
    }
  }

  async get(url: string): Promise<unknown> {
    const target = new URL(url);
    if (target.protocol !== 'https:' || target.username || target.password) {
      throw new ProviderError('INVALID_PROVIDER_URL');
    }
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        // Race also bounds a custom fetch implementation that ignores AbortSignal.
        const operation = (async (): Promise<unknown> => {
          const response = await this.fetcher(target, { method: 'GET', signal: controller.signal,
            redirect: 'error', headers: { accept: 'application/json' } });
          if (!response.ok) {
            throw new ProviderError(`PROVIDER_HTTP_${response.status}`, response.status === 429 || response.status >= 500);
          }
          const raw = await response.text();
          if (raw.length > 1_000_000) throw new ProviderError('PROVIDER_RESPONSE_TOO_LARGE');
          try { return JSON.parse(raw) as unknown; }
          catch { throw new ProviderError('PROVIDER_INVALID_JSON'); }
        })();
        const deadline = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new ProviderError('PROVIDER_TIMEOUT', true));
          }, this.timeoutMs);
        });
        return await Promise.race([operation, deadline]);
      } catch (error) {
        const safe = error instanceof ProviderError ? error : new ProviderError('PROVIDER_NETWORK_ERROR', true);
        if (!safe.retryable || attempt === this.maxRetries) throw safe;
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        controller.abort();
      }
      await this.sleep(this.retryDelayMs * (attempt + 1));
    }
    throw new ProviderError('PROVIDER_UNAVAILABLE');
  }
}
