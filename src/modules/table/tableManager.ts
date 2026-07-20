import { Table } from "./table";

const tables = new Map<string, Table>();
let roomCounter = 0;

/** Tamaños de mesa disponibles (número de jugadores). */
export const ROOM_CAPACITIES = [2, 3, 4] as const;

/** Importes de ficha disponibles, en EUROS (se convierten a céntimos al crear la mesa). */
export const BUY_IN_TIERS_EUROS = [1, 2, 4, 5, 8, 10, 20, 25, 50, 100, 250] as const;

export function isValidCapacity(value: number): boolean {
  return (ROOM_CAPACITIES as readonly number[]).includes(value);
}

export function isValidBuyInEuros(value: number): boolean {
  return (BUY_IN_TIERS_EUROS as readonly number[]).includes(value);
}

/**
 * Busca una mesa abierta (con hueco libre y sin mano en curso) con esa
 * capacidad e importe de ficha exactos; si no hay ninguna, crea una nueva.
 * Todas las mesas con la misma configuración son intercambiables para el
 * jugador — lo único que importa es sentarse con el importe correcto.
 */
export function findOrCreateRoom(capacity: number, buyInCents: number): Table {
  for (const table of tables.values()) {
    if (
      table.capacity === capacity &&
      table.buyInCents === buyInCents &&
      !table.currentHand &&
      table.seatOrder.length < table.capacity
    ) {
      return table;
    }
  }
  roomCounter += 1;
  const id = `mesa-${capacity}j-${buyInCents}c-${roomCounter}`;
  const table = new Table(id, { capacity, buyInCents });
  tables.set(id, table);
  return table;
}

export function getTable(tableId: string): Table | undefined {
  return tables.get(tableId);
}
