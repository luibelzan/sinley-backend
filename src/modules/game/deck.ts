import { randomInt } from "crypto";
import { Card, RANKS, SUITS } from "./types";

export function createDeck(): Card[] {
  const deck: Card[] = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push({ suit, rank });
    }
    // Segunda Tres por palo: sustituye al "10" inventado que había antes,
    // usando una carta que sí existe en la baraja real (con su mismo arte).
    deck.push({ suit, rank: 3 });
  }
  return deck;
}

/**
 * Fisher-Yates usando crypto.randomInt (CSPRNG), no Math.random(): en un
 * juego con apuestas de dinero, el barajado nunca debe ser predecible.
 */
export function shuffleDeck(deck: Card[]): Card[] {
  const shuffled = [...deck];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    const temp = shuffled[i]!;
    shuffled[i] = shuffled[j]!;
    shuffled[j] = temp;
  }
  return shuffled;
}

/** Extrae `count` cartas del final del mazo (in-place) y las devuelve. */
export function drawCards(deck: Card[], count: number): Card[] {
  if (count > deck.length) {
    throw new Error(`No quedan suficientes cartas en el mazo (pedidas ${count}, quedan ${deck.length})`);
  }
  return deck.splice(deck.length - count, count);
}
