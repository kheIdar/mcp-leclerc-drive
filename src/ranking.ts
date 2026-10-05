import { Product } from "./types.js";

export type RankingStrategy = "balanced" | "cheapest" | "unit_price";
export type NeedUnit = "g" | "kg" | "ml" | "l" | "unit";
type MeasureUnit = NeedUnit | "cl";

export interface ProductRankingOptions {
  query: string;
  strategy?: RankingStrategy;
  neededAmount?: number;
  neededUnit?: NeedUnit;
  preferredBrands?: string[];
  limit?: number;
}

export interface RankedProduct {
  product: Product;
  score: number;
  relevance: number;
  packages?: number;
  estimatedTotalCost?: number;
  overbuyRatio?: number;
  reasons: string[];
}

interface PackageMeasure {
  kind: "mass" | "volume" | "unit";
  amount: number;
}

const STOP_WORDS = new Set([
  "de",
  "du",
  "des",
  "le",
  "la",
  "les",
  "un",
  "une",
  "et",
  "au",
  "aux",
  "pour",
  "avec",
]);

function normalizeText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9%]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokens(value: string): string[] {
  return normalizeText(value)
    .split(" ")
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token));
}

function relevanceScore(query: string, product: Product): number {
  const queryTokens = tokens(query);
  if (queryTokens.length === 0) return 1;

  const haystack = normalizeText([product.label, product.brand].filter(Boolean).join(" "));
  const matched = queryTokens.filter((token) => haystack.includes(token)).length;
  let score = matched / queryTokens.length;

  const normalizedQuery = normalizeText(query);
  if (normalizedQuery && haystack.includes(normalizedQuery)) score += 0.2;

  return Math.min(1, score);
}

function parseNumber(raw: string): number {
  return Number(raw.replace(",", "."));
}

function packageMeasure(label: string): PackageMeasure | undefined {
  // Keep decimal separators for formats such as "1,5 L"; normalizeText() would
  // replace them with spaces and make quantity detection unreliable.
  const normalized = label
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

  const multi = normalized.match(
    /\b(\d+)\s*x\s*(\d+(?:[.,]\d+)?)\s*(kg|g|l|cl|ml)\b/i,
  );
  if (multi) {
    const count = Number(multi[1]);
    const value = parseNumber(multi[2]);
    const converted = convertMeasure(value, multi[3].toLowerCase() as MeasureUnit);
    if (converted) return { kind: converted.kind, amount: converted.amount * count };
  }

  const measures = [
    ...normalized.matchAll(/\b(\d+(?:[.,]\d+)?)\s*(kg|g|l|cl|ml)\b/gi),
  ];
  if (measures.length > 0) {
    const match = measures[measures.length - 1];
    return convertMeasure(parseNumber(match[1]), match[2].toLowerCase() as MeasureUnit);
  }

  const countMatch = normalized.match(
    /\b(\d+)\s*(?:pieces?|unites?|tranches?|sachets?|pots?|bouteilles?|canettes?)\b/i,
  );
  if (countMatch) {
    return { kind: "unit", amount: Number(countMatch[1]) };
  }

  return undefined;
}

function convertMeasure(value: number, unit: MeasureUnit): PackageMeasure | undefined {
  switch (unit) {
    case "kg":
      return { kind: "mass", amount: value * 1000 };
    case "g":
      return { kind: "mass", amount: value };
    case "l":
      return { kind: "volume", amount: value * 1000 };
    case "cl":
      return { kind: "volume", amount: value * 10 };
    case "ml":
      return { kind: "volume", amount: value };
    case "unit":
      return { kind: "unit", amount: value };
    default:
      return undefined;
  }
}

