import { createDeck, drawCards, shuffleDeck } from "./deck";
import { compareHandEvaluations, evaluateHand, fourOfSameSuit, HandEvaluation } from "./handEvaluator";
import {
  Card,
  DiscardAction,
  GamePhase,
  MAX_PLAYERS,
  MIN_PLAYERS,
  PlayerAction,
  SUIT_RANK_ORDER,
  TieBreakVariant,
} from "./types";

interface PlayerState {
  id: string;
  hand: Card[];
  folded: boolean;
  currentRoundBet: number;
  totalContributed: number;
  actedThisRound: boolean;
  hasDiscardedThisPhase: boolean;
  /** Ha aportado todo su stack: ya no puede volver a actuar en apuestas, pero sigue en la mano. */
  allIn: boolean;
}

export type HandFinishReason = "showdown" | "fold" | "instant_flush";

export interface PayoutEntry {
  playerId: string;
  amount: number;
}

export interface HandResult {
  /** Uno o más ganadores: puede haber más de uno si hubo botes divididos (side pots). */
  payouts: PayoutEntry[];
  pot: number;
  evaluations: Record<string, HandEvaluation>;
  reason: HandFinishReason;
}

export class GameRuleError extends Error {}

interface PotLayer {
  amount: number;
  eligiblePlayerIds: string[];
}

/**
 * Divide el bote en capas según los distintos niveles de aportación (para
 * cuando alguien se queda all-in con menos fichas que el resto). Cada capa
 * solo la pueden ganar los jugadores activos (no retirados) que hayan
 * aportado al menos hasta ese nivel — así, un jugador corto de fichas no
 * puede llevarse dinero que no le corresponde de un bote al que no llegó.
 */
function computePotLayers(contributions: Record<string, number>, activeIds: Set<string>): PotLayer[] {
  const levels = Array.from(new Set(Object.values(contributions).filter((v) => v > 0))).sort((a, b) => a - b);
  const layers: PotLayer[] = [];
  let previousLevel = 0;

  for (const level of levels) {
    const contributors = Object.entries(contributions)
      .filter(([, amount]) => amount >= level)
      .map(([id]) => id);
    const layerAmount = (level - previousLevel) * contributors.length;
    if (layerAmount > 0) {
      layers.push({
        amount: layerAmount,
        eligiblePlayerIds: contributors.filter((id) => activeIds.has(id)),
      });
    }
    previousLevel = level;
  }

  return layers;
}

/**
 * Representa UNA mano completa de Sin Ley (desde el reparto inicial hasta el
 * showdown, la victoria automática por póker de palo, o hasta que gana por
 * retirada de los demás). La rotación del repartidor entre manos y la gestión
 * de mesas/sockets viven en otra capa.
 */
export class GileHand {
  readonly seating: string[];
  readonly dealerIndex: number;
  readonly tieBreakVariant: TieBreakVariant;
  private readonly stacks: Map<string, number>;

  private deck: Card[] = [];
  /** Cartas descartadas durante la fase de descarte actual, listas para rebarajar si el mazo se queda corto. */
  private discardPile: Card[] = [];
  private players: Map<string, PlayerState> = new Map();
  private order: string[];

  phase: GamePhase = GamePhase.WAITING;
  pot = 0;
  currentBetToMatch = 0;
  actingPlayerId: string | null = null;
  result: HandResult | null = null;

