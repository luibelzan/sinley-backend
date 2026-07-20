// Baraja española de 32 cartas: As, Tres (x2), Cinco (comodín), Siete, Sota,
// Caballero, Rey — 7 rangos x 4 palos, más una segunda Tres por palo para
// llegar a 32 (ver deck.ts). El Tres duplicado sustituye a un "10" inventado
// que no existe en ninguna baraja española real.
export const SUITS = ["oros", "copas", "espadas", "bastos"] as const;
export type Suit = (typeof SUITS)[number];

// Identificadores de rango (no son directamente su valor de puntos, ver handEvaluator.cardValue):
// 1=As, 3=Tres, 5=Cinco (comodín), 7=Siete, 11=Sota, 12=Caballero, 13=Rey.
export const RANKS = [1, 3, 5, 7, 11, 12, 13] as const;
export type Rank = (typeof RANKS)[number];

export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 4;

export interface Card {
  suit: Suit;
  rank: Rank;
}

// Orden de rango de palos para la variante opcional "suit_rank" (de mayor a menor).
// No forma parte del reglamento oficial de Sin Ley (que solo define el privilegio
// del repartidor), pero se mantiene como variante configurable.
export const SUIT_RANK_ORDER: Suit[] = ["oros", "copas", "espadas", "bastos"];

export type TieBreakVariant = "dealer_privilege" | "suit_rank";

export enum GamePhase {
  WAITING = "waiting",
  DEALING_INITIAL = "dealing_initial",
  BETTING_1 = "betting_1",
  DEALING_SECOND = "dealing_second",
  BETTING_2 = "betting_2",
  DISCARD = "discard",
  BETTING_FINAL = "betting_final",
  SHOWDOWN = "showdown",
  FINISHED = "finished",
}

export type PlayerAction =
  | { type: "pass" } // pasar: solo válido si nadie ha abierto apuesta en esta ronda
  | { type: "bet"; amount: number } // abrir apuesta
  | { type: "call" } // igualar la apuesta vigente
  | { type: "raise"; amount: number } // subir la apuesta
  | { type: "fold" }; // retirarse de la mano

export interface DiscardAction {
  cardIndexes: number[]; // índices (0-3) de las cartas de la mano actual del jugador a descartar
}
