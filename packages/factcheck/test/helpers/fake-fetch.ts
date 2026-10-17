export interface RecordedCall {
  readonly url: string;
  readonly headers: Headers;
  readonly body: unknown;
}

export type Handler = (call: RecordedCall) => Response | Promise<Response>;

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

/** A `fetch` stand-in that routes by URL prefix and records every call. */
export function fakeFetch(routes: Record<string, Handler>) {
  const calls: RecordedCall[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input instanceof Request ? input.url : input);
    init?.signal?.throwIfAborted();
    const rawBody = typeof init?.body === "string" ? init.body : undefined;
    const call: RecordedCall = {
      url,
      headers: new Headers(init?.headers),
      body: rawBody === undefined ? undefined : JSON.parse(rawBody),
    };
    calls.push(call);
    const match = Object.keys(routes).find((prefix) => url.startsWith(prefix));
    if (!match) throw new TypeError(`fakeFetch: no route for ${url}`);
    return routes[match]!(call);
  };
  return { fetch, calls };
}
