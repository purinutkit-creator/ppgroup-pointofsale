'use strict';
/**
 * Server-Sent Events hub.
 *
 * Every connected client registers a set of "topics" it cares about and a
 * `render(topic)` function that builds the payload for that client. When data
 * changes, services call `notify(storeId, topics)`; the hub recomputes the
 * payload for each interested client (debounced) and pushes it only if it
 * changed. One-off events (e.g. a queue being called) go through `emit`.
 */

const clients = new Set();
const pending = new Map(); // storeId -> Set(topics)
let flushTimer = null;

function send(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function open(req, res, { storeId, kind, topics = [], render, meta = {} }) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');
  const client = { req, res, storeId, kind, topics: new Set(topics), render, meta, last: new Map() };
  clients.add(client);

  const ping = setInterval(() => res.write(`: ping ${Date.now()}\n\n`), 25000);
  req.on('close', () => {
    clearInterval(ping);
    clients.delete(client);
    if (client.meta.onClose) client.meta.onClose();
  });

  // Initial snapshot for every topic.
  for (const t of client.topics) push(client, t, true);
  return client;
}

function push(client, topic, force = false) {
  try {
    const out = client.render(topic);
    if (!out) return;
    const json = JSON.stringify(out.data);
    if (!force && client.last.get(out.event) === json) return;
    client.last.set(out.event, json);
    client.res.write(`event: ${out.event}\ndata: ${json}\n\n`);
  } catch (err) {
    console.error('[sse] render failed', client.kind, topic, err);
  }
}

function notify(storeId, topics) {
  let set = pending.get(storeId);
  if (!set) pending.set(storeId, (set = new Set()));
  for (const t of [].concat(topics)) set.add(t);
  if (!flushTimer) flushTimer = setTimeout(flush, 40);
}

function flush() {
  flushTimer = null;
  const work = new Map(pending);
  pending.clear();
  for (const client of clients) {
    const topics = work.get(client.storeId);
    if (!topics) continue;
    for (const t of topics) if (client.topics.has(t)) push(client, t);
  }
  for (const fn of listeners) {
    for (const [storeId, topics] of work) fn(storeId, topics);
  }
}

/** Send an event to all clients of a store matching `filter(client)`. */
function emit(storeId, event, data, filter = () => true) {
  for (const client of clients) {
    if (client.storeId !== storeId || !filter(client)) continue;
    send(client.res, event, typeof data === 'function' ? data(client) : data);
  }
}

const listeners = [];
function onFlush(fn) { listeners.push(fn); }

function countClients(filter) {
  let n = 0;
  for (const c of clients) if (filter(c)) n += 1;
  return n;
}

module.exports = { open, notify, emit, onFlush, countClients, send };