  /**
   * `stacks` es el saldo disponible de cada jugador para ESTA mano (en las
   * mismas unidades que el resto de importes, p. ej. céntimos), tomado como
   * una foto fija al empezar — igual que las fichas que un jugador tiene
   * delante en una mesa física. Las apuestas nunca pueden superar el stack:
   * si un jugador pide más de lo que le queda, se le pone all-in por lo que
   * tenga en vez de rechazar la acción.
   */
  constructor(params: {
    playerIds: string[];
    dealerId: string;
    tieBreakVariant: TieBreakVariant;
    stacks: Record<string, number>;
  }) {
    if (params.playerIds.length < MIN_PLAYERS || params.playerIds.length > MAX_PLAYERS) {
      throw new GameRuleError(`Sin Ley se juega con ${MIN_PLAYERS} a ${MAX_PLAYERS} jugadores`);
    }
    const dealerIndex = params.playerIds.indexOf(params.dealerId);
    if (dealerIndex === -1) {
      throw new GameRuleError("El repartidor debe ser uno de los jugadores de la mano");
    }
    for (const id of params.playerIds) {
      if (params.stacks[id] === undefined) {
        throw new GameRuleError(`Falta el stack del jugador ${id}`);
      }
    }

    this.seating = [...params.playerIds];
    this.order = [...params.playerIds];
    this.dealerIndex = dealerIndex;
    this.tieBreakVariant = params.tieBreakVariant;
    this.stacks = new Map(Object.entries(params.stacks));

    for (const id of params.playerIds) {
      const stack = this.stacks.get(id)!;
      this.players.set(id, {
        id,
        hand: [],
        folded: false,
        currentRoundBet: 0,
        totalContributed: 0,
        actedThisRound: false,
        hasDiscardedThisPhase: false,
        allIn: stack <= 0, // un jugador sin saldo empieza ya all-in: no puede apostar nada
      });
    }
  }

  // ---------- utilidades de turno ----------

  private activePlayers(): PlayerState[] {
    return this.order.map((id) => this.players.get(id)!).filter((p) => !p.folded);
  }

  /** Jugadores que todavía pueden actuar en una ronda de apuestas (activos y no all-in). */
  private playersWhoCanAct(): PlayerState[] {
    return this.activePlayers().filter((p) => !p.allIn);
  }

  /** Salta solo a jugadores retirados (se usa para el orden de reparto). */
  private nextActiveIndexFrom(seatIndex: number): number {
    const n = this.order.length;
    for (let step = 1; step <= n; step++) {
      const idx = (seatIndex + step) % n;
      const player = this.players.get(this.order[idx]!)!;
      if (!player.folded) return idx;
    }
    throw new GameRuleError("No quedan jugadores activos");
  }

  /** Salta a retirados Y a jugadores all-in (se usa para el turno de apuestas). Null si nadie puede actuar. */
  private nextActionableIndexFrom(seatIndex: number): number | null {
    const n = this.order.length;
    for (let step = 1; step <= n; step++) {
      const idx = (seatIndex + step) % n;
      const player = this.players.get(this.order[idx]!)!;
      if (!player.folded && !player.allIn) return idx;
    }
    return null;
  }

  private firstToActIndex(): number {
    return this.nextActiveIndexFrom(this.dealerIndex);
  }

  private getPlayerOrThrow(playerId: string): PlayerState {
    const player = this.players.get(playerId);
    if (!player) throw new GameRuleError(`Jugador desconocido: ${playerId}`);
    return player;
  }

  // ---------- reparto ----------

  start(): void {
    if (this.phase !== GamePhase.WAITING) {
      throw new GameRuleError("La mano ya ha comenzado");
    }
    this.deck = shuffleDeck(createDeck());
    this.dealInitialCards();
  }

  private dealInitialCards(): void {
    this.phase = GamePhase.DEALING_INITIAL;
    const firstIndex = this.firstToActIndex();
    for (let round = 0; round < 2; round++) {
      for (let step = 0; step < this.order.length; step++) {
        const idx = (firstIndex + step) % this.order.length;
        const player = this.players.get(this.order[idx]!)!;
        if (player.folded) continue;
        player.hand.push(...drawCards(this.deck, 1));
      }
    }
    this.beginBettingRound(GamePhase.BETTING_1);
  }

  private dealAdditionalCards(count: number): void {
    for (const player of this.activePlayers()) {
      player.hand.push(...drawCards(this.deck, count));
    }
  }

  // ---------- rondas de apuestas ----------

