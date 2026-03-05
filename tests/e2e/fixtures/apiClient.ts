import { APIRequestContext, request as playwrightRequest } from '@playwright/test';

type RequestOptions = {
  params?: Record<string, string | number | boolean | undefined>;
  headers?: Record<string, string>;
};

function withQuery(path: string, params?: RequestOptions['params']): string {
  if (!params) return path;
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    query.set(key, String(value));
  }
  const qs = query.toString();
  if (!qs) return path;
  const delimiter = path.includes('?') ? '&' : '?';
  return `${path}${delimiter}${qs}`;
}

async function safeJson(response: Awaited<ReturnType<APIRequestContext['fetch']>>): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return await response.text();
  }
}

export class E2EApiClient {
  private readonly context: APIRequestContext;
  private readonly runId: string;
  private idempotencyCounter = 0;

  constructor(context: APIRequestContext, runId: string) {
    this.context = context;
    this.runId = runId;
  }

  static async create(args: {
    apiBaseURL: string;
    accessToken: string;
    runId: string;
  }): Promise<E2EApiClient> {
    const context = await playwrightRequest.newContext({
      baseURL: args.apiBaseURL,
      extraHTTPHeaders: {
        Authorization: `Bearer ${args.accessToken}`,
        'Content-Type': 'application/json'
      }
    });
    return new E2EApiClient(context, args.runId);
  }

  async dispose(): Promise<void> {
    await this.context.dispose();
  }

  nextIdempotencyKey(scope: string): string {
    this.idempotencyCounter += 1;
    const raw = `e2e-${this.runId}-${scope}-${this.idempotencyCounter}`;
    return raw.slice(0, 255);
  }

  async get<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const response = await this.context.get(withQuery(path, options.params), {
      headers: options.headers
    });
    return await this.unwrap<T>(response, 'GET', path);
  }

  async post<T>(path: string, body?: unknown, options: RequestOptions = {}): Promise<T> {
    const response = await this.context.post(withQuery(path, options.params), {
      data: body,
      headers: options.headers
    });
    return await this.unwrap<T>(response, 'POST', path);
  }

  async put<T>(path: string, body?: unknown, options: RequestOptions = {}): Promise<T> {
    const response = await this.context.put(withQuery(path, options.params), {
      data: body,
      headers: options.headers
    });
    return await this.unwrap<T>(response, 'PUT', path);
  }

  async patch<T>(path: string, body?: unknown, options: RequestOptions = {}): Promise<T> {
    const response = await this.context.patch(withQuery(path, options.params), {
      data: body,
      headers: options.headers
    });
    return await this.unwrap<T>(response, 'PATCH', path);
  }

  async delete<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const response = await this.context.delete(withQuery(path, options.params), {
      headers: options.headers
    });
    return await this.unwrap<T>(response, 'DELETE', path);
  }

  private async unwrap<T>(
    response: Awaited<ReturnType<APIRequestContext['fetch']>>,
    method: string,
    path: string
  ): Promise<T> {
    if (!response.ok()) {
      const body = await safeJson(response);
      throw new Error(
        `${method} ${path} failed with ${response.status()}: ${JSON.stringify(body)}`
      );
    }
    return (await safeJson(response)) as T;
  }
}
