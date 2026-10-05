#!/usr/bin/env node
/**
 * MCP server for E.Leclerc Drive.
 *
 * Exposes search / cart tools over stdio so Claude Desktop, Claude Code, or any
 * MCP client can drive grocery ordering natively instead of via browser
 * automation.
 *
 * The tool *contracts* are final; the underlying client (src/leclerc/client.ts)
 * still needs its endpoints wired up from a network capture — until then tools
 * return a clear "not reverse-engineered yet" error.
 */

import { readFileSync } from "node:fs";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { ChromeSession } from "./browser.js";
import { loadConfig } from "./config.js";
import { LeclercClient } from "./leclerc/client.js";
import { FoundStore, StoreLocator } from "./leclerc/locator.js";
import { StoreState } from "./store.js";
import { rankProducts } from "./ranking.js";
import { Cart, Product } from "./types.js";

// Single source of truth for the version: read it from package.json (one dir up
// from dist/index.js) so serverInfo never drifts from the published package.
const pkg = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { version: string };

const config = loadConfig();
const browser = new ChromeSession({
  chromePath: config.chromePath,
  profileDir: config.chromeProfileDir,
  port: config.chromePort,
  headless: config.headless,
});
const store = new StoreState(config);
const client = new LeclercClient(config, browser, store);
const locator = new StoreLocator(config, browser);

// Cache of the last find_stores results, so set_store can resolve the host
// (and noPR) from just a store id the user picked.
const lastFound = new Map<string, FoundStore>();

const server = new McpServer({
  name: "mcp-leclerc-drive",
  version: pkg.version,
});

function formatProduct(p: Product): string {
  const bits = [
    p.label,
    p.brand ? `(${p.brand})` : null,
    `— ${p.price.toFixed(2)} €`,
    p.promoPrice && p.regularPrice
      ? `(promo, au lieu de ${p.regularPrice.toFixed(2)} €)`
      : null,
    p.pricePerUnit ? `[${p.pricePerUnit}]` : null,
    p.nutriScore ? `Nutri-Score ${p.nutriScore}` : null,
    p.available ? null : "⚠️ indisponible",
    `id=${p.id}`,
  ].filter(Boolean);
  return bits.join(" ");
}

function formatCart(cart: Cart): string {
  if (cart.items.length === 0) return "Panier vide.";
  const lines = cart.items.map(
    (it) =>
      `• ${it.quantity}× ${it.product.label} — ${it.lineTotal.toFixed(2)} € ` +
      `(id=${it.product.id})`,
  );
  return (
    `Panier (magasin ${cart.storeId}) — ${cart.itemCount} article(s) :\n` +
    lines.join("\n") +
    `\n\nTotal : ${cart.total.toFixed(2)} €`
  );
}

/** Wrap a tool body so thrown errors become structured MCP error content. */
function asText(text: string) {
  return { content: [{ type: "text" as const, text }] };
}
function asError(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text" as const, text: `Erreur : ${message}` }], isError: true };
}

server.tool(
  "search_product",
  "Recherche des produits dans le catalogue Leclerc Drive du magasin configuré. " +
    "Retourne label, prix, prix au kilo/litre, Nutri-Score, disponibilité et l'id " +
    "à utiliser pour add_to_cart.",
  { query: z.string().describe("Termes de recherche, ex. 'lait demi-écrémé bio'") },
  async ({ query }) => {
    try {
      const products = await client.searchProducts(query);
      if (products.length === 0) return asText(`Aucun produit trouvé pour « ${query} ».`);
      return asText(products.map(formatProduct).join("\n"));
    } catch (err) {
      return asError(err);
    }
  },
);

server.tool(
  "search_best_product",
  "Recherche plusieurs références puis les classe au lieu de prendre le premier résultat. " +
    "Compare la pertinence, le prix total, le prix au kg/L, les promotions, le format " +
    "et éventuellement une quantité cible et des marques préférées. Retourne le meilleur " +
    "choix et des alternatives ; utiliser ensuite add_to_cart avec l'id retenu.",
  {
    query: z.string().describe("Produit recherché, ex. 'jambon blanc sans couenne'"),
    needed_amount: z
      .number()
      .positive()
      .optional()
      .describe("Quantité totale souhaitée, à associer à needed_unit"),
    needed_unit: z
      .enum(["g", "kg", "ml", "l", "unit"])
      .optional()
      .describe("Unité de la quantité souhaitée"),
    strategy: z
      .enum(["balanced", "cheapest", "unit_price"])
      .default("balanced")
      .describe(
        "balanced = meilleur compromis coût/format ; cheapest = ticket minimum ; " +
          "unit_price = priorité au prix au kg/L",
      ),
    preferred_brands: z
      .array(z.string())
      .optional()
      .describe("Marques à favoriser légèrement, sans ignorer un gros écart de prix"),
    limit: z.number().int().min(1).max(10).default(5).describe("Nombre d'options classées"),
  },
  async ({
    query,
    needed_amount,
    needed_unit,
    strategy,
    preferred_brands,
    limit,
  }) => {
    try {
      if ((needed_amount === undefined) !== (needed_unit === undefined)) {
        return asError(
          new Error("needed_amount et needed_unit doivent être fournis ensemble."),
        );
      }

      const products = await client.searchProducts(query);
      const ranked = rankProducts(products, {
        query,
        strategy,
        neededAmount: needed_amount,
        neededUnit: needed_unit,
        preferredBrands: preferred_brands,
        limit,
      });

      if (ranked.length === 0) {
        return asText(`Aucun produit disponible et suffisamment pertinent pour « ${query} ».`);
      }

      const lines = ranked.map((entry, index) => {
        const prefix = index === 0 ? "★ MEILLEUR CHOIX" : `${index + 1}.`;
        const estimate =
          entry.packages && entry.estimatedTotalCost !== undefined
            ? ` | ${entry.packages} paquet(s), coût estimé ${entry.estimatedTotalCost.toFixed(2)} €`
            : "";
        const why = entry.reasons.length > 0 ? ` | ${entry.reasons.join(", ")}` : "";
        return `${prefix} ${formatProduct(entry.product)}${estimate}${why}`;
      });

      return asText(
        `Sélection intelligente pour « ${query} » (stratégie: ${strategy}) :\n` +
          lines.join("\n") +
          `\n\nLe premier résultat est le choix recommandé, pas nécessairement le premier résultat Leclerc.`,
      );
    } catch (err) {
      return asError(err);
    }
  },
);