  private beginBettingRound(phase: GamePhase): void {
    this.phase = phase;
    this.currentBetToMatch = 0;
    for (const player of this.players.values()) {
      player.currentRoundBet = 0;
      player.actedThisRound = false;
    }

    if (this.playersWhoCanAct().length < 2) {
      // Ya no puede haber más apuestas (todos menos uno, o todos, están
      // all-in): la ronda se salta entera, "cartas arriba", y se avanza
      // directamente a la siguiente fase sin pedir ninguna acción.
      this.actingPlayerId = null;
      this.resolveBettingRound();
      return;
    }

    const firstIndex = this.nextActionableIndexFrom(this.dealerIndex)!;
    this.actingPlayerId = this.order[firstIndex]!;
  }

  private isBettingPhase(): boolean {
    return (
      this.phase === GamePhase.BETTING_1 ||
      this.phase === GamePhase.BETTING_2 ||
      this.phase === GamePhase.BETTING_FINAL
    );
  }

  /** Aplica la acción de un jugador y avanza el turno o resuelve la ronda. Devuelve lo realmente aportado al bote. */
  applyAction(playerId: string, action: PlayerAction): number {
    if (!this.isBettingPhase()) {
      throw new GameRuleError(`No es una fase de apuestas (fase actual: ${this.phase})`);
    }
    if (this.actingPlayerId !== playerId) {
      throw new GameRuleError(`No es el turno de ${playerId}, le toca a ${this.actingPlayerId}`);
    }

    const player = this.getPlayerOrThrow(playerId);
    let committed = 0;

    switch (action.type) {
      case "pass": {
        if (player.currentRoundBet !== this.currentBetToMatch) {
          throw new GameRuleError("No puedes pasar: hay una apuesta pendiente que igualar o subir");
        }
        player.actedThisRound = true;
        break;
      }
      case "bet": {
        if (this.currentBetToMatch !== 0) {
          throw new GameRuleError("Ya hay una apuesta abierta esta ronda: usa call o raise");
        }
        if (action.amount <= 0) {
          throw new GameRuleError("La apuesta debe ser mayor que 0");
        }
        committed = this.commit(player, action.amount);
        this.currentBetToMatch = player.currentRoundBet;
        this.resetOthersActed(playerId);
        player.actedThisRound = true;
        break;
      }
      case "call": {
        if (this.currentBetToMatch === 0) {
          throw new GameRuleError("No hay ninguna apuesta que igualar: usa pass o bet");
        }
        const diff = this.currentBetToMatch - player.currentRoundBet;
        committed = this.commit(player, diff);
        // Si el jugador no tiene para igualar del todo, esto es un "call"
        // corto (all-in por menos): currentBetToMatch no cambia, y a nadie
        // más se le exige aportar más por esto.
        player.actedThisRound = true;
        break;
      }
      case "raise": {
        if (this.currentBetToMatch === 0) {
          throw new GameRuleError("No hay apuesta previa que subir: usa bet");
        }
        const requestedDiff = action.amount - player.currentRoundBet;
        if (requestedDiff <= 0) {
          throw new GameRuleError("La subida debe suponer aportar más de lo ya apostado");
        }
        committed = this.commit(player, requestedDiff);
        if (player.currentRoundBet > this.currentBetToMatch) {
          this.currentBetToMatch = player.currentRoundBet;
          this.resetOthersActed(playerId);
        }
        // Si el stack no llegaba ni para igualar la apuesta vigente, esto
        // termina siendo un all-in por menos (equivalente a un call corto),
        // no una subida real: currentBetToMatch no cambia en ese caso.
        player.actedThisRound = true;
        break;
      }
      case "fold": {
        player.folded = true;
        player.actedThisRound = true;
        break;
      }
    }

    this.advanceTurnOrResolve();
    return committed;
  }

  /** Aporta al bote, limitado a lo que le queda de stack al jugador. Marca all-in si se queda a 0. Devuelve lo aportado. */
  private commit(player: PlayerState, requestedAmount: number): number {
    const stack = this.stacks.get(player.id) ?? 0;
    const remaining = stack - player.totalContributed;
    const actual = Math.max(0, Math.min(requestedAmount, remaining));

    player.currentRoundBet += actual;
    player.totalContributed += actual;
    this.pot += actual;

    if (stack - player.totalContributed <= 0) {
      player.allIn = true;
    }
    return actual;
  }

