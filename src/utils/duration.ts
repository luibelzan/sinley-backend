const UNIT_TO_MS: Record<string, number> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

/**
 * Convierte cadenas como "15m", "30d", "1h" a milisegundos.
 * Solo soporta un número entero seguido de una unidad simple (s, m, h, d, w).
 */
export function parseDurationToMs(duration: string): number {
  const match = /^(\d+)(s|m|h|d|w)$/.exec(duration.trim());
  if (!match) {
    throw new Error(`Formato de duración no soportado: "${duration}". Usa por ejemplo "15m" o "30d".`);
  }
  const [, amountStr, unit] = match;
  const amount = Number(amountStr);
  const unitMs = UNIT_TO_MS[unit as string];
  if (!unitMs) {
    throw new Error(`Unidad de duración no soportada: "${unit}"`);
  }
  return amount * unitMs;
}
