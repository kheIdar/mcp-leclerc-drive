/**
 * Leclerc Drive backend client.
 *
 * Endpoints reverse-engineered and validated live against store 053701 on
 * 2026-06-13 — see docs/api-capture.md for the full capture.
 *
 * Confidence levels:
 *  - Cart mutations (add / update / remove) hit a clean JSON endpoint and were
 *    replayed successfully end-to-end. High confidence.
 *  - search() and getCart() extract data embedded in the page as JS globals
 *    (`_objDataSourceGroupeTrieFiltre`, `objContenuPanier`). The field schema is
 *    validated; the exact extraction from live HTML is marked `// VALIDATE:` and
 *    should be sanity-checked on first real run with a session cookie.
 */

import { ChromeSession, PageResponse } from "../browser.js";
import { LeclercConfig, storePath } from "../config.js";
import { StoreState } from "../store.js";
import { Cart, CartItem, Product } from "../types.js";
import { delay, Throttler } from "./throttle.js";

/** HTTP statuses that indicate a DataDome challenge / rate-limit worth retrying. */
const RETRYABLE_STATUSES = new Set([403, 429]);

/**
 * Marker embedded in the chrome of every real Leclerc store page (the cart
 * summary). The two non-store responses we can get back with HTTP 200 — DataDome's
 * soft JS-challenge interstitial and the "session expirée" page — don't contain it.
 * Note: the `x-datadome: protected` header and the `js.datadome.co` bootstrap are
 * present on legitimate pages too, so they cannot be used to detect a block.
 */
const STORE_PAGE_MARKER = "lstProduitsLight";

/**
 * Guard against silently treating a block page as "no results". A real store page
 * always carries STORE_PAGE_MARKER; if it's missing, the response is a DataDome
 * interstitial or an expired session — surface that with an actionable message
 * instead of returning an empty list.
 */
function assertStorePage(html: string): void {
  if (html.includes(STORE_PAGE_MARKER)) return;
  const expired = /session a expir|sessionexpiree/i.test(html);
  throw new Error(
    expired
      ? "Session Leclerc Drive expirée. Ouvre Leclerc Drive dans Chrome et reconnecte-toi, puis réessaie."
      : "Bloqué par Leclerc Drive (challenge DataDome). Ouvre Leclerc Drive dans Chrome et " +
        "recharge le magasin une fois pour rafraîchir la session, puis réessaie.",
  );
}

/** Cart mutation discriminator (see capture doc §2). */
const ACTION_ADD = 1; // add / increase to target qty
const ACTION_SUB = 2; // decrease / remove (qty 0)

interface RawProduct {
  iIdProduit: number | string;
  sLibelleLigne1?: string;
  sLibelleLigne2?: string;
  nrPVUnitaireTTC?: number;
  sPrixUnitaire?: string;
  sPrixPromo?: string;
  nrPVParUniteDeMesureTTC?: number;
  sPrixParUniteDeMesure?: string;
  iQteDisponible?: number;
  iQuantitePanier?: number;
  iQtePanier?: number;
  rTotalAPayer?: number;
  sTotalAPayer?: string;
  sUrlVignetteProduit?: string;
  sType?: string;
}

/** Query token that returns no search results, so a fetched page carries only cart data. */
const NO_MATCH_QUERY = "zzzznomatchzzz";

export class LeclercClient {
  private readonly throttler: Throttler;

  constructor(
    private readonly config: LeclercConfig,
    private readonly browser: ChromeSession,
    private readonly store: StoreState,
  ) {
    this.throttler = new Throttler({
      minIntervalMs: config.minIntervalMs,
      jitterMs: config.jitterMs,
      maxRetries: config.maxRetries,
      backoffBaseMs: config.backoffBaseMs,
    });
  }

  /** Store page the browser sits on; all search/cart fetches are same-origin to it. */
  private storeBase(): string {
    const s = this.store.current();
    return `${this.origin()}/${storePath(s.storeId, s.noPR)}/recherche.aspx?TexteRecherche=`;
  }

