// Onyx: per-minute energy for the Gateway's local cost. Each closed minute, for every machine that
// hosts a local model server, send the Gateway the machine's measured energy (from the fleet energy
// tracker's minute buckets; a cluster head carries its workers' energy) and the tokens its servers
// processed that minute (from the servers' own counters), with the electricity rate and time zone
// from Settings. Unsent minutes are kept and retried, up to an hour of them.
import { extractTokenObservations } from "../llmtokens/LlmTokenLedger.js";

const MINUTE_MS = 60_000;
/** A minute is sent once the tracker has had time to close it (it samples every 2 s). */
const CLOSE_AFTER_MS = 5_000;
/** Server token counters further apart than this rebase instead of counting a delta. */
const MAX_COUNTER_GAP_MS = 90_000;
const MAX_QUEUE = 60;

/**
 * The fleet energy tracker keeps per-node Wh in one-minute buckets. It has no public per-minute
 * read, so this reads its bucket map; if that ever changes shape, local cost simply stops (the
 * AI Gateway page then shows no energy data) and the bridge test fails.
 * @returns {Record<string, number> | null} node id -> Wh, or null when there's no bucket
 */
export function minuteWh(tracker, minute) {
  const b = tracker?._buckets?.get?.(minute);
  if (!b || typeof b.nodeWh !== "object") return null;
  const out = {};
  for (const [id, wh] of Object.entries(b.nodeWh)) if ((b.nodeCoverageMs?.[id] ?? 1) > 0 && Number.isFinite(wh)) out[id] = wh;
  return out;
}

/**
 * @param {object} deps
 * @param {object} deps.tracker                  FleetEnergyTracker
 * @param {() => object[]} deps.orderedSnapshots
 * @param {{ getSpark: (id: string) => object }} deps.registry
 * @param {() => { energyPricePerKwh: number | null, timeZone: string }} deps.getSettings
 * @param {{ call: Function }} deps.client
 * @param {() => number} [deps.now]
 */
export function createEnergyPusher({ tracker, orderedSnapshots, registry, getSettings, client, now = Date.now }) {
  /** sparkId:port -> { prompt, output, at } */
  const counters = new Map();
  /** minute -> Map(machine name -> tokens) */
  const tokens = new Map();
  let lastMinuteSent = Math.floor(now() / MINUTE_MS) * MINUTE_MS - MINUTE_MS;
  let queue = [];

  /** Machines with a local model server, and the node ids whose energy each one carries. */
  function machines() {
    const snaps = orderedSnapshots();
    const byId = new Map(snaps.map((s) => [s.id, s]));
    const out = new Map();
    for (const s of snaps) {
      if (!(s.metrics?.llm || []).some((m) => m?.port && (m.available || (m.models || []).length))) continue;
      out.set(s.id, { name: s.name || s.id, nodes: [s.id] });
    }
    for (const s of snaps) {
      const head = registry.getSpark(s.id)?.workerHeadId;
      if (head && head !== s.id && out.has(head) && byId.has(s.id)) out.get(head).nodes.push(s.id);
    }
    return out;
  }

  /** Every 15 s: credit each server's counter growth to the current minute, by machine. */
  function sample() {
    const t = now();
    const minute = Math.floor(t / MINUTE_MS) * MINUTE_MS;
    const names = new Map(orderedSnapshots().map((s) => [s.id, s.name || s.id]));
    for (const o of extractTokenObservations(orderedSnapshots())) {
      const key = `${o.sparkId}:${o.port}`;
      const prev = counters.get(key);
      const cur = { prompt: o.prompt ?? 0, output: o.output, at: t };
      counters.set(key, cur);
      if (!prev || t - prev.at > MAX_COUNTER_GAP_MS) continue;
      const d = Math.max(0, cur.prompt - prev.prompt) + Math.max(0, cur.output - prev.output);
      // A counter that went backwards is a restart: rebase, credit nothing.
      if (cur.output < prev.output || d === 0) continue;
      const m = tokens.get(minute) || new Map();
      const name = names.get(o.sparkId) || o.sparkId;
      m.set(name, (m.get(name) || 0) + d);
      tokens.set(minute, m);
    }
  }

  /** Queue every closed minute not sent yet, then send the queue. */
  async function push() {
    const t = now();
    const closed = Math.floor((t - CLOSE_AFTER_MS) / MINUTE_MS) * MINUTE_MS - MINUTE_MS;
    const ms = machines();
    for (let minute = Math.max(lastMinuteSent + MINUTE_MS, closed - MAX_QUEUE * MINUTE_MS); minute <= closed; minute += MINUTE_MS) {
      const wh = minuteWh(tracker, minute);
      const tk = tokens.get(minute);
      if (wh) {
        for (const { name, nodes } of ms.values()) {
          const measured = nodes.filter((id) => id in wh);
          if (!measured.length) continue;
          queue.push({ machine: name, minute, wh: measured.reduce((n, id) => n + wh[id], 0), serverTokens: tk?.get(name) || 0 });
        }
      }
      tokens.delete(minute);
      lastMinuteSent = minute;
    }
    for (const k of tokens.keys()) if (k < closed - MAX_QUEUE * MINUTE_MS) tokens.delete(k);
    if (queue.length > MAX_QUEUE * 50) queue = queue.slice(-MAX_QUEUE * 50);
    const s = getSettings() || {};
    const timeZone = s.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    const rate = Number.isFinite(s.energyPricePerKwh) ? s.energyPricePerKwh : null;
    try {
      const r = await client.call("POST", "/internal/energy", { timeZone, rate, minutes: queue });
      if (r.status === 200) queue = [];
    } catch {
      /* the Gateway is down: the minutes wait for it */
    }
  }

  return { sample, push, machines, get queued() {
    return queue.length;
  } };
}
