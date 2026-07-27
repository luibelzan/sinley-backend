import { test } from "node:test";
import assert from "node:assert/strict";
import { Table, TableError } from "./table";
import { GamePhase } from "../game/types";

test("una mesa nueva respeta la capacidad y el importe de ficha fijo", () => {
  const table = new Table("t1", { capacity: 2, buyInCents: 1000 });
  table.seatPlayerWithStack("ana", 1000);
  table.seatPlayerWithStack("beto", 1000);

  assert.equal(table.stacks.get("ana"), 1000);
  assert.equal(table.stacks.get("beto"), 1000);
  assert.throws(() => table.seatPlayerWithStack("carla", 1000), TableError);
});

test("rechaza crear una mesa con capacidad fuera de rango o buy-in inválido", () => {
  assert.throws(() => new Table("t", { capacity: 1, buyInCents: 1000 }), TableError);
  assert.throws(() => new Table("t", { capacity: 5, buyInCents: 1000 }), TableError);
  assert.throws(() => new Table("t", { capacity: 2, buyInCents: 0 }), TableError);
});

test("el stack persiste entre manos: el ganador sube, el perdedor baja, no se reinicia al importe fijo", () => {
  const table = new Table("t2", { capacity: 2, buyInCents: 1000 });
  table.seatPlayerWithStack("ana", 1000);
  table.seatPlayerWithStack("beto", 1000);

  const hand = table.startHand();
  assert.equal(hand.actingPlayerId, "beto"); // siguiente al repartidor (ana)

  hand.applyAction("beto", { type: "bet", amount: 999_999_999 }); // all-in
  hand.applyAction("ana", { type: "raise", amount: 999_999_999 }); // all-in también

  // Con ambos all-in por el mismo importe, la mano se resuelve sola hasta el
  // descarte — salvo que a alguien le toque un póker de palo por casualidad
  // en el reparto, en cuyo caso termina ya mismo (instant_flush).
  assert.ok(
    [GamePhase.DISCARD, GamePhase.FINISHED].includes(hand.phase),
    `se esperaba descarte o fin, pero la fase es ${hand.phase}`
  );
  if (hand.phase === GamePhase.DISCARD) {
    hand.applyDiscard("beto", { cardIndexes: [] });
    hand.applyDiscard("ana", { cardIndexes: [] });
  }

  assert.equal(hand.phase, GamePhase.FINISHED);
  table.finishHandCleanup();

  const anaStack = table.stacks.get("ana")!;
  const betoStack = table.stacks.get("beto")!;

  // El bote total (2000) se reparte entero entre los dos: nada se pierde ni se inventa.
  assert.equal(anaStack + betoStack, 2000);
  // Uno de los dos se queda a 0 (perdió toda la mano) y el otro con el doble.
  assert.ok((anaStack === 0 && betoStack === 2000) || (anaStack === 2000 && betoStack === 0));

  // La mesa NO puede empezar otra mano todavía: con solo 2 jugadores y uno de
  // ellos a 0 fichas, hace falta que recompre antes de poder seguir jugando.
  assert.equal(table.canStartHand(), false);
  const loserId = anaStack === 0 ? "ana" : "beto";
  assert.equal(table.canRebuy(loserId), true);
});

test("un jugador que se queda a 0 fichas puede volver a comprar, pero no antes de tiempo", () => {
  const table = new Table("t3", { capacity: 2, buyInCents: 500 });
  table.seatPlayerWithStack("ana", 500);
  table.seatPlayerWithStack("beto", 500);

  assert.equal(table.canRebuy("ana"), false); // todavía tiene fichas

  table.stacks.set("ana", 0); // simulamos que perdió todo
  assert.equal(table.canRebuy("ana"), true);

  table.rebuy("ana");
  assert.equal(table.stacks.get("ana"), 500);
  assert.throws(() => table.rebuy("ana"), TableError); // ya no puede, no está a 0
});