  /**
   * Single choke point for every HTTP call: serialized + spaced out by the
   * throttler, and retried with backoff. The request runs inside the real Chrome
   * (via ChromeSession), so it carries the browser's cookies + fingerprint and
   * passes DataDome. Do NOT set Cookie/User-Agent — the browser provides them.
   */
  private send(
    method: "GET" | "POST",
    url: string,
    extraHeaders: Record<string, string>,
    body?: string,
  ): Promise<PageResponse> {
    return this.throttler.run(async () => {
      let lastStatus = 0;
      for (let attempt = 0; attempt <= this.throttler.maxRetries; attempt++) {
        if (attempt > 0) await delay(this.throttler.backoff(attempt));
        const res = await this.browser.fetch(this.storeBase(), url, {
          method,
          headers: extraHeaders,
          body,
        });
        if (!RETRYABLE_STATUSES.has(res.status)) return res;
        lastStatus = res.status;
      }
      throw new Error(
        `Bloqué par Leclerc Drive (HTTP ${lastStatus}) après ` +
          `${this.throttler.maxRetries + 1} tentatives. Vérifie que tu es connecté à ` +
          `Leclerc Drive dans la fenêtre Chrome ouverte par le serveur, puis réessaie.`,
      );
    });
  }

  private origin(): string {
    return `https://${this.store.current().host}`;
  }

  /** API path (no cosmetic slug). */
  private cartUrl(): string {
    const s = this.store.current();
    return `${this.origin()}/${storePath(s.storeId, s.noPR)}/panier.aspx?op=1`;
  }

  private searchUrl(query: string): string {
    const s = this.store.current();
    return `${this.origin()}/${storePath(
      s.storeId,
      s.noPR,
    )}/recherche.aspx?TexteRecherche=${encodeURIComponent(query)}`;
  }

  // ---- Search ------------------------------------------------------------

  async searchProducts(query: string): Promise<Product[]> {
    const res = await this.send("GET", this.searchUrl(query), { Accept: "text/html" });
    if (!res.ok) throw new Error(`Search HTTP ${res.status} (${res.statusText})`);
    const html = await res.text();
    assertStorePage(html);

    // The search page embeds product data inside `initOptions(...)` widget
    // calls as `{objContenu:{lstElements:[{objElement:{...iIdProduit...}}]}}`.
    // Each `objElement` is pure JSON, so we scan the page for every product
    // record (smallest object enclosing an `iIdProduit`) and map it.
    const seen = new Set<string>();
    const products: Product[] = [];
    for (const rp of scanProductRecords(html)) {
      if (rp.sType && rp.sType !== "Produit") continue;
      const id = String(rp.iIdProduit);
      if (seen.has(id)) continue;
      seen.add(id);
      products.push(mapProduct(rp));
    }
    return products;
  }

  // ---- Cart mutations ----------------------------------------------------

  private async mutate(
    productId: string,
    quantity: number,
    action: number,
  ): Promise<Cart> {
    const payload = {
      eTypeAction: action,
      iIdProduit: String(productId),
      iQuantite: quantity,
      sNoPointLivraison: this.store.current().storeId,
    };
    const body = "d=" + encodeURIComponent(JSON.stringify(payload));
    const res = await this.send(
      "POST",
      this.cartUrl(),
      {
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "X-Requested-With": "XMLHttpRequest",
        Accept: "application/json, text/javascript, */*; q=0.01",
      },
      body,
    );
    if (!res.ok) throw new Error(`Cart HTTP ${res.status} (${res.statusText})`);
    const text = await res.text();
    let events: CartEvent[];
    try {
      events = JSON.parse(text);
    } catch (err) {
      throw new Error(
        `Unexpected cart response (not JSON): ${(err as Error).message}. ` +
          `First chars: ${text.slice(0, 120)}`,
      );
    }
    return this.cartFromEvents(events);
  }

  async addToCart(productId: string, quantity: number): Promise<Cart> {
    return this.mutate(productId, quantity, ACTION_ADD);
  }

  async removeFromCart(productId: string): Promise<Cart> {
    return this.mutate(productId, 0, ACTION_SUB);
  }