  private resetOthersActed(exceptPlayerId: string): void {
    for (const p of this.players.values()) {
      if (p.id !== exceptPlayerId && !p.folded) p.actedThisRound = false;
    }
  }

  private roundIsComplete(): boolean {
    // Los jugadores all-in ya no tienen nada más que decidir: cuentan como
    // "listos" para la ronda con independencia de lo que hayan aportado.
    return this.activePlayers().every(
      (p) => p.allIn || (p.actedThisRound && p.currentRoundBet === this.currentBetToMatch)
    );
  }

  private advanceTurnOrResolve(): void {
    const active = this.activePlayers();

    if (active.length === 1) {
      this.finishHand([{ playerId: active[0]!.id, amount: this.pot }], {}, "fold");
      return;
    }

    if (this.roundIsComplete()) {
      this.resolveBettingRound();
      return;
    }

    const currentIndex = this.order.indexOf(this.actingPlayerId!);
    const nextIndex = this.nextActionableIndexFrom(currentIndex);
    if (nextIndex === null) {
      // Nadie más puede actuar (el resto están all-in o retirados): se
      // resuelve la ronda igualmente en vez de esperar una acción que nunca
      // podrá llegar.
      this.resolveBettingRound();
      return;
    }
    this.actingPlayerId = this.order[nextIndex]!;
  }

  private resolveBettingRound(): void {
    if (this.phase === GamePhase.BETTING_1) {
      this.phase = GamePhase.DEALING_SECOND;
      this.dealAdditionalCards(2);
      this.beginBettingRound(GamePhase.BETTING_2);
      return;
    }

    if (this.phase === GamePhase.BETTING_2) {
      const instantWinner = this.checkInstantFlushWinner();
      if (instantWinner) {
        this.finishHand(
          [{ playerId: instantWinner.winnerId, amount: this.pot }],
          instantWinner.evaluations,
          "instant_flush"
        );
        return;
      }
      this.phase = GamePhase.DISCARD;
      this.discardPile = [];
      for (const p of this.players.values()) p.hasDiscardedThisPhase = false;
      this.actingPlayerId = this.order[this.firstToActIndex()]!;
      return;
    }

    if (this.phase === GamePhase.BETTING_FINAL) {
      this.showdown();
      return;
    }
  }

  private checkInstantFlushWinner(): { winnerId: string; evaluations: Record<string, HandEvaluation> } | null {
    const active = this.activePlayers();
    const flushHolders = active.filter((p) => fourOfSameSuit(p.hand) !== null);
    if (flushHolders.length === 0) return null;

    const evaluations: Record<string, HandEvaluation> = {};
    for (const p of flushHolders) evaluations[p.id] = evaluateHand(p.hand);

    if (flushHolders.length === 1) {
      return { winnerId: flushHolders[0]!.id, evaluations };
    }

    const winnerId = this.resolveTie(
      flushHolders.map((p) => p.id),
      evaluations
    );
    return { winnerId, evaluations };
  }

  /**
   * Reparte `count` cartas para el descarte. Si el mazo no da para tanto,
   * se barajan de nuevo las cartas ya descartadas en esta fase (por
   * cualquier jugador) y se continúa repartiendo desde ahí — en vez de
   * rechazar el descarte por falta de cartas.
   */
  private drawForDiscard(count: number): Card[] {
    if (this.deck.length < count) {
      this.deck = shuffleDeck([...this.deck, ...this.discardPile]);
      this.discardPile = [];
    }
    return drawCards(this.deck, count);
  }

  // ---------- descarte ----------