test("no se puede iniciar una mano si no hay al menos 2 jugadores CON fichas", () => {
  const table = new Table("t4", { capacity: 2, buyInCents: 500 });
  table.seatPlayerWithStack("ana", 500);
  table.seatPlayerWithStack("beto", 0); // sin fichas, pendiente de rebuy

  assert.equal(table.canStartHand(), false);
  assert.throws(() => table.startHand(), TableError);
});

test("al salir de la mesa sin mano en curso, se pierden las fichas que quedaran (no se devuelven)", () => {
  const table = new Table("t5", { capacity: 2, buyInCents: 500 });
  table.seatPlayerWithStack("ana", 500);
  table.seatPlayerWithStack("beto", 500);

  table.removePlayer("ana");
  assert.equal(table.stacks.has("ana"), false);
  assert.equal(table.seatOrder.includes("ana"), false);
});

test("la partida no se da por terminada antes de haber jugado ninguna mano", () => {
  const table = new Table("t6", { capacity: 2, buyInCents: 500 });
  table.seatPlayerWithStack("ana", 500);
  // Todavía no se ha unido nadie más: solo 1 jugador con fichas, pero como
  // el juego nunca ha empezado, esto NO es "fin de partida".
  assert.equal(table.isGameOver(), false);
});

test("la partida se da por terminada cuando, tras jugar, ya no queda más de un jugador con fichas", () => {
  const table = new Table("t7", { capacity: 2, buyInCents: 500 });
  table.seatPlayerWithStack("ana", 500);
  table.seatPlayerWithStack("beto", 500);

  const hand = table.startHand();
  hand.applyAction("beto", { type: "bet", amount: 999_999 }); // all-in
  hand.applyAction("ana", { type: "raise", amount: 999_999 }); // all-in también

  if (hand.phase === GamePhase.DISCARD) {
    hand.applyDiscard("beto", { cardIndexes: [] });
    hand.applyDiscard("ana", { cardIndexes: [] });
  }
  assert.equal(hand.phase, GamePhase.FINISHED);
  table.finishHandCleanup();

  // Con capacidad 2 y uno de los dos a 0 fichas, ya no puede continuar.
  assert.equal(table.isGameOver(), true);

  const standings = table.getFinalStandings();
  assert.equal(standings.length, 2);
  assert.equal(standings[0]!.position, 1);
  assert.equal(standings[1]!.position, 2);
  // El de la posición 1 tiene más fichas que el de la 2.
  assert.ok(standings[0]!.finalStackCents > standings[1]!.finalStackCents);
  // Las ganancias netas de todos suman 0 (nadie mete ni saca dinero de fuera del bote).
  const totalNet = standings.reduce((sum, s) => sum + s.netCents, 0);
  assert.equal(totalNet, 0);
  // El ganador tiene +500 de neto (dobló su buy-in), el perdedor -500.
  assert.equal(standings[0]!.netCents, 500);
  assert.equal(standings[1]!.netCents, -500);
});

test("al salir de la mesa se olvida el historial de compras: una mesa reciclada no arrastra el buy-in de una sesión anterior", () => {
  const table = new Table("t8", { capacity: 2, buyInCents: 1000 });
  table.seatPlayerWithStack("ana", 1000);
  table.seatPlayerWithStack("beto", 1000);
  assert.equal(table.totalBuyIns.get("ana"), 1000);

  // Ana se va (p. ej. tras terminar una partida y pulsar "Volver al panel").
  table.removePlayer("ana");
  table.removePlayer("beto");
  assert.equal(table.totalBuyIns.has("ana"), false);
  assert.equal(table.totalBuyIns.has("beto"), false);

  // La misma mesa (reciclada) se usa para una partida nueva: el buy-in debe
  // contar desde 0, no sumarse al de la sesión anterior.
  table.seatPlayerWithStack("ana", 1000);
  table.seatPlayerWithStack("beto", 1000);
  assert.equal(table.totalBuyIns.get("ana"), 1000);
  assert.equal(table.totalBuyIns.get("beto"), 1000);
});

