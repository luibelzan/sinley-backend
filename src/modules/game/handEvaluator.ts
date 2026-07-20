import { Card, Rank, SUITS, Suit } from "./types";

export type HandTier = "sin_ley_real" | "sin_ley" | "suit_score";

export interface HandEvaluation {
  tier: HandTier;
  /**
   * Puntuación para comparar DENTRO del mismo tier. Entre tiers distintos,
   * el orden es siempre sin_ley_real > sin_ley > suit_score, sin importar
   * el valor de `score` (usa compareHandEvaluations, no compares `score` a pelo).
   */
  score: number;
  /** Palo usado para puntuar (null en sin_ley / sin_ley_real, donde el palo no importa). */
  scoringSuit: Suit | null;
  /** Cartas que efectivamente puntúan (para depuración / UI). */
  scoringCards: Card[];
  handTypeLabel: string;
}

const CARD_VALUES: Record<Rank, number> = {
  1: 11, // As
  3: 10, // Tres
  5: 10, // Cinco (comodín)
  7: 7, // Siete
  11: 10, // Sota
  12: 10, // Caballero
  13: 10, // Rey
};

export function cardValue(rank: Rank): number {
  return CARD_VALUES[rank];
}

/** El Cinco es comodín: no tiene palo fijo a efectos de puntuación. */
export function isWildcard(rank: Rank): boolean {
  return rank === 5;
}

interface SuitGroup {
  suit: Suit;
  cards: Card[]; // cartas de ese palo + todos los comodines de la mano
  sum: number;
}

function suitGroups(cards: Card[]): SuitGroup[] {
  return SUITS.map((suit) => {
    const group = cards.filter((c) => c.suit === suit || isWildcard(c.rank));
    const sum = group.reduce((acc, c) => acc + cardValue(c.rank), 0);
    return { suit, cards: group, sum };
  });
}

function labelForScore(score: number): string {
  switch (score) {
    case 41:
      return "41 (As + tres cartas de valor 10 del mismo palo)";
    case 40:
      return "40 (cuatro cartas de valor 10 del mismo palo)";
    case 38:
      return "38 (As + dos cartas de valor 10 + siete del mismo palo)";
    case 37:
      return "37 (tres cartas de valor 10 + siete del mismo palo)";
    case 31:
      return "31 (As + dos cartas de valor 10 del mismo palo)";
    default:
      return `${score} puntos`;
  }
}

export function evaluateHand(cards: Card[]): HandEvaluation {
  if (cards.length !== 4) {
    throw new Error(`evaluateHand espera exactamente 4 cartas, recibidas ${cards.length}`);
  }

  const aceCount = cards.filter((c) => c.rank === 1).length;

  if (aceCount === 4) {
    return {
      tier: "sin_ley_real",
      score: 4,
      scoringSuit: null,
      scoringCards: cards,
      handTypeLabel: "Sin Ley Real (cuatro ases)",
    };
  }

  if (aceCount === 3) {
    return {
      tier: "sin_ley",
      score: 3,
      scoringSuit: null,
      scoringCards: cards.filter((c) => c.rank === 1),
      handTypeLabel: "Sin Ley (tres ases)",
    };
  }

  // Puntuación por palo: solo cuentan las cartas del palo que dé más puntos;
  // los comodines (Cinco) se suman siempre al palo que se esté evaluando.
  const groups = suitGroups(cards);
  const best = groups.reduce((a, b) => (b.sum > a.sum ? b : a));

  return {
    tier: "suit_score",
    score: best.sum,
    scoringSuit: best.suit,
    scoringCards: best.cards,
    handTypeLabel: labelForScore(best.sum),
  };
}

/**
 * Devuelve el palo si las 4 cartas de la mano son del mismo palo (contando
 * los comodines como de cualquier palo), o null si no hay tal póker de palo.
 * Se usa para la victoria inmediata tras el segundo reparto.
 */
export function fourOfSameSuit(cards: Card[]): Suit | null {
  const groups = suitGroups(cards);
  const flush = groups.find((g) => g.cards.length === cards.length);
  return flush ? flush.suit : null;
}

const TIER_RANK: Record<HandTier, number> = { sin_ley_real: 2, sin_ley: 1, suit_score: 0 };

/** >0 si a le gana a b, <0 si pierde, 0 si hay empate real (mismo tier y misma score). */
export function compareHandEvaluations(a: HandEvaluation, b: HandEvaluation): number {
  const tierDiff = TIER_RANK[a.tier] - TIER_RANK[b.tier];
  if (tierDiff !== 0) return tierDiff;
  return a.score - b.score;
}