  async updateQuantity(productId: string, quantity: number): Promise<Cart> {
    if (quantity <= 0) return this.removeFromCart(productId);
    // Direction matters: action 1 increases, action 2 decreases. We read the
    // current quantity to choose, since iQuantite is an absolute target.
    const current = await this.currentQuantity(productId);
    const action = quantity >= current ? ACTION_ADD : ACTION_SUB;
    return this.mutate(productId, quantity, action);
  }

  private async currentQuantity(productId: string): Promise<number> {
    const cart = await this.getCart();
    const line = cart.items.find((i) => i.product.id === String(productId));
    return line?.quantity ?? 0;
  }

  // ---- Cart read ---------------------------------------------------------

  async getCart(): Promise<Cart> {
    // Every store page embeds the cart in the "Panier" context as a full
    // `lstProduits` array (product records with labels + per-line totals) plus a
    // `lstProduitsLight` summary and a `sTotalAPayer` grand total. We fetch a
    // no-match search page so the only product records present are the cart's,
    // then extract and map the `lstProduits` array.
    const res = await this.send("GET", this.searchUrl(NO_MATCH_QUERY), { Accept: "text/html" });
    if (!res.ok) throw new Error(`Cart read HTTP ${res.status} (${res.statusText})`);
    const html = await res.text();
    assertStorePage(html);

    const arr = extractArrayNamed(html, "lstProduits");
    const items: CartItem[] = [];
    if (arr) {
      const seen = new Set<string>();
      for (const rp of scanProductRecords(arr)) {
        const qty = num(rp.iQuantitePanier) ?? num(rp.iQtePanier) ?? 0;
        if (qty <= 0) continue;
        const id = String(rp.iIdProduit);
        if (seen.has(id)) continue;
        seen.add(id);
        const product = mapProduct(rp);
        const lineTotal =
          num(rp.rTotalAPayer) ?? parseEuro(rp.sTotalAPayer) ?? round2(product.price * qty);
        items.push({ product, quantity: qty, lineTotal });
      }
    }
    const grandTotal =
      parseEuro(extractCartTotal(html)) ?? round2(items.reduce((s, i) => s + i.lineTotal, 0));
    return {
      items,
      itemCount: items.reduce((s, i) => s + i.quantity, 0),
      total: round2(grandTotal),
      storeId: this.store.current().storeId,
    };
  }

  /** Build a Cart from a mutation event array (see capture doc §2). */
  private cartFromEvents(events: CartEvent[]): Cart {
    const items: CartItem[] = [];
    let total = 0;
    let itemCount = 0;
    for (const e of events) {
      const id = String(e.sIdUnique ?? "");
      const el = e.objElement ?? {};
      if (id.startsWith("Panier")) {
        total = num(el.rTotalAPayer) ?? parseEuro(el.sTotalAPayer) ?? total;
        itemCount = num(el.iQuantitePanier) ?? itemCount;
      } else if (id.startsWith("Produit") && el.sType === "Produit") {
        const qty = num(el.iQuantitePanier) ?? 0;
        if (qty > 0) {
          const product = mapProduct(el as RawProduct);
          const lineTotal =
            num(el.rTotalAPayer) ?? parseEuro(el.sTotalAPayer) ?? round2(product.price * qty);
          items.push({ product, quantity: qty, lineTotal });
        }
      }
    }
    return { items, itemCount, total: round2(total), storeId: this.store.current().storeId };
  }
}

// ---- Helpers -------------------------------------------------------------

interface CartEvent {
  eTypeEvenement?: number;
  sIdUnique?: string;
  objElement?: Record<string, unknown> & Partial<RawProduct>;
}

