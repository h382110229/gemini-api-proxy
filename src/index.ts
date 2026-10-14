/**
 * Cloudflare Worker High-Performance Reverse Proxy for Google Gemini API
 *
 * Features:
 * - Upstream transparent proxy to https://generativelanguage.googleapis.com
 * - Full-fidelity SSE streaming (text/event-stream) with zero memory buffering
 * - Native ReadableStream pass-through with duplex: 'half'
 * - Complete CORS preflight and headers injection
 * - Optional Anti-abuse Shield (GATEWAY_TOKEN)
 * - 60s timeout for standard requests with streaming exemption
 * - Standardized desensitized 502/504 error responses
 */

export interface Env {
  /** Optional gateway access token to prevent abuse */
  GATEWAY_TOKEN?: string;
}

const UPSTREAM_ORIGIN = 'https://generativelanguage.googleapis.com';
const UPSTREAM_HOST = 'generativelanguage.googleapis.com';

/** Headers that should not be forwarded to upstream */
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/** Cloudflare and edge internal headers to remove */
const STRIP_HEADERS = new Set([
  'cf-connecting-ip',
  'cf-ipcountry',
  'cf-ray',
  'cf-visitor',
  'cf-worker',
  'cdn-loop',
  'x-real-ip',
  'x-forwarded-for',
  'x-forwarded-proto',
]);

/**
 * Injects standard CORS headers
 */
function injectCorsHeaders(headers: Headers, request: Request): void {
  const origin = request.headers.get('Origin') || '*';
  headers.set('Access-Control-Allow-Origin', origin);
  headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD');
  headers.set(
    'Access-Control-Allow-Headers',
    request.headers.get('Access-Control-Request-Headers') ||
      'Content-Type, Authorization, x-goog-api-key, x-goog-api-client, X-Gateway-Token'
  );
  headers.set('Access-Control-Expose-Headers', '*');
  headers.set('Access-Control-Allow-Credentials', 'true');
}

/**
 * Handles CORS Preflight OPTIONS requests
 */
function handleOptions(request: Request): Response {
  const headers = new Headers();
  injectCorsHeaders(headers, request);
  headers.set('Access-Control-Max-Age', '86400');
  return new Response(null, {
    status: 204,
    headers,
  });
}

/**
 * Standard JSON error response constructor
 */
