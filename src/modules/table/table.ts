import { GileHand } from "../game/matchEngine";
import { MAX_PLAYERS, MIN_PLAYERS, TieBreakVariant } from "../game/types";

export class TableError extends Error {}

export interface TableOptions {
  capacity: number; // 2, 3 o 4
  buyInCents: number; // importe fijo de ficha con el que se sienta cualquiera en esta mesa
  tieBreakVariant?: TieBreakVariant;
}

/**
 * Una mesa en memoria: jugadores sentados, su stack de fichas (persistente
 * entre manos, estilo casino real), rotación del repartidor, y la mano
 * (GileHand) actualmente en curso, si la hay.
 *
 * Todas las mesas de una misma configuración (capacidad + importe de ficha)
 * son intercambiables: la equidad de la partida depende de que TODOS se
 * sienten con el mismo importe, así que la mesa lo impone en vez de dejar
 * que cada jugador elija cuánto arriesgar.
 *
 * Vive en memoria del proceso Node — válido para un solo servidor. Si en el
 * futuro se necesita escalar horizontalmente, esto se movería a Redis
 * (pub/sub entre instancias + el estado de la mesa serializado), pero la
 * lógica de negocio de aquí dentro no cambiaría.
 */
export class Table {
  readonly id: string;
  readonly capacity: number;
  readonly buyInCents: number;
  readonly tieBreakVariant: TieBreakVariant;

  seatOrder: string[] = [];
  connectedUserIds: Set<string> = new Set();
  /** Fichas actuales de cada jugador sentado. Persiste entre manos. */
  stacks: Map<string, number> = new Map();
  dealerIndex = 0;
  currentHand: GileHand | null = null;

  constructor(id: string, options: TableOptions) {
    if (options.capacity < MIN_PLAYERS || options.capacity > MAX_PLAYERS) {
      throw new TableError(`La capacidad de una mesa debe estar entre ${MIN_PLAYERS} y ${MAX_PLAYERS}`);
    }
    if (options.buyInCents <= 0) {
      throw new TableError("El importe de ficha de la mesa debe ser mayor que 0");
    }
    this.id = id;
    this.capacity = options.capacity;
    this.buyInCents = options.buyInCents;
    this.tieBreakVariant = options.tieBreakVariant ?? "dealer_privilege";
  }

  /** Jugadores sentados que todavía tienen fichas para jugar la próxima mano. */
  fundedSeatOrder(): string[] {
    return this.seatOrder.filter((id) => (this.stacks.get(id) ?? 0) > 0);
  }

  /**
   * Sienta a un jugador con el importe de ficha fijo de la mesa (ya
   * debitado de su wallet por la capa de sockets antes de llamar a esto).
   */
  seatPlayerWithStack(userId: string, stackCents: number): void {
    if (this.seatOrder.includes(userId)) {
      this.connectedUserIds.add(userId);
      return;
    }
    if (this.currentHand) {
      throw new TableError("No se puede unir a la mesa mientras hay una mano en curso");
    }
    if (this.seatOrder.length >= this.capacity) {
      throw new TableError("La mesa está completa");
    }
    this.seatOrder.push(userId);
    this.connectedUserIds.add(userId);
    this.stacks.set(userId, stackCents);
  }

  /** ¿Puede este jugador volver a comprar fichas ahora mismo? (se quedó a 0, no hay mano en curso). */
  canRebuy(userId: string): boolean {
    return this.seatOrder.includes(userId) && !this.currentHand && (this.stacks.get(userId) ?? 0) <= 0;
  }

  /** Repone el stack de un jugador al importe de ficha de la mesa (ya debitado de su wallet). */
  rebuy(userId: string): void {
    if (!this.canRebuy(userId)) {
      throw new TableError("No puedes volver a comprar fichas ahora mismo");
    }
    this.stacks.set(userId, this.buyInCents);
  }

