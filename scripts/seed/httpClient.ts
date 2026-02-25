type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

type JsonRecord = Record<string, unknown>;

export type SeedHttpClientOptions = {
  baseUrl: string;
  fetchImpl?: FetchLike;
};

type RequestOptions = {
  body?: unknown;
  headers?: Record<string, string>;
  allowStatuses?: number[];
  auth?: boolean;
};

export type SeedHttpResponse<T = unknown> = {
  status: number;
  headers: Headers;
  data: T;
};

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, '');
}

function isJsonResponse(headers: Headers): boolean {
  const contentType = headers.get('content-type') ?? '';
  return contentType.toLowerCase().includes('application/json');
}

function toErrorBody(data: unknown): string {
  if (typeof data === 'string') {
    return data.slice(0, 600);
  }
  try {
    return JSON.stringify(data).slice(0, 600);
  } catch {
    return String(data).slice(0, 600);
  }
}

function parseSetCookieHeader(raw: string | null): string | null {
  if (!raw) return null;
  const firstSegment = raw.split(',')[0] ?? '';
  const cookiePair = firstSegment.split(';')[0]?.trim();
  return cookiePair || null;
}

export class SeedHttpClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private accessToken: string | null = null;
  private cookieHeader: string | null = null;

  constructor(options: SeedHttpClientOptions) {
    if (!options.baseUrl) {
      throw new Error('SEED_HTTP_BASE_URL_REQUIRED');
    }
    if (typeof globalThis.fetch !== 'function' && !options.fetchImpl) {
      throw new Error('SEED_HTTP_FETCH_UNAVAILABLE');
    }
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.fetchImpl = options.fetchImpl ?? (globalThis.fetch.bind(globalThis) as FetchLike);
  }

  async login(email: string, password: string, tenantSlug: string): Promise<void> {
    const response = await this.request<JsonRecord>('POST', '/auth/login', {
      auth: false,
      body: {
        email,
        password,
        tenantSlug
      },
      allowStatuses: [200]
    });

    const token = typeof response.data?.accessToken === 'string' ? response.data.accessToken : null;
    if (!token) {
      throw new Error('SEED_HTTP_LOGIN_TOKEN_MISSING');
    }
    this.accessToken = token;

    const cookie = parseSetCookieHeader(response.headers.get('set-cookie'));
    if (cookie) {
      this.cookieHeader = cookie;
    }
  }

  async get<T = unknown>(path: string, options: Omit<RequestOptions, 'body'> = {}): Promise<SeedHttpResponse<T>> {
    return this.request<T>('GET', path, options);
  }

  async post<T = unknown>(path: string, options: RequestOptions = {}): Promise<SeedHttpResponse<T>> {
    return this.request<T>('POST', path, options);
  }

  async put<T = unknown>(path: string, options: RequestOptions = {}): Promise<SeedHttpResponse<T>> {
    return this.request<T>('PUT', path, options);
  }

  private async request<T>(method: string, path: string, options: RequestOptions = {}): Promise<SeedHttpResponse<T>> {
    const url = new URL(path, `${this.baseUrl}/`).toString();
    const headers = new Headers();
    headers.set('Accept', 'application/json');

    if (options.body !== undefined) {
      headers.set('Content-Type', 'application/json');
    }
    for (const [key, value] of Object.entries(options.headers ?? {})) {
      headers.set(key, value);
    }

    const useAuth = options.auth !== false;
    if (useAuth) {
      if (!this.accessToken) {
        throw new Error(`SEED_HTTP_AUTH_REQUIRED method=${method} path=${path}`);
      }
      headers.set('Authorization', `Bearer ${this.accessToken}`);
      if (this.cookieHeader) {
        headers.set('Cookie', this.cookieHeader);
      }
    }

    const response = await this.fetchImpl(url, {
      method,
      headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined
    });

    const data = isJsonResponse(response.headers)
      ? await response.json().catch(() => ({}))
      : await response.text().catch(() => '');

    const allowStatuses = options.allowStatuses ?? [200, 201];
    if (!allowStatuses.includes(response.status)) {
      const message = `SEED_HTTP_REQUEST_FAILED method=${method} path=${path} status=${response.status} body=${toErrorBody(data)}`;
      throw new Error(message);
    }

    return {
      status: response.status,
      headers: response.headers,
      data: data as T
    };
  }
}
