import assert from "node:assert/strict";
import { test } from "node:test";
import { newActionNotices, snapshotOf } from "../src/lib/notification-events.ts";
import type { ActionNotice } from "../src/lib/action-queue.ts";

const notice = (count = 1, priority: ActionNotice["priority"] = "attention", id = "signups"): ActionNotice => ({
  id,
  count,
  priority,
  title: "Inscription à valider",
  text: "Compte en attente",
  to: "/coworking/demandes?type=comptes",
  action: "Ouvrir",
});

test("opening the app with existing urgent work does not create a popup storm", () => assert.deepEqual(newActionNotices(null, [notice(42, "urgent")]), []));
test("polling unchanged work does not repeat a dismissed notification", () => assert.deepEqual(newActionNotices(snapshotOf([notice(2)]), [notice(2)]), []));
test("a new account deserves one notification", () => assert.equal(newActionNotices(snapshotOf([]), [notice()]).length, 1));
test("another account is detected even while the first is still waiting", () => assert.equal(newActionNotices(snapshotOf([notice()]), [notice(2)]).length, 1));
test("resolving work does not trigger a popup", () => {
  assert.deepEqual(newActionNotices(snapshotOf([notice(3)]), [notice(2)]), []);
  assert.deepEqual(newActionNotices(snapshotOf([notice()]), []), []);
});
test("a reservation becoming urgent is surfaced even without a count increase", () =>
  assert.equal(newActionNotices(snapshotOf([notice(2)]), [notice(2, "urgent")]).length, 1));
test("improving priority is silent", () => assert.deepEqual(newActionNotices(snapshotOf([notice(2, "urgent")]), [notice(2)]), []));
test("urgent arrivals take precedence over ordinary arrivals", () =>
  assert.equal(newActionNotices({}, [notice(), notice(1, "urgent", "booking")])[0]?.id, "booking"));