function mapProduct(rp: RawProduct): Product {
  const label = decodeEntities(
    [rp.sLibelleLigne1, rp.sLibelleLigne2].filter(Boolean).join(" ").trim(),
  );
  const regularPrice = num(rp.nrPVUnitaireTTC) ?? parseEuro(rp.sPrixUnitaire) ?? 0;
  const rawPromoPrice = parseEuro(rp.sPrixPromo);
  const promoPrice =
    rawPromoPrice !== undefined &&
    rawPromoPrice > 0 &&
    (regularPrice <= 0 || rawPromoPrice < regularPrice)
      ? rawPromoPrice
      : undefined;
  const price = promoPrice ?? regularPrice;

  const regularPricePerUnit =
    num(rp.nrPVParUniteDeMesureTTC) ?? parseEuro(rp.sPrixParUniteDeMesure);
  const pricePerUnitValue =
    regularPricePerUnit && promoPrice && regularPrice > 0
      ? round2(regularPricePerUnit * (promoPrice / regularPrice))
      : regularPricePerUnit;

  return {
    id: String(rp.iIdProduit),
    label: label || `Produit ${rp.iIdProduit}`,
    price,
    regularPrice: promoPrice ? regularPrice : undefined,
    promoPrice,
    pricePerUnit: rp.sPrixParUniteDeMesure || undefined,
    pricePerUnitValue,
    available: (num(rp.iQteDisponible) ?? 0) > 0,
    imageUrl: rp.sUrlVignetteProduit || undefined,
  };
}

/**
 * Extract the balanced array literal that follows a `"name":[` key in an
 * HTML/JS blob (exact key match, so `lstProduits` does not match
 * `lstProduitsLight`). Returns the `[...]` substring, or null.
 */
function extractArrayNamed(html: string, name: string): string | null {
  const marker = `"${name}":[`;
  const at = html.indexOf(marker);
  if (at < 0) return null;
  const start = at + marker.length - 1; // position of '['
  let depth = 0;
  let inStr: string | null = null;
  for (let j = start; j < html.length; j++) {
    const c = html[j];
    if (inStr) {
      if (c === "\\") j++;
      else if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'") inStr = c;
    else if (c === "[") depth++;
    else if (c === "]") {
      depth--;
      if (depth === 0) return html.slice(start, j + 1);
    }
  }
  return null;
}

/** Read the cart grand total string (e.g. "18,18 €") from the Panier context. */
function extractCartTotal(html: string): string | undefined {
  const anchor = html.indexOf("lstProduitsLight");
  const scope = anchor >= 0 ? html.slice(anchor, anchor + 1500) : html;
  const m = scope.match(/"sTotalAPayer":"([^"]+)"/);
  return m?.[1];
}

/**
 * Tolerant extraction of product records from a JS literal that may contain
 * non-JSON members (functions). Finds each `"iIdProduit"` occurrence and parses
 * the smallest enclosing `{...}` object, skipping any that fail to parse.
 */
function scanProductRecords(raw: string): RawProduct[] {
  const out: RawProduct[] = [];
  const re = /"iIdProduit"\s*:/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) {
    const obj = smallestEnclosingObject(raw, m.index);
    if (obj) {
      try {
        out.push(JSON.parse(obj) as RawProduct);
      } catch {
        /* skip records with function members etc. */
      }
    }
  }
  return out;
}

function smallestEnclosingObject(raw: string, at: number): string | null {
  // walk backwards to the opening brace of this object
  let start = -1;
  let depth = 0;
  for (let i = at; i >= 0; i--) {
    const c = raw[i];
    if (c === "}") depth++;
    else if (c === "{") {
      if (depth === 0) {
        start = i;
        break;
      }
      depth--;
    }
  }
  if (start < 0) return null;
  // forward to the matching close, respecting strings
  depth = 0;
  let inStr: string | null = null;
  for (let j = start; j < raw.length; j++) {
    const c = raw[j];
    if (inStr) {
      if (c === "\\") j++;
      else if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'") inStr = c;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return raw.slice(start, j + 1);
    }
  }
  return null;
}

function num(v: unknown): number | undefined {
  if (typeof v === "number") return v;
  if (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v))) return Number(v);
  return undefined;
}

/** Parse a French-formatted euro string like "11,88 €" → 11.88. */
function parseEuro(v: unknown): number | undefined {
  if (typeof v !== "string") return undefined;
  const cleaned = v.replace(/[^\d,.-]/g, "").replace(",", ".");
  const n = Number(cleaned);
  return Number.isNaN(n) ? undefined : n;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Decode the HTML entities that appear in product labels (numeric + a few named). */
function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ");
}
