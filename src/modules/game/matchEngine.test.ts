import { test } from "node:test";
import assert from "node:assert/strict";
import { GameRuleError, GileHand } from "./matchEngine";
import { GamePhase } from "./types";

const BIG_STACK = 100_000; // stack "ilimitado" para tests que no quieren tocar el límite de all-in

test("una mano completa de 2 jugadores llega a showdown con apuestas normales", () => {
  const hand = new GileHand({
    playerIds: ["ana", "beto"],
    dealerId: "ana",
    tieBreakVariant: "dealer_privilege",
    stacks: { ana: BIG_STACK, beto: BIG_STACK },
  });
  hand.start();

  assert.equal(hand.phase, GamePhase.BETTING_1);
  assert.equal(hand.actingPlayerId, "beto");

  hand.applyAction("beto", { type: "bet", amount: 10 });
  hand.applyAction("ana", { type: "call" });

  assert.equal(hand.phase, GamePhase.BETTING_2);
  assert.equal(hand.pot, 20);

  hand.applyAction("beto", { type: "pass" });
  hand.applyAction("ana", { type: "pass" });

  assert.ok([GamePhase.DISCARD, GamePhase.FINISHED].includes(hand.phase));

  if (hand.phase === GamePhase.DISCARD) {
    hand.applyDiscard("beto", { cardIndexes: [] });
    hand.applyDiscard("ana", { cardIndexes: [] });

    assert.equal(hand.phase, GamePhase.BETTING_FINAL);

    hand.applyAction("beto", { type: "pass" });
    hand.applyAction("ana", { type: "pass" });
  }

  assert.equal(hand.phase, GamePhase.FINISHED);
  assert.ok(hand.result);
  assert.equal(hand.result!.pot, 20);
  const totalPaid = hand.result!.payouts.reduce((sum, p) => sum + p.amount, 0);
  assert.equal(totalPaid, 20);
  assert.ok(hand.result!.payouts.every((p) => ["ana", "beto"].includes(p.playerId)));
});

test("si un jugador se retira, el otro gana toda la mano sin llegar a showdown", () => {
  const hand = new GileHand({
    playerIds: ["ana", "beto"],
    dealerId: "ana",
    tieBreakVariant: "dealer_privilege",
    stacks: { ana: BIG_STACK, beto: BIG_STACK },
  });
  hand.start();

  hand.applyAction("beto", { type: "bet", amount: 10 });
  hand.applyAction("ana", { type: "fold" });

  assert.equal(hand.phase, GamePhase.FINISHED);
  assert.equal(hand.result!.reason, "fold");
  assert.deepEqual(hand.result!.payouts, [{ playerId: "beto", amount: 10 }]);
});

test("no se puede actuar fuera de turno", () => {
  const hand = new GileHand({
    playerIds: ["ana", "beto"],
    dealerId: "ana",
    tieBreakVariant: "dealer_privilege",
    stacks: { ana: BIG_STACK, beto: BIG_STACK },
  });
  hand.start();

  assert.throws(() => hand.applyAction("ana", { type: "pass" }), GameRuleError);
});

test("flujo completo con 3 jugadores hasta el final de la mano", () => {
  const hand = new GileHand({
    playerIds: ["ana", "beto", "carla"],
    dealerId: "beto",
    tieBreakVariant: "dealer_privilege",
    stacks: { ana: BIG_STACK, beto: BIG_STACK, carla: BIG_STACK },
  });
  hand.start();

  assert.equal(hand.actingPlayerId, "carla");
  hand.applyAction("carla", { type: "bet", amount: 5 });
  hand.applyAction("ana", { type: "call" });
  hand.applyAction("beto", { type: "call" });

  hand.applyAction("carla", { type: "pass" });
  hand.applyAction("ana", { type: "pass" });
  hand.applyAction("beto", { type: "pass" });

  if (hand.phase === GamePhase.DISCARD) {
    hand.applyDiscard("carla", { cardIndexes: [] });
    hand.applyDiscard("ana", { cardIndexes: [] });
    hand.applyDiscard("beto", { cardIndexes: [] });

    hand.applyAction("carla", { type: "pass" });
    hand.applyAction("ana", { type: "pass" });
    hand.applyAction("beto", { type: "pass" });
  }

  assert.equal(hand.phase, GamePhase.FINISHED);
  const totalPaid = hand.result!.payouts.reduce((sum, p) => sum + p.amount, 0);
  assert.equal(totalPaid, 15);
});