function makeJsonError(
  status: number,
  codeStatus: string,
  message: string,
  request: Request
): Response {
  const headers = new Headers({
    'Content-Type': 'application/json; charset=utf-8',
  });
  injectCorsHeaders(headers, request);

  return new Response(
    JSON.stringify(
      {
        error: {
          code: status,
          message,
          status: codeStatus,
        },
      },
      null,
      2
    ),
    {
      status,
      headers,
    }
  );
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // 1. Handle CORS Preflight
    if (request.method === 'OPTIONS') {
      return handleOptions(request);
    }

    const url = new URL(request.url);

    // 2. Health Check Probe
    if (url.pathname === '/health' || url.pathname === '/healthz') {
      const headers = new Headers({ 'Content-Type': 'application/json; charset=utf-8' });
      injectCorsHeaders(headers, request);
      return new Response(
        JSON.stringify(
          {
            status: 'healthy',
            service: 'gemini-api-proxy',
            timestamp: new Date().toISOString(),
            upstream: UPSTREAM_ORIGIN,
            gateway_shield: Boolean(env.GATEWAY_TOKEN),
          },
          null,
          2
        ),
        { status: 200, headers }
      );
    }

    // 3. Welcome / Service Info on root endpoint
    if (url.pathname === '/' || url.pathname === '') {
      const headers = new Headers({ 'Content-Type': 'application/json; charset=utf-8' });
      injectCorsHeaders(headers, request);
      return new Response(
        JSON.stringify(
          {
            service: 'gemini-api-proxy',
            status: 'running',
            description: 'Cloudflare Worker high-performance reverse proxy for Google Gemini API',
            endpoints: {
              health: '/health',
              v1beta: '/v1beta/*',
              v1: '/v1/*',
            },
            docs: 'https://ai.google.dev/api',
          },
          null,
          2
        ),
        { status: 200, headers }
      );
    }

    // 4. Gateway Token Shield Verification
    if (env.GATEWAY_TOKEN && env.GATEWAY_TOKEN.trim().length > 0) {
      const headerToken = request.headers.get('x-gateway-token');
      const queryToken = url.searchParams.get('gateway_token');
      const providedToken = headerToken || queryToken;

      if (!providedToken || providedToken !== env.GATEWAY_TOKEN) {
        return makeJsonError(
          403,
          'PERMISSION_DENIED',
          'Forbidden: Invalid or missing Gateway Token',
          request
        );
      }

      // Remove gateway_token from URL query before forwarding to upstream
      if (queryToken) {
        url.searchParams.delete('gateway_token');
      }
    }

    // 5. Upstream URL & Streaming Detection
    const targetUrl = new URL(url.pathname + url.search, UPSTREAM_ORIGIN);

    const isStreaming =
      url.pathname.includes(':streamGenerateContent') ||
      url.searchParams.get('alt') === 'sse' ||
      (request.headers.get('accept') || '').includes('text/event-stream');

    // 6. Upstream Headers Sanitization
    const upstreamHeaders = new Headers();
    for (const [key, value] of request.headers.entries()) {
      const lowerKey = key.toLowerCase();
      if (
        !HOP_BY_HOP_HEADERS.has(lowerKey) &&
        !STRIP_HEADERS.has(lowerKey) &&
        lowerKey !== 'host' &&
        lowerKey !== 'x-gateway-token'
      ) {
        upstreamHeaders.set(key, value);
      }
    }
    upstreamHeaders.set('Host', UPSTREAM_HOST);

    // 7. Request Timeout Controller (Exempt for Streaming Requests)
    const abortController = new AbortController();
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    if (!isStreaming) {
      timeoutId = setTimeout(() => {
        abortController.abort(new Error('REQUEST_TIMEOUT'));
      }, 60000);
    }

    try {
      const fetchOptions: RequestInit & { duplex?: string } = {
        method: request.method,
        headers: upstreamHeaders,
        body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
        redirect: 'follow',
        signal: abortController.signal,
      };

      // Ensure duplex: 'half' for streaming request bodies (Node/Workers Fetch standard)
      if (fetchOptions.body) {
        fetchOptions.duplex = 'half';
      }

      const upstreamResponse = await fetch(targetUrl.toString(), fetchOptions as RequestInit);

      if (timeoutId) {
        clearTimeout(timeoutId);
      }

      // 8. Prepare Downstream Response Headers
      const responseHeaders = new Headers(upstreamResponse.headers);

      // Strip unwanted upstream headers if any
      responseHeaders.delete('set-cookie');

      // Inject standard CORS headers
      injectCorsHeaders(responseHeaders, request);

      // 9. SSE Streaming Headers Guarantee
      const contentType = responseHeaders.get('content-type') || '';
      const isSseResponse = isStreaming || contentType.includes('text/event-stream');

      if (isSseResponse) {
        responseHeaders.set('Content-Type', 'text/event-stream; charset=utf-8');
        responseHeaders.set('Cache-Control', 'no-cache, no-transform');
        responseHeaders.set('Connection', 'keep-alive');
        responseHeaders.set('X-Accel-Buffering', 'no');
      }

      // 10. Direct Stream Pass-Through without buffering
      return new Response(upstreamResponse.body, {
        status: upstreamResponse.status,
        statusText: upstreamResponse.statusText,
        headers: responseHeaders,
      });
    } catch (err: unknown) {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }

      const errorMsg = err instanceof Error ? err.message : String(err);
      const isTimeout =
        errorMsg.includes('REQUEST_TIMEOUT') ||
        (err instanceof DOMException && err.name === 'TimeoutError') ||
        (err instanceof DOMException && err.name === 'AbortError');

      const status = isTimeout ? 504 : 502;
      const statusText = isTimeout ? 'DEADLINE_EXCEEDED' : 'UNAVAILABLE';
      const clientMessage = isTimeout
        ? 'Gateway Timeout: Upstream Google Gemini API took longer than 60s to respond'
        : 'Bad Gateway: Failed to connect to Google Gemini upstream service';

      return makeJsonError(status, statusText, clientMessage, request);
    }
  },
};
