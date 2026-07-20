-- Saldo virtual (wallet) y ledger de movimientos.
--
-- Diseño pensado para poder migrar a dinero real en el futuro sin rehacer nada:
-- - El saldo NUNCA se actualiza "a mano": siempre es la suma implícita del ledger,
--   y balance_cents en wallets es solo una caché que se actualiza en la misma
--   transacción que se inserta el movimiento correspondiente.
-- - Todo se guarda en céntimos (BIGINT), nunca en coma flotante.
-- - wallet_transactions es de solo inserción (append-only): nunca se hace UPDATE
--   ni DELETE sobre un movimiento ya creado, para que quede como auditoría real.

CREATE TABLE IF NOT EXISTS wallets (
    user_id         UUID PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
    balance_cents   BIGINT NOT NULL DEFAULT 0 CHECK (balance_cents >= 0),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS wallet_transactions (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    type                TEXT NOT NULL CHECK (type IN ('recharge', 'bet_debit', 'bet_credit', 'payout', 'adjustment')),
    amount_cents        BIGINT NOT NULL, -- positivo = ingreso, negativo = gasto
    balance_after_cents BIGINT NOT NULL,
    metadata            JSONB,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_wallet_transactions_user_created
    ON wallet_transactions (user_id, created_at DESC);
