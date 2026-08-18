const API_BASE = '/api/v1';

export class ApiError extends Error {
  constructor(
    public status: number,
    public body: unknown,
  ) {
    super(`API error ${status}`);
  }
}

/**
 * Same-origin JSON fetch wrapper. `credentials: 'same-origin'` is actually
 * the fetch default for a same-origin request, but it's set explicitly here
 * to document that the session/challenge cookies are expected to travel
 * with every call — this SPA and the API it talks to are always the same
 * Worker, same origin, by design (see docs/plan.md's architecture section).
 */
export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(API_BASE + path, {
    ...init,
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...init.headers },
  });
  const body = await res.json().catch(() => undefined);
  if (!res.ok) throw new ApiError(res.status, body);
  return body as T;
}
