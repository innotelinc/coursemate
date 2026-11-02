import { warn } from './util.js';

/**
 * The shop, reached from the server rather than from the buyer's browser.
 *
 * Magnate owns the price, the Stripe session and the key that the webhook mints;
 * this only asks it to start a checkout. Doing it here rather than with a
 * cross-origin POST from the page buys three things that matter:
 *
 *   * no preflight, so a browser policy cannot make the only purchase path fail
 *     in a way that looks like a broken site;
 *   * no dependency on the shop deploying a CORS allowlist before keys can be
 *     bought from this page;
 *   * the request the shop receives is the one this server composed, so a buyer
 *     cannot rewrite the plan slug into another service's price.
 */
export function makeShop(cfg, fetchImpl) {
  const call = fetchImpl || fetch;

  /** Returns the Stripe URL to send the buyer to. Throws with a usable reason. */
  async function buy({ planSlug, email, keys }) {
    let res;
    try {
      res = await call(`${cfg.shopApiUrl}/api/coursemate/checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ planSlug, email, keys }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (e) {
      warn('shop', 'checkout unreachable', e.message);
      throw Object.assign(new Error('The shop could not be reached. Try again in a moment.'), {
        status: 502,
      });
    }

    let body = {};
    try {
      body = await res.json();
    } catch {
      // A shop that answers with HTML is a shop behind an error page; the status
      // below already says so, and there is nothing useful in the body.
    }

    if (!res.ok || !body.url) {
      // 4xx means the shop refused this request and its message is the buyer's
      // to act on; anything else is ours to apologise for.
      throw Object.assign(
        new Error(body.error || `The shop answered ${res.status}.`),
        { status: res.status >= 400 && res.status < 500 ? res.status : 502 },
      );
    }

    return { url: body.url };
  }

  /**
   * The price list, fetched here so the page never has to read a cross-origin
   * response and so a price change is one catalog edit with no deploy.
   */
  async function plans() {
    const res = await call(`${cfg.shopApiUrl}/api/plans?service=coursemate`, {
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) throw Object.assign(new Error(`the shop answered ${res.status}`), { status: 502 });
    const body = await res.json();
    const list = Array.isArray(body) ? body : body.plans || [];
    return list.filter((p) => p && p.slug);
  }

  return { buy, plans };
}
