/**
 * Shared domain types for the Leclerc Drive MCP server.
 *
 * These are the shapes the MCP tools expose to the model. The raw shapes
 * returned by the Leclerc Drive backend are mapped into these in the client
 * layer (see src/leclerc/client.ts) once the API has been reverse-engineered.
 */

export interface Product {
  /** Stable product identifier used by add_to_cart / update_quantity. */
  id: string;
  /** Display label, e.g. "Lait demi-écrémé Bio 1L". */
  label: string;
  /** Brand, e.g. "Marque Repère". Optional — not always present. */
  brand?: string;
  /** Effective unit price in euros (promotion applied when available). */
  price: number;
  /** Regular shelf price before promotion, when different from price. */
  regularPrice?: number;
  /** Promotional unit price, when the catalogue exposes one. */
  promoPrice?: number;
  /** Price per kilo / litre when the site exposes it, e.g. "1,29 €/L". */
  pricePerUnit?: string;
  /** Numeric counterpart of pricePerUnit, used for deterministic ranking. */
  pricePerUnitValue?: number;
  /** Nutri-Score letter A–E, when available. */
  nutriScore?: string;
  /** Whether the item is currently orderable in the selected store. */
  available: boolean;
  /** Thumbnail image URL, when available. */
  imageUrl?: string;
}

export interface CartItem {
  product: Product;
  quantity: number;
  /** quantity * unit price, in euros. */
  lineTotal: number;
}

export interface Cart {
  items: CartItem[];
  /** Number of distinct lines in the cart. */
  itemCount: number;
  /** Sum of all line totals, in euros. */
  total: number;
  storeId: string;
}
