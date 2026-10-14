// Onyx: on the Token totals page, the share of local model traffic that came through the AI gateway:
// requests, people and tokens per local model, with its energy cost. Hidden when the gateway has none.
import { useEffect, useState } from "react";
import { fetchLocalUsage, tokens, usd } from "./gatewayApi";
import "./gateway.css";

const SPAN: Record<string, number | null> = { "24h": 86_400_000, "7d": 7 * 86_400_000, "14d": 14 * 86_400_000, "30d": 30 * 86_400_000, all: null };

type Row = { model: string; requests: number; people: number; promptTokens: number; completionTokens: number; energyUsd: number };

export function GatewayTokenFeed({ range, phrase }: { range: string; phrase: string }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  useEffect(() => {
    let live = true;
    const span = SPAN[range] ?? null;
    const load = () =>
      fetchLocalUsage(span == null ? 0 : Date.now() - span).then(
        (r) => live && setRows(r.models),
        () => live && setRows(null)
      );
    void load();
    const t = setInterval(load, 60_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [range]);
  if (!rows || rows.length === 0) return null;
  return (
    <section className="panel tk-card" aria-labelledby="tk-gateway-title">
      <div className="tk-card__head">
        <div>
          <h2 id="tk-gateway-title" className="tk-card__title">
            Through the AI gateway
          </h2>
          <p className="tk-card__sub">Requests to local models that came through the AI gateway in {phrase}. They're already part of the totals above; this shows who sent them.</p>
        </div>
      </div>
      <div className="gw-scroll">
        <table className="gw-table">
          <thead>
            <tr>
              <th>Model</th>
              <th className="num">Requests</th>
              <th className="num">People</th>
              <th className="num">Prompt</th>
              <th className="num">Generated</th>
              <th className="num">Energy cost</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.model}>
                <td className="mono">{r.model}</td>
                <td className="num">{r.requests.toLocaleString()}</td>
                <td className="num">{r.people}</td>
                <td className="num">{tokens(r.promptTokens)}</td>
                <td className="num">{tokens(r.completionTokens)}</td>
                <td className="num">{r.energyUsd ? `${usd(r.energyUsd)} est.` : "-"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
