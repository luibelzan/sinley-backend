/**
 * Script de demostración end-to-end del paso 5: registra dos usuarios,
 * los recarga, los conecta por WebSocket, juegan una mesa completa con
 * decisiones automáticas simples, y muestra cómo se mueve el saldo real
 * de cada uno. Requiere que el servidor ya esté corriendo (`npm run dev`).
 *
 * Uso: npm run demo:table
 */
import { io, Socket } from "socket.io-client";

const BASE_URL = process.env.DEMO_BASE_URL ?? "http://localhost:4000";
const TABLE_ID = `demo-table-${Date.now()}`;

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
  if (!registerRes.ok) {
    throw new Error(`No se pudo registrar ${username}: ${await registerRes.text()}`);
  }
  const registerData = (await registerRes.json()) as { user: { id: string }; accessToken: string };

  const rechargeRes = await fetch(`${BASE_URL}/wallet/recharge`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${registerData.accessToken}`,
    },
    body: JSON.stringify({ amount: 50 }),
  });
  if (!rechargeRes.ok) {
    throw new Error(`No se pudo recargar a ${username}: ${await rechargeRes.text()}`);
  }

  return { userId: registerData.user.id, accessToken: registerData.accessToken };
}

async function getBalance(accessToken: string): Promise<number> {
  const res = await fetch(`${BASE_URL}/wallet/me`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const data = (await res.json()) as { balance: number };
  return data.balance;
}

function decideAction(state: any, myUserId: string): { type: string; amount?: number } | null {
  const hand = state.hand;
  if (!hand || hand.actingPlayerId !== myUserId) return null;
  const bettingPhases = ["betting_1", "betting_2", "betting_final"];
  if (!bettingPhases.includes(hand.phase)) return null;

  const me = hand.players.find((p: any) => p.id === myUserId);
  if (hand.currentBetToMatch === 0) return { type: "bet", amount: 100 };
  if (me.currentRoundBet < hand.currentBetToMatch) return { type: "call" };
  return { type: "pass" };
}

async function runPlayer(label: string, user: AuthedUser, onFinished: (result: any) => void): Promise<Socket> {
  const socket = io(BASE_URL, { auth: { token: user.accessToken } });
  const discardedInPhase = new Set<string>();

  socket.on("connect", () => {
    console.log(`[${label}] conectado, uniéndose a la mesa ${TABLE_ID}`);
    socket.emit("table:join", { tableId: TABLE_ID });
  });

  socket.on("table:error", (err: { message: string }) => {
    console.log(`[${label}] error:`, err.message);
  });

  socket.on("table:state", (state: any) => {
    if (!state.hand) return;

    if (state.hand.phase === "discard" && !discardedInPhase.has("discard")) {
      discardedInPhase.add("discard");
      setTimeout(() => socket.emit("hand:discard", { cardIndexes: [] }), 150);
    }
    if (state.hand.phase !== "discard") {
      discardedInPhase.delete("discard");
    }

    const action = decideAction(state, user.userId);
    if (action) {
      console.log(`[${label}] fase=${state.hand.phase} pot=${state.hand.pot} -> ${JSON.stringify(action)}`);
      setTimeout(() => socket.emit("hand:action", action), 150);
    }

    if (state.hand.phase === "finished" && state.hand.result) {
      onFinished(state.hand.result);
    }
  });

  await new Promise<void>((resolve) => socket.on("connect", () => resolve()));
  return socket;
}

async function main() {
  console.log("Registrando y recargando a dos jugadores de prueba...");
  const ana = await registerAndFund("ana");
  const beto = await registerAndFund("beto");

  console.log(`Saldo inicial ana: ${await getBalance(ana.accessToken)}`);
  console.log(`Saldo inicial beto: ${await getBalance(beto.accessToken)}`);

  let finishedCount = 0;
  let lastResult: any = null;

  const onFinished = (result: any) => {
    finishedCount++;
    lastResult = result;
  };

  const socketAna = await runPlayer("ana", ana, onFinished);
  const socketBeto = await runPlayer("beto", beto, onFinished);

  // Cuando ambos se hayan unido, cualquiera de los dos puede iniciar la mano.
  setTimeout(() => {
    console.log("Iniciando la mano...");
    socketAna.emit("table:start");
  }, 500);

  // Esperamos a que la mano termine (con margen de sobra) y cerramos.
  const deadline = Date.now() + 15_000;
  while (finishedCount === 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
  }

  if (lastResult) {
    console.log("\nResultado de la mano:", lastResult);
  } else {
    console.log("\nLa mano no terminó dentro del tiempo de espera del demo.");
  }

  console.log(`Saldo final ana: ${await getBalance(ana.accessToken)}`);
  console.log(`Saldo final beto: ${await getBalance(beto.accessToken)}`);

  socketAna.disconnect();
  socketBeto.disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error("Error en el demo:", err);
  process.exit(1);
});
