/**
 * Script de demostración del escenario all-in dentro de una sala con buy-in
 * fijo: dos jugadores se sientan con el MISMO importe (así se ve la mesa
 * justa que pediste), ambos van all-in en la primera ronda, no descartan
 * nada, y la mano termina directamente durante el descarte (apuestas
 * bloqueadas). Comprueba que el stack de fichas de la mesa cuadra: el
 * ganador se queda con el doble, el perdedor con 0 (y puede recomprar).
 *
 * Requiere que el servidor ya esté corriendo (`npm run dev`).
 * Uso: npm run demo:allin
 */
import { io, Socket } from "socket.io-client";

const BASE_URL = process.env.DEMO_BASE_URL ?? "http://localhost:4000";
const CAPACITY = 2;
const BUY_IN_EUROS = 10; // ambos se sientan con el mismo importe: mesa justa

interface AuthedUser {
  userId: string;
  accessToken: string;
}

async function registerAndFund(username: string): Promise<AuthedUser> {
  const email = `${username}-${Date.now()}@example.com`;
  const registerRes = await fetch(`${BASE_URL}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: `${username}${Date.now()}`.slice(0, 20), email, password: "password123" }),
  });
  if (!registerRes.ok) throw new Error(`No se pudo registrar ${username}: ${await registerRes.text()}`);
  const registerData = (await registerRes.json()) as { user: { id: string }; accessToken: string };

  const rechargeRes = await fetch(`${BASE_URL}/wallet/recharge`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${registerData.accessToken}` },
    body: JSON.stringify({ amount: BUY_IN_EUROS }),
  });
  if (!rechargeRes.ok) throw new Error(`No se pudo recargar a ${username}: ${await rechargeRes.text()}`);

  return { userId: registerData.user.id, accessToken: registerData.accessToken };
}

async function getBalance(accessToken: string): Promise<number> {
  const res = await fetch(`${BASE_URL}/wallet/me`, { headers: { Authorization: `Bearer ${accessToken}` } });
  const data = (await res.json()) as { balance: number };
  return data.balance;
}

async function runPlayer(label: string, user: AuthedUser, onFinished: (result: any) => void): Promise<Socket> {
  const socket = io(BASE_URL, { auth: { token: user.accessToken } });
  const discardedInPhase = new Set<string>();

  socket.on("connect", () => {
    console.log(`[${label}] conectado, uniéndose a una mesa de ${CAPACITY} jugadores a ${BUY_IN_EUROS}€`);
    socket.emit("table:join", { capacity: CAPACITY, buyInEuros: BUY_IN_EUROS });
  });

  socket.on("table:error", (err: { message: string }) => console.log(`[${label}] error:`, err.message));

  socket.on("table:state", (state: any) => {
    if (!state.hand) return;
    const hand = state.hand;

    if (hand.phase === "discard" && !discardedInPhase.has("discard")) {
      discardedInPhase.add("discard");
      setTimeout(() => socket.emit("hand:discard", { cardIndexes: [] }), 150);
    }
    if (hand.phase !== "discard") discardedInPhase.delete("discard");

    if (hand.actingPlayerId === user.userId && ["betting_1", "betting_2", "betting_final"].includes(hand.phase)) {
      const action =
        hand.currentBetToMatch === 0
          ? { type: "bet", amount: 999_999_999_999 }
          : { type: "raise", amount: 999_999_999_999 };
      console.log(`[${label}] fase=${hand.phase} pot=${hand.pot} -> All-in (${action.type})`);
      setTimeout(() => socket.emit("hand:action", action), 150);
    }

    if (hand.phase === "finished" && hand.result) {
      onFinished(hand.result);
    }
  });

  await new Promise<void>((resolve) => socket.on("connect", () => resolve()));
  return socket;
}

async function main() {
  console.log(`Registrando y recargando a dos jugadores con ${BUY_IN_EUROS}€ cada uno...`);
  const ana = await registerAndFund("ana");
  const beto = await registerAndFund("beto");

  let finishedCount = 0;
  let lastResult: any = null;
  let lastState: any = null;
  const onFinished = (result: any) => {
    finishedCount++;
    lastResult = result;
  };

  const socketAna = await runPlayer("ana", ana, onFinished);
  const socketBeto = await runPlayer("beto", beto, onFinished);
  socketAna.on("table:state", (s: any) => (lastState = s));

  setTimeout(() => {
    console.log("Iniciando la mano...");
    socketAna.emit("table:start");
  }, 500);

  const deadline = Date.now() + 15_000;
  while (finishedCount === 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
  }

  if (!lastResult) {
    console.log("\nLa mano no terminó dentro del tiempo de espera.");
    process.exit(1);
  }

  console.log("\nResultado de la mano:", lastResult);
  await new Promise((r) => setTimeout(r, 500));

  const stacks: Record<string, number> = lastState?.stacks ?? {};
  const stackValues = Object.values(stacks);
  const totalCents = stackValues.reduce((a, b) => a + b, 0);
  const expectedTotalCents = BUY_IN_EUROS * 100 * 2;

  console.log("Stacks de fichas en la mesa tras la mano:", stacks);

  socketAna.disconnect();
  socketBeto.disconnect();

  if (totalCents !== expectedTotalCents) {
    console.log(`\n❌ FALLO: el total de fichas (${totalCents}) no cuadra con el esperado (${expectedTotalCents})`);
    process.exit(1);
  }
  if (stackValues.every((v) => v === 0)) {
    console.log("\n❌ FALLO: ambos stacks a 0 — el bug ha vuelto");
    process.exit(1);
  }

  console.log("\n✅ OK: el total de fichas cuadra y el ganador se quedó con el doble");
  process.exit(0);
}

main().catch((err) => {
  console.error("Error en el demo:", err);
  process.exit(1);
});
