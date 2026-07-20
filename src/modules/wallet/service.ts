import { AppError } from "../../utils/AppError";
import { applyWalletTransaction, getWallet, listTransactions } from "./repository";

const PG_CHECK_VIOLATION = "23514";

function centsToAmount(cents: string): number {
  return Number(BigInt(cents)) / 100;
}

export interface WalletView {
  balanceCents: string;
  balance: number;
  updatedAt: Date;
}

export async function getBalance(userId: string): Promise<WalletView> {
  const wallet = await getWallet(userId);
  if (!wallet) {
    // No debería pasar: el wallet se crea al registrarse. Si ocurre, es un bug
    // de datos, no una situación normal del usuario.
    throw new AppError(500, "wallet_not_found", "No se encontró el wallet del usuario");
  }
  return {
    balanceCents: wallet.balance_cents,
    balance: centsToAmount(wallet.balance_cents),
    updatedAt: wallet.updated_at,
  };
}

/**
 * Recarga simulada: no hay pasarela de pago real todavía, así que cualquier
 * cantidad solicitada se acredita directamente. El punto de integración de un
 * proveedor de pagos real (Stripe, Redsys...) sería aquí: se validaría el pago
 * confirmado por el proveedor ANTES de llamar a applyWalletTransaction.
 */
export async function recharge(userId: string, amount: number): Promise<WalletView> {
  const amountCents = BigInt(Math.round(amount * 100));

  const wallet = await applyWalletTransaction({
    userId,
    amountCents,
    type: "recharge",
    metadata: { simulated: true },
  });

  return {
    balanceCents: wallet.balance_cents,
    balance: centsToAmount(wallet.balance_cents),
    updatedAt: wallet.updated_at,
  };
}

export async function getHistory(userId: string, limit = 50) {
  const transactions = await listTransactions(userId, limit);
  return transactions.map((t) => ({
    id: t.id,
    type: t.type,
    amount: centsToAmount(t.amount_cents),
    balanceAfter: centsToAmount(t.balance_after_cents),
    createdAt: t.created_at,
  }));
}

/**
 * Traduce violaciones de la restricción CHECK (balance_cents >= 0) a un error
 * de negocio legible. Se usará en cuanto añadamos apuestas (paso 4), donde sí
 * es un caso normal que el usuario no tenga saldo suficiente.
 */
export function isInsufficientFundsError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: string }).code === PG_CHECK_VIOLATION
  );
}
