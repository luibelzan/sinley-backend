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
