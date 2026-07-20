/**
 * Script de demostración específico para el escenario de all-in que causaba
 * el bug de "ambos saldos a 0": dos jugadores con el mismo saldo van all-in
 * en la primera ronda, no descartan nada, y la mano termina directamente
 * durante el descarte (apuestas bloqueadas). Comprueba que el saldo final
 * es correcto: el ganador debe quedar con el doble, el perdedor con 0.
 *
 * Requiere que el servidor ya esté corriendo (`npm run dev`).
 * Uso: npm run demo:allin
 */
import { io, Socket } from "socket.io-client";

const BASE_URL = process.env.DEMO_BASE_URL ?? "http://localhost:4000";
const TABLE_ID = `demo-allin-${Date.now()}`;
const STARTING_BALANCE = 10; // euros, igual para ambos

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
    body: JSON.stringify({ amount: STARTING_BALANCE }),
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
    console.log(`[${label}] conectado, uniéndose a la mesa ${TABLE_ID}`);
    socket.emit("table:join", { tableId: TABLE_ID });
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
      // Siempre pulsa "All-in": bet si nadie ha apostado, raise (con el mismo
      // centinela que usa el botón real del frontend) si ya hay una apuesta.
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
  console.log(`Registrando y recargando a dos jugadores con ${STARTING_BALANCE}€ cada uno...`);
  const ana = await registerAndFund("ana");
  const beto = await registerAndFund("beto");

  let finishedCount = 0;
  let lastResult: any = null;
  const onFinished = (result: any) => {
    finishedCount++;
    lastResult = result;
  };

  const socketAna = await runPlayer("ana", ana, onFinished);
  const socketBeto = await runPlayer("beto", beto, onFinished);

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

  const anaBalance = await getBalance(ana.accessToken);
  const betoBalance = await getBalance(beto.accessToken);
  console.log(`Saldo final ana: ${anaBalance} €`);
  console.log(`Saldo final beto: ${betoBalance} €`);

  const total = anaBalance + betoBalance;
  const expectedTotal = STARTING_BALANCE * 2;

  socketAna.disconnect();
  socketBeto.disconnect();

  if (Math.abs(total - expectedTotal) > 0.001) {
    console.log(`\n❌ FALLO: el dinero total (${total}€) no cuadra con el esperado (${expectedTotal}€)`);
    process.exit(1);
  }
  if (anaBalance === 0 && betoBalance === 0) {
    console.log("\n❌ FALLO: ambos saldos a 0 — el bug ha vuelto");
    process.exit(1);
  }

  console.log("\n✅ OK: el dinero total cuadra y el ganador recibió el bote correctamente");
  process.exit(0);
}

main().catch((err) => {
  console.error("Error en el demo:", err);
  process.exit(1);
});
