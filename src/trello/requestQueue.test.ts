import test from "node:test";
import assert from "node:assert/strict";
import { TrelloRequestQueue } from "./requestQueue.js";

test("concurrent traffic shares one paced budget", async () => {
  let now = 0;
  const starts: number[] = [];
  const queue = new TrelloRequestQueue((async () => {
    starts.push(now); return new Response("{}");
  }) as typeof fetch, () => now, async ms => { now += ms; });
  await Promise.all(Array.from({length: 60}, () => queue.request("https://example.com")));
  assert.equal(starts.length, 60);
  assert.ok(starts.every((time, i) => i === 0 || time - starts[i - 1] >= 250));
});

test("429 pauses all callers and retries are bounded", async () => {
  let now = 0;
  const starts: number[] = [];
  const queue = new TrelloRequestQueue((async () => {
    starts.push(now); return new Response("limited", {status: 429});
  }) as typeof fetch, () => now, async ms => { now += ms; });
  assert.equal((await queue.request("https://example.com")).status, 429);
  assert.deepEqual(starts, [0, 10000, 30000]);
  await queue.request("https://example.com");
  assert.equal(starts[3], 70000);
});

test("ambiguous POST failures are not retried and do not poison queue", async () => {
  let calls = 0;
  const queue = new TrelloRequestQueue((async () => {
    if (++calls === 1) throw new Error("connection lost");
    return new Response("{}");
  }) as typeof fetch, () => 0, async () => {});
  await assert.rejects(queue.request("https://example.com", {method: "POST"}));
  await queue.request("https://example.com");
  assert.equal(calls, 2);
});
