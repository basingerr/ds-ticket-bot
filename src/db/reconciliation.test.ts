import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const folder = mkdtempSync(join(tmpdir(), "ticket-reconcile-"));
process.env.DATABASE_URL = `file:${join(folder, "test.sqlite")}`;
for (const key of ["DISCORD_TOKEN", "DISCORD_CLIENT_ID", "DISCORD_GUILD_ID", "DISCORD_FORUM_CHANNEL_ID", "TRELLO_KEY", "TRELLO_TOKEN", "TRELLO_BOARD_ID", "TRELLO_INBOX_LIST_ID", "PUBLIC_BASE_URL"]) {
  process.env[key] = "test";
}
const { db, initDatabase, closeDatabase } = await import("./database.js");
const { createTicketLink, listDueTicketLinks, deferReconciliation } = await import("./ticketLinks.js");

test("bounded batches prioritize fresh work without starving old work; deadlines persist", async () => {
  try {
    initDatabase(); initDatabase();
    for (let i = 0; i < 100; i++) {
      const link = createTicketLink({discordGuildId:"g", discordChannelId:"c", discordThreadId:String(i), trelloCardId:String(i), status:"New"});
      if (i < 50) db.prepare("UPDATE ticket_links SET created_at = ? WHERE id = ?").run("2020-01-01T00:00:00.000Z", link.id);
    }
    const now = Date.now();
    const first = listDueTicketLinks(now);
    assert.equal(first.length, 40);
    assert.equal(first.filter(l => Number(l.trelloCardId) >= 50).length, 20);
    for (const link of first) deferReconciliation(link.id, now + 86400000);
    initDatabase();
    const second = listDueTicketLinks(now);
    assert.equal(second.length, 40);
    assert.ok(second.every(l => !first.some(previous => previous.id === l.id)));
    for (const link of second) deferReconciliation(link.id, now + 86400000);
    assert.equal(listDueTicketLinks(now).length, 20);
    assert.equal(listDueTicketLinks(now + 86400000).length, 40);
    db.prepare("DELETE FROM ticket_links").run();
    const completed = createTicketLink({discordGuildId:"g", discordChannelId:"c", discordThreadId:"completed", trelloCardId:"completed", status:"Готово"});
    const originalFetch = globalThis.fetch;
    let requests = 0;
    let discordReads = 0;
    globalThis.fetch = (async (url: string) => {
      requests++;
      return new Response(JSON.stringify(url.includes("/cards/")
        ? {id:"completed", idList:"done", name:"ticket", closed:true, dueComplete:true}
        : {id:"done", name:"Готово"}));
    }) as typeof fetch;
    try {
      const { runReconciliation } = await import("../reconcile.js");
      const client = {channels:{fetch: async () => {
        discordReads++;
        return {isThread: () => true, archived:true};
      }}};
      await Promise.all([runReconciliation(client as never), runReconciliation(client as never)]);
      assert.equal(requests, 2, "overlapping runs must not duplicate requests");
      assert.equal(discordReads, 1, "already archived thread requires no Discord writes");
      assert.equal(listDueTicketLinks(Date.now()).length, 0);
      const row = db.prepare("SELECT reconcile_after FROM ticket_links WHERE id = ?").get(completed.id) as {reconcile_after:number};
      assert.ok(row.reconcile_after >= now + 86400000);
    } finally { globalThis.fetch = originalFetch; }

  } finally {
    closeDatabase(); rmSync(folder, {recursive:true, force:true});
  }
});
