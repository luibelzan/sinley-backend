import { Table } from "./table";

const tables = new Map<string, Table>();
let roomCounter = 0;

/** Tamaños de mesa disponibles (número de jugadores). */
export const ROOM_CAPACITIES = [2, 3, 4] as const;

/** Importes de ficha disponibles, en EUROS (se convierten a céntimos al crear la mesa). */
export const BUY_IN_TIERS_EUROS = [1, 2, 4, 5, 8, 10, 20, 25, 50, 100, 250] as const;

// Sin caracteres ambiguos (0/O, 1/I) para que el código sea fácil de compartir de viva voz o por chat.
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 6;

export function isValidCapacity(value: number): boolean {
  return (ROOM_CAPACITIES as readonly number[]).includes(value);
}

export function isValidBuyInEuros(value: number): boolean {
  return (BUY_IN_TIERS_EUROS as readonly number[]).includes(value);
}

function generateUniqueCode(): string {
  for (let attempt = 0; attempt < 20; attempt++) {
    let code = "";
    for (let i = 0; i < CODE_LENGTH; i++) {
      code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
    }
    const alreadyUsed = Array.from(tables.values()).some((t) => t.code === code);
    if (!alreadyUsed) return code;
  }
  throw new Error("No se pudo generar un código de sala único");
}

/**
 * Busca una mesa PÚBLICA abierta (con hueco libre y sin mano en curso) con
 * esa capacidad e importe de ficha exactos; si no hay ninguna, crea una
 * nueva. Las mesas privadas nunca se devuelven aquí: solo se puede entrar en
 * ellas con su código.
 */
export function findOrCreateRoom(capacity: number, buyInCents: number): Table {
  for (const table of tables.values()) {
    if (
      !table.isPrivate &&
      table.capacity === capacity &&
      table.buyInCents === buyInCents &&
      !table.currentHand &&
      !table.isGameOver() &&
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

/** Crea una mesa privada nueva con un código de invitación único. */
export function createPrivateRoom(capacity: number, buyInCents: number): Table {
  roomCounter += 1;
  const code = generateUniqueCode();
  const id = `privada-${code}`;
  const table = new Table(id, { capacity, buyInCents, isPrivate: true, code });
  tables.set(id, table);
  return table;
}

/** Busca una mesa privada por su código de invitación (no distingue mayúsculas/minúsculas). */
export function findPrivateRoomByCode(code: string): Table | undefined {
  const normalized = code.trim().toUpperCase();
  return Array.from(tables.values()).find((t) => t.isPrivate && t.code === normalized);
}

export function getTable(tableId: string): Table | undefined {
  return tables.get(tableId);
}