  /** El jugador pierde la conexión, pero puede volver a entrar sin perder su asiento ni sus fichas. */
  markDisconnected(userId: string): void {
    this.connectedUserIds.delete(userId);
    // Si le tocaba actuar, se retira automáticamente para no bloquear la mesa
    // esperando indefinidamente a alguien que ya no está conectado.
    if (this.currentHand && this.currentHand.actingPlayerId === userId) {
      try {
        this.currentHand.applyAction(userId, { type: "fold" });
      } catch {
        // Si ya no podía actuar por otro motivo, no pasa nada.
      }
    }
  }

  /**
   * El jugador se va explícitamente de la mesa (no solo se desconecta).
   * Por ahora, las fichas que le quedaran en la mesa no se devuelven al
   * wallet (queda pendiente decidir qué hacer con el saldo de un jugador
   * ausente) — simplemente se pierden al salir.
   */
  removePlayer(userId: string): void {
    this.markDisconnected(userId);
    if (!this.currentHand) {
      this.seatOrder = this.seatOrder.filter((id) => id !== userId);
      this.stacks.delete(userId);
    }
    // Si hay una mano en curso, se quita del seatOrder (y de stacks) al
    // terminar la mano, en finishHandCleanup — para no romper los índices
    // de turno de la mano ya empezada.
  }

  canStartHand(): boolean {
    return !this.currentHand && this.fundedSeatOrder().length >= MIN_PLAYERS;
  }

  startHand(): GileHand {
    const funded = this.fundedSeatOrder();
    if (this.currentHand || funded.length < MIN_PLAYERS) {
      throw new TableError("No se puede iniciar una mano ahora mismo");
    }

    // Repartidor: el primer jugador CON fichas a partir de dealerIndex,
    // recorriendo la mesa completa (por si el que le tocaba se quedó a 0).
    const n = this.seatOrder.length;
    let dealerId: string | null = null;
    for (let step = 0; step < n; step++) {
      const candidate = this.seatOrder[(this.dealerIndex + step) % n]!;
      if (funded.includes(candidate)) {
        dealerId = candidate;
        break;
      }
    }
    if (!dealerId) {
      throw new TableError("No hay ningún jugador con fichas para repartir");
    }

    const stacksSnapshot: Record<string, number> = {};
    for (const id of funded) stacksSnapshot[id] = this.stacks.get(id)!;

    const hand = new GileHand({
      playerIds: funded,
      dealerId,
      tieBreakVariant: this.tieBreakVariant,
      stacks: stacksSnapshot,
    });
    hand.start();
    this.currentHand = hand;
    return hand;
  }

  /** Se llama tras liquidar (o no) el resultado de la mano: sincroniza fichas y prepara la siguiente. */
  finishHandCleanup(): void {
    if (this.currentHand?.result) {
      const finalStacks = this.currentHand.getFinalStacks();
      for (const [id, amount] of Object.entries(finalStacks)) {
        this.stacks.set(id, amount);
      }
    }
    this.dealerIndex = this.seatOrder.length > 0 ? (this.dealerIndex + 1) % this.seatOrder.length : 0;
    this.currentHand = null;

    const stillHere = this.seatOrder.filter((id) => this.connectedUserIds.has(id));
    for (const id of this.seatOrder) {
      if (!stillHere.includes(id)) this.stacks.delete(id);
    }
    this.seatOrder = stillHere;
  }

  getPublicStateFor(userId: string) {
    return {
      tableId: this.id,
      capacity: this.capacity,
      buyInCents: this.buyInCents,
      seatOrder: this.seatOrder,
      connectedUserIds: [...this.connectedUserIds],
      stacks: Object.fromEntries(this.stacks),
      dealerId: this.seatOrder.length > 0 ? this.seatOrder[this.dealerIndex % this.seatOrder.length] : null,
      hand: this.currentHand ? this.currentHand.getPublicState(userId) : null,
    };
  }
}
