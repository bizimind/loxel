/**
 * Primes Cloudflare for an update's zips before electron-updater downloads one in ranges.
 *
 * Cloudflare answers the first range request its edge sees for a URL with `200` and the whole zip;
 * later range requests for it get `206`. electron-updater's differential download takes no notice
 * of the status: it counted the whole zip as download progress, many times the changed blocks it
 * expected, wrote it into the new zip, failed its checksum and started a full download over. A
 * one-byte range request, dropped as soon as its headers arrive, is that first request instead.
 */

/** How long a priming request may take: past it the download goes ahead unprimed. */
const PRIME_TIMEOUT_MS = 10_000;

/** The part of `fetch` priming uses; Electron's `net.fetch` in the app. */
export type PrimingFetch = (url: string, init: RequestInit) => Promise<Response>;

/** Fetch the first byte of each URL, dropping each response once its headers arrive. */
export async function primeRangeRequests(
  urls: readonly string[],
  fetchFn: PrimingFetch,
): Promise<void> {
  await Promise.all(urls.map((url) => primeRangeRequest(url, fetchFn)));
}

async function primeRangeRequest(url: string, fetchFn: PrimingFetch): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PRIME_TIMEOUT_MS);
  try {
    const response = await fetchFn(url, {
      headers: { range: "bytes=0-0" },
      signal: controller.signal,
    });
    console.log(`[updater] Primed ${url}: ${response.status}`);
    // Drops a 200's body, the whole zip, which is what a cold edge sends.
    await response.body?.cancel();
  } catch (err) {
    // Best effort: an unprimed download still works, it may just restart as a full download.
    console.warn(`[updater] Could not prime ${url}:`, err);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
