import assert from "node:assert/strict";

import { rankProducts } from "../dist/ranking.js";

const products = [
  {
    id: "milk-1l",
    label: "Lait demi-écrémé 1 L",
    price: 1.25,
    pricePerUnit: "1,25 €/L",
    pricePerUnitValue: 1.25,
    available: true,
  },
  {
    id: "milk-6l",
    label: "Lait demi-écrémé pack 6 x 1 L",
    price: 6.6,
    pricePerUnit: "1,10 €/L",
    pricePerUnitValue: 1.1,
    available: true,
  },
  {
    id: "milk-premium",
    label: "Lait demi-écrémé premium 1 L",
    price: 2.4,
    pricePerUnit: "2,40 €/L",
    pricePerUnitValue: 2.4,
    available: true,
  },
  {
    id: "oat",
    label: "Boisson avoine 1 L",
    price: 0.95,
    pricePerUnit: "0,95 €/L",
    pricePerUnitValue: 0.95,
    available: true,
  },
];

const forTwoLitres = rankProducts(products, {
  query: "lait demi-écrémé",
  neededAmount: 2,
  neededUnit: "l",
  strategy: "balanced",
});

assert.equal(
  forTwoLitres[0]?.product.id,
  "milk-1l",
  "balanced ranking should avoid buying a 6 L pack when only 2 L are needed",
);
assert.equal(forTwoLitres[0]?.packages, 2);

const bestUnitPrice = rankProducts(products, {
  query: "lait demi-écrémé",
  strategy: "unit_price",
});

assert.equal(
  bestUnitPrice[0]?.product.id,
  "milk-6l",
  "unit_price strategy should prefer the genuinely cheaper price per litre",
);

assert.ok(
  !forTwoLitres.some((entry) => entry.product.id === "oat"),
  "low-relevance products must not win only because they are cheap",
);

console.log("ranking smoke tests: OK");
