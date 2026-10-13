// Onyx: Usage tab: spend and tokens by person, group, model, provider, client or session; the
// day-by-day chart; local energy cost, attributed and unattributed; CSV.
import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import { relativeTime } from "../PeoplePage/relativeTime";
import { StackedBarChart, type BarBucket, type BarSeries } from "../ui/StackedBarChart";
import { fetchEnergy, fetchUsage, fetchUsageDaily, tokens, usd, type EnergySummary, type GroupBy, type UsageRange, type UsageRow } from "./gatewayApi";

const RANGES: { key: UsageRange; label: string }[] = [
  { key: "24h", label: "24 hours" },
  { key: "7d", label: "7 days" },
  { key: "30d", label: "30 days" },
  { key: "all", label: "All" },
];
const GROUPS: { key: GroupBy; label: string }[] = [
  { key: "person", label: "Person" },
  { key: "group", label: "Group" },
  { key: "model", label: "Model" },
  { key: "provider", label: "Provider" },
  { key: "client", label: "Client" },
  { key: "session", label: "Session" },
];
const SERIES: BarSeries[] = [
  { id: "cloud", label: "Cloud (provider keys)", color: "var(--color-accent)" },
  { id: "local", label: "Local energy (estimate)", color: "var(--color-success)" },
];

const totalTok = (r: UsageRow) => r.inTok + r.outTok + r.cacheReadTok + r.cacheWriteTok;