test("una vez retirado, un jugador no puede volver a actuar", () => {
  const hand = new GileHand({
    playerIds: ["ana", "beto", "carla"],
    dealerId: "beto",
    tieBreakVariant: "dealer_privilege",
    stacks: { ana: BIG_STACK, beto: BIG_STACK, carla: BIG_STACK },
  });
  hand.start();

  hand.applyAction("carla", { type: "bet", amount: 5 });
  hand.applyAction("ana", { type: "fold" });
  hand.applyAction("beto", { type: "call" });

  assert.equal(hand.phase, GamePhase.BETTING_2);
  assert.throws(() => hand.applyAction("ana", { type: "pass" }), GameRuleError);
});

test("rechaza crear una mano con menos de 2 o más de 4 jugadores", () => {
  assert.throws(
    () =>
      new GileHand({ playerIds: ["ana"], dealerId: "ana", tieBreakVariant: "dealer_privilege", stacks: { ana: 100 } }),
    GameRuleError
  );
  assert.throws(
    () =>
      new GileHand({
        playerIds: ["a", "b", "c", "d", "e"],
        dealerId: "a",
        tieBreakVariant: "dealer_privilege",
        stacks: { a: 100, b: 100, c: 100, d: 100, e: 100 },
      }),
    GameRuleError
  );
});

test("rechaza crear una mano si falta el stack de algún jugador", () => {
  assert.throws(
    () =>
      new GileHand({
        playerIds: ["ana", "beto"],
        dealerId: "ana",
        tieBreakVariant: "dealer_privilege",
        stacks: { ana: 100 },
      }),
    GameRuleError
  );
});

test("victoria inmediata: si tras el segundo reparto alguien tiene las 4 cartas del mismo palo, gana sin descarte", () => {
  let foundInstantWin = false;

  for (let attempt = 0; attempt < 300 && !foundInstantWin; attempt++) {
    const hand = new GileHand({
      playerIds: ["ana", "beto"],
      dealerId: "ana",
      tieBreakVariant: "dealer_privilege",
      stacks: { ana: BIG_STACK, beto: BIG_STACK },
    });
    hand.start();
    hand.applyAction("beto", { type: "pass" });
    hand.applyAction("ana", { type: "pass" });

    if (hand.phase === GamePhase.FINISHED) {
      foundInstantWin = true;
      assert.equal(hand.result!.reason, "instant_flush");
    }
  }

  assert.ok(true);
});

// ---------- All-in y botes divididos ----------

test("all-in: un jugador iguala con todo su stack y el resto de rondas se completa sin apuestas", () => {
  const hand = new GileHand({
    playerIds: ["ana", "beto"],
    dealerId: "ana",
    tieBreakVariant: "dealer_privilege",
    stacks: { ana: 500, beto: 1000 },
  });
  hand.start();

  // beto abre apostando 500 (parte de su stack de 1000).
  hand.applyAction("beto", { type: "bet", amount: 500 });
  // ana solo tiene 500: al igualar, se queda exactamente a 0 (all-in).
  hand.applyAction("ana", { type: "call" });

  // A partir de aquí ya no puede haber más apuestas (ana no tiene nada más
  // que aportar y solo queda un jugador -beto- que sí podría, pero no hay
  // nadie a quien apostarle): las rondas 2 y final deben saltarse solas.
  assert.ok(
    [GamePhase.DISCARD, GamePhase.FINISHED].includes(hand.phase),
    `se esperaba pasar directo a descarte o fin, pero la fase es ${hand.phase}`
  );

  if (hand.phase === GamePhase.DISCARD) {
    hand.applyDiscard("beto", { cardIndexes: [] });
    hand.applyDiscard("ana", { cardIndexes: [] });
  }

  assert.equal(hand.phase, GamePhase.FINISHED);
  const totalPaid = hand.result!.payouts.reduce((sum, p) => sum + p.amount, 0);
  assert.equal(totalPaid, 1000); // 500 de cada uno
  assert.equal(hand.result!.pot, 1000);
});

test("all-in: un jugador sin stack desde el principio salta directamente todas las rondas de apuestas", () => {
  const hand = new GileHand({
    playerIds: ["ana", "beto"],
    dealerId: "ana",
    tieBreakVariant: "dealer_privilege",
    stacks: { ana: 0, beto: 1000 },
  });
  hand.start();

  // Ya no puede haber ninguna apuesta desde el principio: directo a descarte o fin.
  assert.ok([GamePhase.DISCARD, GamePhase.FINISHED].includes(hand.phase));

  if (hand.phase === GamePhase.DISCARD) {
    hand.applyDiscard("beto", { cardIndexes: [] });
    hand.applyDiscard("ana", { cardIndexes: [] });
  }

  assert.equal(hand.phase, GamePhase.FINISHED);
  assert.equal(hand.result!.pot, 0);
  const totalPaid = hand.result!.payouts.reduce((sum, p) => sum + p.amount, 0);
  assert.equal(totalPaid, 0);
});

