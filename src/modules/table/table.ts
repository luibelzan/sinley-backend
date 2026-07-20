import { GileHand } from "../game/matchEngine";
import { MAX_PLAYERS, MIN_PLAYERS, TieBreakVariant } from "../game/types";

export class TableError extends Error {}

/**
 * Una mesa en memoria: jugadores sentados, rotación del repartidor entre
 * manos, y la mano (GileHand) actualmente en curso, si la hay.
 *
 * Vive en memoria del proceso Node — válido para un solo servidor. Si en el
 * futuro se necesita escalar horizontalmente, esto se movería a Redis
 * (pub/sub entre instancias + el estado de la mesa serializado), pero la
 * lógica de negocio de aquí dentro no cambiaría.
 */
export class Table {
  readonly id: string;
  readonly tieBreakVariant: TieBreakVariant;

  seatOrder: string[] = [];
  connectedUserIds: Set<string> = new Set();
  dealerIndex = 0;
  currentHand: GileHand | null = null;

  constructor(id: string, tieBreakVariant: TieBreakVariant = "dealer_privilege") {
    this.id = id;
    this.tieBreakVariant = tieBreakVariant;
  }

  addPlayer(userId: string): void {
    if (this.seatOrder.includes(userId)) {
      this.connectedUserIds.add(userId);
      return;
    }
    if (this.currentHand) {
      throw new TableError("No se puede unir a la mesa mientras hay una mano en curso");
    }
    if (this.seatOrder.length >= MAX_PLAYERS) {
      throw new TableError("La mesa está completa");
    }
    this.seatOrder.push(userId);
    this.connectedUserIds.add(userId);
  }

  /** El jugador pierde la conexión, pero puede volver a entrar sin perder su asiento. */
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

  /** El jugador se va explícitamente de la mesa (no solo se desconecta). */
  removePlayer(userId: string): void {
    this.markDisconnected(userId);
    if (!this.currentHand) {
      this.seatOrder = this.seatOrder.filter((id) => id !== userId);
    }
    // Si hay una mano en curso, se quita del seatOrder al terminar la mano
    // (para no romper los índices de turno de la mano ya empezada).
  }

  canStartHand(): boolean {
    return !this.currentHand && this.seatOrder.length >= MIN_PLAYERS;
  }

  startHand(stacks: Record<string, number>): GileHand {
    if (!this.canStartHand()) {
      throw new TableError("No se puede iniciar una mano ahora mismo");
    }
    const dealerId = this.seatOrder[this.dealerIndex % this.seatOrder.length]!;
    const hand = new GileHand({
      playerIds: [...this.seatOrder],
      dealerId,
      tieBreakVariant: this.tieBreakVariant,
      stacks,
    });
    hand.start();
    this.currentHand = hand;
    return hand;
  }

  /** Se llama tras liquidar el resultado de la mano (pagos ya aplicados). */
  finishHandCleanup(): void {
    this.dealerIndex = this.seatOrder.length > 0 ? (this.dealerIndex + 1) % this.seatOrder.length : 0;
    this.currentHand = null;
    // Se aplican aquí las salidas de jugadores que se fueron a mitad de mano.
    this.seatOrder = this.seatOrder.filter((id) => this.connectedUserIds.has(id));
  }

  getPublicStateFor(userId: string) {
    return {
      tableId: this.id,
      seatOrder: this.seatOrder,
      connectedUserIds: [...this.connectedUserIds],
      dealerId: this.seatOrder.length > 0 ? this.seatOrder[this.dealerIndex % this.seatOrder.length] : null,
      hand: this.currentHand ? this.currentHand.getPublicState(userId) : null,
    };
  }
}