  applyDiscard(playerId: string, discard: DiscardAction): void {
    if (this.phase !== GamePhase.DISCARD) {
      throw new GameRuleError(`No es la fase de descarte (fase actual: ${this.phase})`);
    }
    const player = this.getPlayerOrThrow(playerId);
    if (player.folded) {
      throw new GameRuleError("Un jugador retirado no participa en el descarte");
    }
    if (player.hasDiscardedThisPhase) {
      throw new GameRuleError("Este jugador ya ha descartado en esta fase");
    }
    const uniqueIndexes = new Set(discard.cardIndexes);
    if (uniqueIndexes.size !== discard.cardIndexes.length) {
      throw new GameRuleError("Índices de descarte repetidos");
    }
    for (const idx of uniqueIndexes) {
      if (idx < 0 || idx >= player.hand.length) {
        throw new GameRuleError(`Índice de descarte fuera de rango: ${idx}`);
      }
    }
    if (uniqueIndexes.size > this.deck.length + this.discardPile.length) {
      // Ni siquiera rebarajando todo lo ya descartado en esta fase hay
      // suficientes cartas: esto sería un error de diseño del mazo, no una
      // situación de juego normal.
      throw new GameRuleError(
        `No quedan cartas suficientes para completar el descarte ni rebarajando los descartes (pedidas ${uniqueIndexes.size}, disponibles ${this.deck.length + this.discardPile.length})`
      );
    }

    const discarded = player.hand.filter((_, idx) => uniqueIndexes.has(idx));
    const keep = player.hand.filter((_, idx) => !uniqueIndexes.has(idx));
    const newCards = this.drawForDiscard(uniqueIndexes.size);
    player.hand = [...keep, ...newCards];
    player.hasDiscardedThisPhase = true;
    this.discardPile.push(...discarded);

    const activeIds = this.activePlayers().map((p) => p.id);
    const allDiscarded = activeIds.every((id) => this.players.get(id)!.hasDiscardedThisPhase);
    if (allDiscarded) {
      this.beginBettingRound(GamePhase.BETTING_FINAL);
    }
  }

  // ---------- showdown ----------

  private suitRankValue(suit: Card["suit"]): number {
    return SUIT_RANK_ORDER.length - SUIT_RANK_ORDER.indexOf(suit);
  }

  private pickWinnerAmong(playerIds: string[], evaluations: Record<string, HandEvaluation>): string {
    let best = playerIds[0]!;
    for (const id of playerIds.slice(1)) {
      if (compareHandEvaluations(evaluations[id]!, evaluations[best]!) > 0) {
        best = id;
      }
    }
    const tied = playerIds.filter((id) => compareHandEvaluations(evaluations[id]!, evaluations[best]!) === 0);
    return tied.length === 1 ? tied[0]! : this.resolveTie(tied, evaluations);
  }

  private showdown(): void {
    this.phase = GamePhase.SHOWDOWN;
    const active = this.activePlayers();
    const evaluations: Record<string, HandEvaluation> = {};
    for (const p of active) {
      evaluations[p.id] = evaluateHand(p.hand);
    }

    const contributions: Record<string, number> = {};
    for (const p of this.players.values()) contributions[p.id] = p.totalContributed;
    const activeIds = new Set(active.map((p) => p.id));
    const layers = computePotLayers(contributions, activeIds);

    if (layers.length === 0) {
      // Nadie llegó a apostar nada en toda la mano (todos pasaron siempre):
      // no hay dinero que repartir, pero igualmente se registra un ganador.
      const winnerId = this.pickWinnerAmong(
        active.map((p) => p.id),
        evaluations
      );
      this.finishHand([{ playerId: winnerId, amount: 0 }], evaluations, "showdown");
      return;
    }

    const payoutByPlayer = new Map<string, number>();
    for (const layer of layers) {
      if (layer.eligiblePlayerIds.length === 0) continue;
      const winnerId = this.pickWinnerAmong(layer.eligiblePlayerIds, evaluations);
      payoutByPlayer.set(winnerId, (payoutByPlayer.get(winnerId) ?? 0) + layer.amount);
    }

    const payouts = Array.from(payoutByPlayer.entries()).map(([playerId, amount]) => ({ playerId, amount }));
    this.finishHand(payouts, evaluations, "showdown");
  }