test("regresión: el neto de la clasificación final es correcto tras reciclar la mesa (antes se duplicaba)", () => {
  let table = new Table("t9", { capacity: 2, buyInCents: 1000 });
  table.seatPlayerWithStack("ana", 1000);
  table.seatPlayerWithStack("beto", 1000);
  // Simulamos que ya jugaron una vez y se fueron sin que la mesa se destruya
  // (las mesas públicas no se borran nunca, solo se vacían).
  table.removePlayer("ana");
  table.removePlayer("beto");

  // Nueva partida en la misma mesa reciclada.
  table.seatPlayerWithStack("ana", 1000);
  table.seatPlayerWithStack("beto", 1000);

  const hand = table.startHand();
  hand.applyAction("beto", { type: "bet", amount: 999_999 });
  hand.applyAction("ana", { type: "raise", amount: 999_999 });
  if (hand.phase === GamePhase.DISCARD) {
    hand.applyDiscard("beto", { cardIndexes: [] });
    hand.applyDiscard("ana", { cardIndexes: [] });
  }
  table.finishHandCleanup();

  const standings = table.getFinalStandings();
  const totalNet = standings.reduce((sum, s) => sum + s.netCents, 0);
  assert.equal(totalNet, 0); // el neto de todos siempre debe sumar 0
  for (const s of standings) {
    // Con un solo buy-in de 1000 por cabeza, nadie puede ganar/perder más de 1000.
    assert.ok(
      Math.abs(s.netCents) <= 1000,
      `el neto de ${s.userId} es ${s.netCents}, no debería superar el buy-in de 1000`
    );
  }
});

test("settleGameOverPayouts congela la clasificación y pone a 0 los stacks (ya 'cobrados')", () => {
  const table = new Table("t10", { capacity: 2, buyInCents: 1000 });
  table.seatPlayerWithStack("ana", 1000);
  table.seatPlayerWithStack("beto", 1000);

  const hand = table.startHand();
  hand.applyAction("beto", { type: "bet", amount: 999_999 });
  hand.applyAction("ana", { type: "raise", amount: 999_999 });
  if (hand.phase === GamePhase.DISCARD) {
    hand.applyDiscard("beto", { cardIndexes: [] });
    hand.applyDiscard("ana", { cardIndexes: [] });
  }
  table.finishHandCleanup();
  assert.equal(table.isGameOver(), true);
  assert.equal(table.cachedStandings, null); // todavía no se ha liquidado

  const winnerId = table.stacks.get("ana") === 0 ? "beto" : "ana";
  const winnerStackBefore = table.stacks.get(winnerId)!;
  assert.equal(winnerStackBefore, 2000); // se llevó el bote completo

  const standings = table.settleGameOverPayouts();
  // La clasificación devuelta refleja el stack ANTES de ponerlo a 0.
  const winnerEntry = standings.find((s) => s.userId === winnerId)!;
  assert.equal(winnerEntry.finalStackCents, 2000);

  // Pero en la mesa, los stacks ya quedan a 0: ese dinero ya se ha "cobrado"
  // (la capa de sockets es quien de verdad lo abona al wallet).
  assert.equal(table.stacks.get("ana"), 0);
  assert.equal(table.stacks.get("beto"), 0);

  // Y queda congelada para futuras consultas.
  assert.equal(table.cachedStandings, standings);
});

test("una recompra tras el fin de partida olvida la clasificación congelada (la partida revive de verdad)", () => {
  const table = new Table("t11", { capacity: 2, buyInCents: 1000 });
  table.seatPlayerWithStack("ana", 1000);
  table.seatPlayerWithStack("beto", 1000);

  const hand = table.startHand();
  hand.applyAction("beto", { type: "bet", amount: 999_999 });
  hand.applyAction("ana", { type: "raise", amount: 999_999 });
  if (hand.phase === GamePhase.DISCARD) {
    hand.applyDiscard("beto", { cardIndexes: [] });
    hand.applyDiscard("ana", { cardIndexes: [] });
  }
  table.finishHandCleanup();
  table.settleGameOverPayouts();
  assert.ok(table.cachedStandings);

  const loserId = table.stacks.get("ana") === 0 ? "ana" : "beto";
  table.rebuy(loserId);
  assert.equal(table.cachedStandings, null);
});