function parsePricePerUnit(product: Product): number | undefined {
  if (product.pricePerUnitValue && product.pricePerUnitValue > 0) {
    return product.pricePerUnitValue;
  }
  if (!product.pricePerUnit) return undefined;
  const match = product.pricePerUnit.match(/(\d+(?:[.,]\d+)?)/);
  if (!match) return undefined;
  const value = parseNumber(match[1]);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function percentileRanks(values: number[]): number[] {
  const indexed = values.map((value, index) => ({ value, index }));
  indexed.sort((a, b) => a.value - b.value);
  const out = Array<number>(values.length).fill(0);
  const denominator = Math.max(1, values.length - 1);
  indexed.forEach((entry, rank) => {
    out[entry.index] = rank / denominator;
  });
  return out;
}

function brandPreference(product: Product, preferredBrands: string[]): boolean {
  if (preferredBrands.length === 0) return false;
  const haystack = normalizeText([product.brand, product.label].filter(Boolean).join(" "));
  return preferredBrands.some((brand) => {
    const normalized = normalizeText(brand);
    return normalized.length > 0 && haystack.includes(normalized);
  });
}

export function rankProducts(
  products: Product[],
  options: ProductRankingOptions,
): RankedProduct[] {
  const strategy = options.strategy ?? "balanced";
  const limit = Math.max(1, Math.min(options.limit ?? 5, 10));
  const preferredBrands = options.preferredBrands ?? [];

  const available = products
    .filter((product) => product.available && product.price > 0)
    .map((product) => ({
      product,
      relevance: relevanceScore(options.query, product),
      package: packageMeasure(product.label),
      unitPrice: parsePricePerUnit(product),
    }));

  if (available.length === 0) return [];

  const bestRelevance = Math.max(...available.map((item) => item.relevance));
  const minimumRelevance = Math.max(0.45, bestRelevance - 0.25);
  const candidates = available.filter((item) => item.relevance >= minimumRelevance);
  if (candidates.length === 0) return [];

  const wanted =
    options.neededAmount && options.neededUnit
      ? convertMeasure(options.neededAmount, options.neededUnit)
      : undefined;

  const targetCosts = candidates.map((item) => {
    if (!wanted || !item.package || wanted.kind !== item.package.kind) return undefined;
    const packages = Math.max(1, Math.ceil(wanted.amount / item.package.amount));
    return {
      packages,
      totalCost: packages * item.product.price,
      overbuyRatio: Math.max(0, (packages * item.package.amount - wanted.amount) / wanted.amount),
    };
  });

  const hasTargetCosts = targetCosts.some(Boolean);

  if (hasTargetCosts) {
    const fallbackPenalty = Math.max(
      ...targetCosts.filter(Boolean).map((entry) => entry!.totalCost),
      ...candidates.map((item) => item.product.price),
    );

    const costValues = targetCosts.map(
      (entry) => entry?.totalCost ?? fallbackPenalty * 1.75,
    );
    const overbuyValues = targetCosts.map(
      (entry) => entry?.overbuyRatio ?? 2,
    );
    const costRanks = percentileRanks(costValues);
    const overbuyRanks = percentileRanks(overbuyValues);

    return candidates
      .map((item, index): RankedProduct => {
        const target = targetCosts[index];
        const preferred = brandPreference(item.product, preferredBrands);
        const relevancePenalty = 1 - item.relevance;
        const preferenceBonus = preferred ? 0.08 : 0;

        let score =
          costRanks[index] * 0.68 +
          overbuyRanks[index] * 0.17 +
          relevancePenalty * 0.15 -
          preferenceBonus;

        if (strategy === "cheapest") {
          score = costRanks[index] * 0.88 + relevancePenalty * 0.12 - preferenceBonus;
        }

        const reasons: string[] = [];
        if (target) {
          reasons.push(
            `${target.packages} paquet(s) ≈ ${target.totalCost.toFixed(2)} € pour la quantité demandée`,
          );
          if (target.overbuyRatio <= 0.15) reasons.push("peu de sur-achat");
        } else {
          reasons.push("format non détecté : pénalisé pour une quantité cible");
        }
        if (preferred) reasons.push("marque préférée");
        if (item.product.promoPrice) reasons.push("promotion prise en compte");

        return {
          product: item.product,
          score,
          relevance: item.relevance,
          packages: target?.packages,
          estimatedTotalCost: target?.totalCost,
          overbuyRatio: target?.overbuyRatio,
          reasons,
        };
      })
      .sort((a, b) => a.score - b.score)
      .slice(0, limit);
  }

  const priceRanks = percentileRanks(candidates.map((item) => item.product.price));
  const unitFallback = Math.max(
    ...candidates.map((item) => item.unitPrice ?? 0),
    ...candidates.map((item) => item.product.price),
  );
  const unitRanks = percentileRanks(
    candidates.map((item) => item.unitPrice ?? unitFallback * 1.25),
  );

  return candidates
    .map((item, index): RankedProduct => {
      const preferred = brandPreference(item.product, preferredBrands);
      const preferenceBonus = preferred ? 0.08 : 0;
      const relevancePenalty = 1 - item.relevance;

      let score =
        unitRanks[index] * 0.55 +
        priceRanks[index] * 0.3 +
        relevancePenalty * 0.15 -
        preferenceBonus;

      if (strategy === "cheapest") {
        score = priceRanks[index] * 0.85 + relevancePenalty * 0.15 - preferenceBonus;
      } else if (strategy === "unit_price") {
        score =
          unitRanks[index] * 0.82 +
          priceRanks[index] * 0.08 +
          relevancePenalty * 0.1 -
          preferenceBonus;
      }

      const reasons: string[] = [];
      if (item.unitPrice) reasons.push("prix au kg/L pris en compte");
      reasons.push("prix total pris en compte");
      if (preferred) reasons.push("marque préférée");
      if (item.product.promoPrice) reasons.push("promotion prise en compte");

      return {
        product: item.product,
        score,
        relevance: item.relevance,
        reasons,
      };
    })
    .sort((a, b) => a.score - b.score)
    .slice(0, limit);
}
