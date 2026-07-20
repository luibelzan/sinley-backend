import { test } from "node:test";
import assert from "node:assert/strict";
import { compareHandEvaluations, evaluateHand, fourOfSameSuit } from "./handEvaluator";
import { Card } from "./types";
import { createDeck } from "./deck";

function card(suit: Card["suit"], rank: Card["rank"]): Card {
  return { suit, rank };
}

test("la baraja tiene 32 cartas: 7 rangos x 4 palos + una Tres duplicada por palo", () => {
  const deck = createDeck();
  assert.equal(deck.length, 32);

  const threesPerSuit = new Map<string, number>();
  for (const card of deck) {
    if (card.rank === 3) {
      threesPerSuit.set(card.suit, (threesPerSuit.get(card.suit) ?? 0) + 1);
    }
  }
  for (const suit of ["oros", "copas", "espadas", "bastos"] as const) {
    assert.equal(threesPerSuit.get(suit), 2, `${suit} debería tener dos Tres`);
  }

  // El resto de rangos (no Tres) no deberían repetirse dentro de un mismo palo.
  const nonThreeKeys = deck.filter((c) => c.rank !== 3).map((c) => `${c.suit}-${c.rank}`);
  assert.equal(new Set(nonThreeKeys).size, nonThreeKeys.length);
});

test("Sin Ley Real: cuatro ases (de cualquier palo) es la mejor mano posible", () => {
  const hand = [card("oros", 1), card("copas", 1), card("espadas", 1), card("bastos", 1)];
  const result = evaluateHand(hand);
  assert.equal(result.tier, "sin_ley_real");
});

test("Sin Ley: tres ases gana a cualquier puntuación por palo", () => {
  const hand = [card("oros", 1), card("copas", 1), card("espadas", 1), card("bastos", 13)];
  const threeAces = evaluateHand(hand);
  assert.equal(threeAces.tier, "sin_ley");

  const bestSuitScore = evaluateHand([card("oros", 1), card("oros", 13), card("oros", 11), card("oros", 12)]);
  assert.equal(bestSuitScore.tier, "suit_score");
  assert.equal(bestSuitScore.score, 41);

  assert.ok(compareHandEvaluations(threeAces, bestSuitScore) > 0);
});

test("41: As + tres cartas de valor 10 del mismo palo", () => {
  const hand = [card("oros", 1), card("oros", 13), card("oros", 11), card("oros", 12)];
  const result = evaluateHand(hand);
  assert.equal(result.score, 41);
  assert.equal(result.scoringSuit, "oros");
});

test("40: cuatro cartas de valor 10 del mismo palo (incluye el comodín)", () => {
  const hand = [card("oros", 13), card("oros", 11), card("oros", 12), card("copas", 5)];
  // El Cinco de copas es comodín: cuenta como oros también.
  const result = evaluateHand(hand);
  assert.equal(result.score, 40);
  assert.equal(result.scoringSuit, "oros");
});

test("38: As + dos cartas de valor 10 + siete, mismo palo", () => {
  const hand = [card("bastos", 1), card("bastos", 13), card("bastos", 11), card("bastos", 7)];
  const result = evaluateHand(hand);
  assert.equal(result.score, 38);
});

test("37: tres cartas de valor 10 + siete, mismo palo", () => {
  const hand = [card("espadas", 13), card("espadas", 11), card("espadas", 12), card("espadas", 7)];
  const result = evaluateHand(hand);
  assert.equal(result.score, 37);
});

test("31: As + dos cartas de valor 10 del mismo palo, ignorando la cuarta carta de otro palo", () => {
  const hand = [card("oros", 1), card("oros", 13), card("oros", 11), card("copas", 3)];
  const result = evaluateHand(hand);
  assert.equal(result.score, 31);
  assert.equal(result.scoringSuit, "oros");
});

test("todas las cartas valen 10 salvo el As (11) y el Siete (7)", () => {
  const hand = [card("oros", 3), card("oros", 13), card("oros", 5), card("copas", 1)];
  const result = evaluateHand(hand);
  // Grupo oros: Tres(10) + Rey(10) + Cinco comodín(10) = 30
  assert.equal(result.score, 30);
  assert.equal(result.scoringSuit, "oros");
});

test("solo cuentan las cartas del palo que da más puntos, el resto se ignora", () => {
  const hand = [card("bastos", 1), card("bastos", 13), card("bastos", 11), card("copas", 3)];
  const result = evaluateHand(hand);
  assert.equal(result.score, 31);
  assert.equal(result.scoringSuit, "bastos");
});

test("el comodín se asigna siempre al palo que más beneficie al jugador", () => {
  // Oros: As + Rey + comodín = 11+10+10 = 31. Copas: Sota + comodín = 10+10 = 20. Debe elegir oros.
  const hand = [card("oros", 1), card("oros", 13), card("copas", 11), card("bastos", 5)];
  const result = evaluateHand(hand);
  assert.equal(result.score, 31);
  assert.equal(result.scoringSuit, "oros");
});

test("fourOfSameSuit detecta un póker de palo real, incluyendo comodines", () => {
  const flushConWildcard = [card("oros", 1), card("oros", 3), card("oros", 7), card("copas", 5)];
  assert.equal(fourOfSameSuit(flushConWildcard), "oros");

  const sinFlush = [card("oros", 1), card("copas", 3), card("espadas", 7), card("bastos", 13)];
  assert.equal(fourOfSameSuit(sinFlush), null);
});

test("evaluateHand lanza error si no recibe exactamente 4 cartas", () => {
  assert.throws(() => evaluateHand([card("oros", 1), card("copas", 3)]));
});