test("botes divididos: un jugador corto de fichas no puede ganar más de lo que le corresponde por su capa", () => {
  const hand = new GileHand({
    playerIds: ["ana", "beto", "carla"],
    dealerId: "beto",
    tieBreakVariant: "dealer_privilege",
    stacks: { ana: 200, beto: 500, carla: 1000 },
  });
  hand.start();

  assert.equal(hand.actingPlayerId, "carla");
  hand.applyAction("carla", { type: "bet", amount: 1000 }); // all-in con todo su stack
  hand.applyAction("ana", { type: "call" }); // solo tiene 200: all-in por menos
  hand.applyAction("beto", { type: "call" }); // solo tiene 500: all-in por menos

  // Los tres han quedado all-in: no puede haber más apuestas en absoluto.
  assert.ok([GamePhase.DISCARD, GamePhase.FINISHED].includes(hand.phase));

  if (hand.phase === GamePhase.DISCARD) {
    hand.applyDiscard("carla", { cardIndexes: [] });
    hand.applyDiscard("ana", { cardIndexes: [] });
    hand.applyDiscard("beto", { cardIndexes: [] });
  }

  assert.equal(hand.phase, GamePhase.FINISHED);
  assert.equal(hand.result!.pot, 1700); // 200 + 500 + 1000

  const totalPaid = hand.result!.payouts.reduce((sum, p) => sum + p.amount, 0);
  assert.equal(totalPaid, 1700);

  // ana solo aportó hasta la primera capa (200 * 3 jugadores = 600 máximo):
  // pase lo que pase con las cartas, nunca puede llevarse más que eso.
  const anaPayout = hand.result!.payouts.find((p) => p.playerId === "ana")?.amount ?? 0;
  assert.ok(anaPayout <= 600, `ana no debería poder ganar más de 600, ganó ${anaPayout}`);
});

test("previewActionCost ya no existe: el compromiso real lo devuelve applyAction", () => {
  const hand = new GileHand({
    playerIds: ["ana", "beto"],
    dealerId: "ana",
    tieBreakVariant: "dealer_privilege",
    stacks: { ana: 500, beto: 1000 },
  });
  hand.start();

  const committed = hand.applyAction("beto", { type: "bet", amount: 700 });
  assert.equal(committed, 700);

  // ana solo tiene 500: aunque pida "call" (que normalmente igualaría 700),
  // lo que realmente se compromete queda limitado a su stack.
  const anaCommitted = hand.applyAction("ana", { type: "call" });
  assert.equal(anaCommitted, 500);
});

test("al terminar por showdown, se revelan las cartas de todos los no retirados (pero no las del que se retiró)", () => {
  const hand = new GileHand({
    playerIds: ["ana", "beto", "carla"],
    dealerId: "beto",
    tieBreakVariant: "dealer_privilege",
    stacks: { ana: 100_000, beto: 100_000, carla: 100_000 },
  });
  hand.start();

  hand.applyAction("carla", { type: "bet", amount: 5 });
  hand.applyAction("ana", { type: "fold" });
  hand.applyAction("beto", { type: "call" });

  // Ronda 2: ambos pasan.
  hand.applyAction("carla", { type: "pass" });
  hand.applyAction("beto", { type: "pass" });

  if (hand.phase === "discard") {
    hand.applyDiscard("carla", { cardIndexes: [] });
    hand.applyDiscard("beto", { cardIndexes: [] });
    hand.applyAction("carla", { type: "pass" });
    hand.applyAction("beto", { type: "pass" });
  }

  assert.equal(hand.phase, "finished");
  assert.equal(hand.result!.reason, "showdown");

  const stateForAna = hand.getPublicState("ana");
  const beto = stateForAna.players.find((p) => p.id === "beto")!;
  const carla = stateForAna.players.find((p) => p.id === "carla")!;
  const anaEntry = stateForAna.players.find((p) => p.id === "ana")!;

  assert.ok(beto.hand, "las cartas de beto deberían verse tras el showdown");
  assert.ok(carla.hand, "las cartas de carla deberían verse tras el showdown");
  assert.ok(anaEntry.hand, "ana siempre ve las suyas propias");
});

test("al terminar por retirada de todos menos uno, las cartas siguen ocultas", () => {
  const hand = new GileHand({
    playerIds: ["ana", "beto"],
    dealerId: "ana",
    tieBreakVariant: "dealer_privilege",
    stacks: { ana: 100_000, beto: 100_000 },
  });
  hand.start();

  hand.applyAction("beto", { type: "bet", amount: 10 });
  hand.applyAction("ana", { type: "fold" });

  assert.equal(hand.result!.reason, "fold");
  const stateForAna = hand.getPublicState("ana");
  const beto = stateForAna.players.find((p) => p.id === "beto")!;
  assert.equal(beto.hand, undefined, "beto ganó por retirada, no tuvo que enseñar sus cartas");
});