/** CSV of the table as shown. Values are quoted; nothing secret is in usage rows. */
export function usageCsv(groupBy: GroupBy, rows: UsageRow[]): string {
  const q = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const head = [groupBy, "requests", "input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens", "cloud_usd", "local_energy_usd", "subscription_requests", "unpriced_requests", "partial_requests", "last_request"];
  const lines = rows.map((r) =>
    [r.key ?? "", r.requests, r.inTok, r.outTok, r.cacheReadTok, r.cacheWriteTok, r.cloudUsd.toFixed(6), r.localUsd.toFixed(6), r.subscriptionRequests, r.unpricedRequests, r.partialRequests, new Date(r.lastTs).toISOString()].map(q).join(",")
  );
  return [head.join(","), ...lines].join("\n") + "\n";
}

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function UsageTab() {
  const [range, setRange] = useState<UsageRange>("7d");
  const [groupBy, setGroupBy] = useState<GroupBy>("person");
  const [rows, setRows] = useState<UsageRow[] | null>(null);
  const [daily, setDaily] = useState<{ timeZone: string; rows: { day: string; requests: number; tokens: number; cloudUsd: number; localUsd: number }[] } | null>(null);
  const [energy, setEnergy] = useState<EnergySummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    Promise.all([fetchUsage(range, groupBy), fetchUsageDaily(range), fetchEnergy(range)])
      .then(([u, d, e]) => {
        setRows(u.rows);
        setDaily(d);
        setEnergy(e);
        setError(null);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [range, groupBy]);
  useEffect(load, [load]);
  useEffect(() => {
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, [load]);

  const totals = useMemo(() => {
    const t = { requests: 0, tokens: 0, cloud: 0, local: 0, subscription: 0, unpriced: 0, pending: 0 };
    // Group-by-group rows count a request once per group; total from another view when grouping by group.
    for (const r of rows ?? []) {
      t.requests += r.requests;
      t.tokens += totalTok(r);
      t.cloud += r.cloudUsd;
      t.local += r.localUsd;
      t.subscription += r.subscriptionRequests;
      t.unpriced += r.unpricedRequests;
      t.pending += r.localPending;
    }
    return t;
  }, [rows]);

  const buckets: BarBucket[] = useMemo(
    () =>
      (daily?.rows ?? []).map((d) => ({
        key: d.day,
        label: d.day.slice(5),
        title: d.day,
        values: { cloud: d.cloudUsd, local: d.localUsd },
      })),
    [daily]
  );

  return (
    <div className="gw-tab">
      {error ? <p className="gw-bad">{error}</p> : null}
      <div className="gw-section__head gw-controls">
        <div className="seg" role="group" aria-label="Range">
          {RANGES.map((r) => (
            <button key={r.key} type="button" className={r.key === range ? "is-on" : undefined} aria-pressed={r.key === range} onClick={() => setRange(r.key)}>
              {r.label}
            </button>
          ))}
        </div>
        <div className="seg" role="group" aria-label="Group by">
          {GROUPS.map((g) => (
            <button key={g.key} type="button" className={g.key === groupBy ? "is-on" : undefined} aria-pressed={g.key === groupBy} onClick={() => setGroupBy(g.key)}>
              {g.label}
            </button>
          ))}
        </div>
        <button type="button" className="btn btn--sm" disabled={!rows?.length} onClick={() => rows && download(`gateway-usage-${groupBy}-${range}.csv`, usageCsv(groupBy, rows))}>
          CSV
        </button>
      </div>

      {groupBy !== "group" ? (
        <section className="gw-tiles-row" aria-label="Totals">
          <div className="panel gw-stat">
            <span>Total AI spend</span>
            <b>{usd(totals.cloud + totals.local)}</b>
            <em>cloud {usd(totals.cloud)} · local {usd(totals.local)}</em>
          </div>
          <div className="panel gw-stat">
            <span>Requests</span>
            <b>{totals.requests.toLocaleString()}</b>
            <em>{totals.subscription ? `${totals.subscription.toLocaleString()} on own subscriptions` : "none on own subscriptions"}</em>
          </div>
          <div className="panel gw-stat">
            <span>Tokens</span>
            <b>{tokens(totals.tokens)}</b>
            <em>including cached input</em>
          </div>
          <div className="panel gw-stat">
            <span>Local energy, unattributed</span>
            <b>{usd(energy?.unattributedUsd ?? 0)}</b>
            <em>direct use and idle time</em>
          </div>
        </section>
      ) : null}
      {totals.unpriced ? <p className="gw-warn gw-small">{totals.unpriced.toLocaleString()} requests were for models with no price set and count as $0. Set prices on the Models tab.</p> : null}

      <section className="panel gw-section" aria-label="Spend by day">
        <h2 className="gw-h2">Spend by day</h2>
        <StackedBarChart buckets={buckets} series={SERIES} height={220} format={(v) => usd(v)} unit="USD" empty="No spend in this range yet." ariaLabel={`Stacked bar chart of AI spend per day, cloud and local energy, ${range}`} />
        <div className="legend">
          {SERIES.map((s) => (
            <span key={s.id} style={{ "--c": s.color } as CSSProperties}>
              {s.label}
            </span>
          ))}
        </div>
        <p className="gw-muted gw-small">Days follow {daily?.timeZone ?? "the Settings time zone"}.</p>
      </section>

      <section className="panel gw-section" aria-label={`Usage by ${groupBy}`}>
        <h2 className="gw-h2">By {GROUPS.find((g) => g.key === groupBy)?.label.toLowerCase()}</h2>
        {rows && rows.length === 0 ? <p className="gw-muted">No requests in this range. Point a tool at the gateway from the Connect page and they appear here.</p> : null}
        {rows && rows.length ? (
          <div className="gw-scroll">
            <table className="gw-table">
              <thead>
                <tr>
                  <th>{GROUPS.find((g) => g.key === groupBy)?.label}</th>
                  <th className="num">Requests</th>
                  <th className="num">Input</th>
                  <th className="num">Output</th>
                  <th className="num">Cache read</th>
                  <th className="num">Cloud</th>
                  <th className="num">Local energy</th>
                  <th>Last</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.key ?? "(none)"}>
                    <td className={groupBy === "session" || groupBy === "model" ? "mono" : undefined}>{r.key ?? <span className="gw-muted">{groupBy === "session" ? "No session ID" : "Unknown"}</span>}</td>
                    <td className="num">{r.requests.toLocaleString()}</td>
                    <td className="num">{tokens(r.inTok + r.cacheWriteTok)}</td>
                    <td className="num">{tokens(r.outTok)}</td>
                    <td className="num">{tokens(r.cacheReadTok)}</td>
                    <td className="num">
                      {r.cloudUsd ? usd(r.cloudUsd) : r.unpricedRequests ? <span className="gw-chip gw-chip--warn">No price set</span> : r.subscriptionRequests === r.requests ? <span className="gw-muted">Subscription</span> : "-"}
                    </td>
                    <td className="num">{r.localUsd ? usd(r.localUsd) : r.localPending ? <span className="gw-muted" title="Local costs settle within about 2 minutes">Estimating…</span> : "-"}</td>
                    <td>{relativeTime(r.lastTs)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
        {groupBy === "group" ? <p className="gw-muted gw-small">A person in several groups counts in each, so group rows can add up to more than the total.</p> : null}
      </section>

      <section className="panel gw-section" aria-label="Local energy cost">
        <h2 className="gw-h2">Local energy cost (estimate)</h2>
        {!energy || energy.byMachine.length === 0 ? (
          <p className="gw-muted">No energy readings yet. Switch on a local server under Models, and set an electricity price in Settings → Energy.</p>
        ) : (
          <>
            {energy.rate == null || energy.minutesWithoutRate ? <p className="gw-warn gw-small">Set an electricity price in Settings → Energy to cost local requests. It is read as US dollars per kWh.</p> : null}
            <div className="gw-scroll">
              <table className="gw-table">
                <thead>
                  <tr>
                    <th>Machine</th>
                    <th className="num">Energy</th>
                    <th className="num">Cost</th>
                    <th className="num">Through the gateway</th>
                    <th className="num">Unattributed</th>
                    <th className="num">Gateway share of tokens</th>
                  </tr>
                </thead>
                <tbody>
                  {energy.byMachine.map((m) => (
                    <tr key={m.machine}>
                      <td>{m.machine}</td>
                      <td className="num">{(m.wh / 1000).toFixed(2)} kWh</td>
                      <td className="num">{usd(m.costUsd)}</td>
                      <td className="num">{usd(m.attributedUsd)}</td>
                      <td className="num">{usd(m.unattributedUsd)}</td>
                      <td className="num">{m.serverTokens || m.gatewayTokens ? `${Math.round((100 * m.gatewayTokens) / Math.max(m.serverTokens, m.gatewayTokens))}%` : "-"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="gw-muted gw-small">
              Each minute's measured energy × {energy.rate != null ? `$${energy.rate}/kWh` : "the electricity price"} is split across the gateway's requests on that machine by their share of the tokens it processed. Tokens used directly (not through the gateway) and idle time stay unattributed. Settles within about 2 minutes.
            </p>
          </>
        )}
      </section>
    </div>
  );
}