server.tool(
  "add_to_cart",
  "Ajoute un produit au panier. Utilise l'id retourné par search_product.",
  {
    product_id: z.string().describe("Identifiant produit (champ id de search_product)"),
    quantity: z.number().int().positive().default(1).describe("Quantité à ajouter"),
  },
  async ({ product_id, quantity }) => {
    try {
      const cart = await client.addToCart(product_id, quantity);
      return asText(`Ajouté.\n\n${formatCart(cart)}`);
    } catch (err) {
      return asError(err);
    }
  },
);

server.tool(
  "remove_from_cart",
  "Retire complètement un produit du panier.",
  { product_id: z.string().describe("Identifiant produit à retirer") },
  async ({ product_id }) => {
    try {
      const cart = await client.removeFromCart(product_id);
      return asText(`Retiré.\n\n${formatCart(cart)}`);
    } catch (err) {
      return asError(err);
    }
  },
);

server.tool(
  "update_quantity",
  "Modifie la quantité d'un produit déjà présent dans le panier.",
  {
    product_id: z.string().describe("Identifiant produit"),
    quantity: z.number().int().nonnegative().describe("Nouvelle quantité (0 pour retirer)"),
  },
  async ({ product_id, quantity }) => {
    try {
      const cart = await client.updateQuantity(product_id, quantity);
      return asText(`Quantité mise à jour.\n\n${formatCart(cart)}`);
    } catch (err) {
      return asError(err);
    }
  },
);

server.tool(
  "get_cart",
  "Affiche le contenu complet du panier avec le total.",
  {},
  async () => {
    try {
      const cart = await client.getCart();
      return asText(formatCart(cart));
    } catch (err) {
      return asError(err);
    }
  },
);

server.tool(
  "find_stores",
  "Recherche les drives E.Leclerc proches d'un code postal ou d'une ville, triés " +
    "par distance. Retourne pour chacun : nom, identifiant (à passer à set_store), " +
    "type de service (drive/relais/livraison), distance et magasin.",
  { query: z.string().describe("Code postal ou ville, ex. '44000' ou 'Nantes'") },
  async ({ query }) => {
    try {
      const stores = await locator.findStores(query);
      if (stores.length === 0) return asText(`Aucun drive trouvé pour « ${query} ».`);
      lastFound.clear();
      for (const s of stores) lastFound.set(s.storeId, s);
      const lines = stores.map((s) => {
        const dist = s.distanceKm !== undefined ? `${s.distanceKm.toFixed(1)} km` : "";
        return `• ${s.name} — ${s.serviceType} ${dist} (id=${s.storeId})`;
      });
      return asText(
        `Drives autour de « ${query} » :\n${lines.join("\n")}\n\n` +
          `Pour en choisir un : set_store avec son id. Les courses fonctionnent sur les « drive ».`,
      );
    } catch (err) {
      return asError(err);
    }
  },
);

server.tool(
  "set_store",
  "Sélectionne le magasin actif (et le mémorise pour les prochaines sessions). " +
    "Utilise l'id renvoyé par find_stores.",
  {
    store_id: z.string().describe("Identifiant magasin (champ id de find_stores)"),
    host: z
      .string()
      .optional()
      .describe("Host backend (optionnel) si le magasin n'a pas été trouvé via find_stores"),
  },
  async ({ store_id, host }) => {
    try {
      const found = lastFound.get(store_id);
      if (!found && !host) {
        return asError(
          new Error(
            `Magasin ${store_id} inconnu. Lance d'abord find_stores, puis set_store avec un id ` +
              `de la liste (ou fournis le paramètre host).`,
          ),
        );
      }
      const selection = found
        ? { storeId: found.storeId, noPR: found.noPR, host: found.host, name: found.name }
        : { storeId: store_id, noPR: store_id, host: host as string };
      store.set(selection);
      return asText(
        `Magasin actif : ${selection.name ?? selection.storeId} ` +
          `(id=${selection.storeId} @ ${selection.host}). Mémorisé.`,
      );
    } catch (err) {
      return asError(err);
    }
  },
);

server.tool(
  "get_store",
  "Affiche le magasin actuellement sélectionné (id, host).",
  {},
  async () => {
    const s = store.current();
    return asText(`Magasin actif : ${s.name ?? s.storeId} (id=${s.storeId} @ ${s.host}).`);
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  const s = store.current();
  // stderr only — stdout is the MCP channel.
  console.error(
    `mcp-leclerc-drive ready (store ${s.storeId} @ ${s.host}, ` +
      `auth: real Chrome via CDP${config.headless ? " [headless]" : ""})`,
  );
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
