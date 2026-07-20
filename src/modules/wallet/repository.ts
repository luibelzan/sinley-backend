import { PoolClient } from "pg";
import { pool } from "../../db/pool";

export interface WalletRecord {
  user_id: string;
  balance_cents: string; // pg devuelve BIGINT como string para no perder precisión
  updated_at: Date;
}

export type WalletTransactionType = "recharge" | "bet_debit" | "bet_credit" | "payout" | "adjustment";

export interface WalletTransactionRecord {
  id: string;
  user_id: string;
  type: WalletTransactionType;
  amount_cents: string;
  balance_after_cents: string;
  metadata: unknown;
  created_at: Date;
}

export async function createWalletForUser(userId: string, client?: PoolClient): Promise<void> {
  const runner = client ?? pool;
  await runner.query(
    "INSERT INTO wallets (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING",
    [userId]
  );
}

export async function getWallet(userId: string): Promise<WalletRecord | null> {
  const { rows } = await pool.query<WalletRecord>(
    "SELECT * FROM wallets WHERE user_id = $1",
    [userId]
  );
  return rows[0] ?? null;
}

export async function listTransactions(
  userId: string,
  limit: number
): Promise<WalletTransactionRecord[]> {
  const { rows } = await pool.query<WalletTransactionRecord>(
    `SELECT * FROM wallet_transactions
     WHERE user_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [userId, limit]
  );
  return rows;
}

/**
 * Aplica un movimiento de saldo de forma atómica: bloquea la fila del wallet
 * (SELECT ... FOR UPDATE), calcula el nuevo saldo, lo actualiza e inserta el
 * movimiento en el ledger, todo en la misma transacción. Devuelve el registro
 * de wallet ya actualizado.
 *
 * amountCents puede ser negativo (gasto) o positivo (ingreso). Si el resultado
 * fuera negativo, la propia base de datos lo rechaza (CHECK balance_cents >= 0).
 */
export async function applyWalletTransaction(params: {
  userId: string;
  amountCents: bigint;
  type: WalletTransactionType;
  metadata?: Record<string, unknown>;
}): Promise<WalletRecord> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows } = await client.query<WalletRecord>(
      "SELECT * FROM wallets WHERE user_id = $1 FOR UPDATE",
      [params.userId]
    );
    const wallet = rows[0];
    if (!wallet) {
      throw new Error(`No existe wallet para el usuario ${params.userId}`);
    }

    const newBalance = BigInt(wallet.balance_cents) + params.amountCents;

    const updated = await client.query<WalletRecord>(
      `UPDATE wallets SET balance_cents = $1, updated_at = now()
       WHERE user_id = $2
       RETURNING *`,
      [newBalance.toString(), params.userId]
    );

    await client.query(
      `INSERT INTO wallet_transactions (user_id, type, amount_cents, balance_after_cents, metadata)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        params.userId,
        params.type,
        params.amountCents.toString(),
        newBalance.toString(),
        params.metadata ? JSON.stringify(params.metadata) : null,
      ]
    );

    await client.query("COMMIT");
    const result = updated.rows[0];
    if (!result) {
      throw new Error("No se pudo actualizar el wallet");
    }
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