  /** Aplica la regla de desempate configurada (privilegio del repartidor, u opcionalmente rango de palos). */
  private resolveTie(tiedIds: string[], evaluations: Record<string, HandEvaluation>): string {
    if (this.tieBreakVariant === "suit_rank") {
      const allHaveSuit = tiedIds.every((id) => evaluations[id]!.scoringSuit !== null);
      if (allHaveSuit) {
        return this.resolveTieBySuitRank(tiedIds, evaluations);
      }
    }
    return this.resolveTieByDealerPrivilege(tiedIds);
  }

  private resolveTieByDealerPrivilege(tiedIds: string[]): string {
    const dealerId = this.seating[this.dealerIndex]!;
    if (tiedIds.includes(dealerId)) return dealerId;

    const n = this.seating.length;
    for (let step = 1; step <= n; step++) {
      const idx = (this.dealerIndex - step + n) % n;
      const candidate = this.seating[idx]!;
      if (tiedIds.includes(candidate)) return candidate;
    }
    throw new GameRuleError("No se pudo resolver el empate por privilegio del repartidor");
  }

  private resolveTieBySuitRank(tiedIds: string[], evaluations: Record<string, HandEvaluation>): string {
    let bestId = tiedIds[0]!;
    let bestValue = this.suitRankValue(evaluations[bestId]!.scoringSuit!);
    for (const id of tiedIds.slice(1)) {
      const value = this.suitRankValue(evaluations[id]!.scoringSuit!);
      if (value > bestValue) {
        bestId = id;
        bestValue = value;
      }
    }
    return bestId;
  }

  private finishHand(payouts: PayoutEntry[], evaluations: Record<string, HandEvaluation>, reason: HandFinishReason): void {
    this.result = { payouts, pot: this.pot, evaluations, reason };
    this.phase = GamePhase.FINISHED;
  }

  /**
   * Fichas resultantes de cada jugador tras esta mano (solo válido una vez
   * terminada): lo que le quedaba de stack sin llegar a apostar, más lo que
   * haya ganado en el reparto del bote. La capa de mesa lo usa para
   * mantener el stack persistente de cada jugador entre manos (estilo
   * casino real, no se reinicia cada mano).
   */
  getFinalStacks(): Record<string, number> {
    if (!this.result) {
      throw new GameRuleError("La mano todavía no ha terminado");
    }
    const payoutByPlayer = new Map(this.result.payouts.map((p) => [p.playerId, p.amount]));
    const final: Record<string, number> = {};
    for (const id of this.seating) {
      const stack = this.stacks.get(id) ?? 0;
      const player = this.players.get(id)!;
      const remaining = stack - player.totalContributed;
      final[id] = remaining + (payoutByPlayer.get(id) ?? 0);
    }
    return final;
  }

  // ---------- vista pública (sin filtrar cartas ocultas) ----------

  getPublicState(forPlayerId: string) {
    // Al terminar la mano por showdown (o por póker de palo instantáneo), se
    // muestran las cartas de todos los que llegaron a esa fase con normalidad
    // — es lo que pasaría en una mesa física. Si termina por retirada de
    // todos menos uno, nadie tuvo que enseñar nada, así que sus cartas
    // siguen ocultas.
    const revealAllHands =
      this.phase === GamePhase.FINISHED && this.result !== null && this.result.reason !== "fold";

    return {
      phase: this.phase,
      pot: this.pot,
      currentBetToMatch: this.currentBetToMatch,
      actingPlayerId: this.actingPlayerId,
      dealerId: this.seating[this.dealerIndex],
      result: this.result,
      players: this.order.map((id) => {
        const p = this.players.get(id)!;
        const showHand = id === forPlayerId || (revealAllHands && !p.folded);
        return {
          id: p.id,
          folded: p.folded,
          allIn: p.allIn,
          currentRoundBet: p.currentRoundBet,
          totalContributed: p.totalContributed,
          cardCount: p.hand.length,
          hand: showHand ? p.hand : undefined,
        };
      }),
    };
  }
}
