// Cloudflare Pages Function that proxies `/ingest/*` to PostHog's EU cloud, so analytics requests
// go to the site's own domain and are not dropped by ad blockers. Pages `_redirects` can't proxy to
// another host, hence a function. Based on https://posthog.com/docs/advanced/proxy/cloudflare.
const API_HOST = "eu.i.posthog.com";
const ASSET_HOST = "eu-assets.i.posthog.com";
const PREFIX = "/ingest";

export async function onRequest({ request }: { request: Request }): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.slice(PREFIX.length) || "/";
  const isAsset = path.startsWith("/static/") || path.startsWith("/array/");
  const target = `https://${isAsset ? ASSET_HOST : API_HOST}${path}${url.search}`;

  const headers = new Headers(request.headers);
  headers.delete("cookie");
  headers.delete("authorization");
  // PostHog derives geolocation and the cookieless visitor hash from the client IP.
  const clientIp = request.headers.get("CF-Connecting-IP");
  if (clientIp) headers.set("X-Forwarded-For", clientIp);

  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  return fetch(target, {
    method: request.method,
    headers,
    body: hasBody ? await request.arrayBuffer() : null,
    redirect: request.redirect,
  });
}
