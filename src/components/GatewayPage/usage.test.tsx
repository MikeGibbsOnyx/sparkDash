import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { flush, render } from "../../testing/render";
import { BudgetsSection, GrantsSection, budgetUsedText, scopeLabel } from "./AccessEditors";
import { UsageTab, usageCsv } from "./UsageTab";
import { tokens, usd, type Budget, type Grant, type UsageRow } from "./gatewayApi";
import { budgetLine } from "../../connect/ConnectPage";

const budget: Budget = {
  id: 1,
  name: "Sam monthly",
  scope: "person:sam@onyx.test",
  period: "month",
  limitUsd: 50,
  limitTokens: null,
  warnPct: 80,
  spentUsd: 50,
  spentTokens: 120_000,
  inFlightUsd: 0,
  periodStart: 0,
  resetsAt: 0,
  resets: "Nov 1",
  state: "exhausted",
  updatedBy: "mike",
  updatedAt: Date.now(),
};

const row: UsageRow = { key: "sam@onyx.test", requests: 3, inTok: 100, outTok: 50, cacheReadTok: 1000, cacheWriteTok: 0, cloudUsd: 0.0123, localUsd: 0.001, subscriptionRequests: 0, unpricedRequests: 0, localPending: 0, partialRequests: 1, lastTs: Date.UTC(2026, 9, 13) };

describe("formatting", () => {
  it("money and tokens read plainly", () => {
    expect(usd(0)).toBe("$0");
    expect(usd(12.3)).toBe("$12.30");
    expect(usd(0.0042)).toBe("$0.0042");
    expect(tokens(1_234_567)).toBe("1.2M");
    expect(tokens(34_000)).toBe("34k");
    expect(scopeLabel("everyone")).toBe("Everyone");
    expect(scopeLabel("group:eng")).toBe("Group eng");
    expect(scopeLabel("key:ci")).toBe("Gateway key ci");
    expect(budgetUsedText(budget)).toBe("$50.00 of $50.00");
  });

  it("the Connect page names the budget and its reset", () => {
    expect(budgetLine(budget)).toBe("Budget Sam monthly is used up: $50.00 of $50.00. Requests are refused until it resets Nov 1.");
    expect(budgetLine({ ...budget, state: "ok", spentUsd: 12.3 })).toBe("Budget Sam monthly: $12.30 of $50.00 this month. Resets Nov 1.");
  });

  it("CSV has a header and one quoted row per group", () => {
    const csv = usageCsv("person", [row]).trim().split("\n");
    expect(csv[0]).toMatch(/^person,requests,input_tokens/);
    expect(csv[1]).toContain('"sam@onyx.test","3","100","50","1000","0","0.012300","0.001000"');
  });
});

describe("budgets section", () => {
  it("shows used-up budgets with their reset, and only Admins get the editor", () => {
    const { container } = render(<BudgetsSection budgets={[budget]} timeZone="America/Toronto" people={[]} groups={[]} keys={[]} canEdit={false} onChanged={() => {}} />);
    expect(container.textContent).toContain("Used up");
    expect(container.textContent).toContain("resets Nov 1");
    expect(container.querySelector('[role="meter"]')?.getAttribute("aria-valuenow")).toBe("100");
    expect([...container.querySelectorAll("button")].some((b) => b.textContent === "New budget")).toBe(false);
  });
});

describe("grants section", () => {
  it("previews who gains or loses access before saving", async () => {
    const grant: Grant = { id: 1, name: "Everyone", selectors: ["*"], modelPatterns: ["*"], mcpPatterns: ["*"], updatedBy: null, updatedAt: 0 };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ changes: [{ caller: "pat@onyx.test", gains: [], losses: ["gpt-test"] }] }), { status: 200 }));
    vi.useFakeTimers();
    const { container } = render(<GrantsSection grants={[grant]} people={[]} groups={[]} canEdit onChanged={() => {}} />);
    await act(async () => [...container.querySelectorAll("button")].find((b) => b.textContent === "Edit")!.click());
    await act(async () => void vi.advanceTimersByTime(400));
    vi.useRealTimers();
    await flush();
    expect(fetchMock).toHaveBeenCalledWith("/api/gateway/admin/grants/preview", expect.objectContaining({ method: "POST" }));
    expect(container.textContent).toContain("pat@onyx.test");
    expect(container.textContent).toContain("loses gpt-test");
  });
});

describe("usage tab", () => {
  it("loads usage, the daily chart and local energy", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const u = String(input);
      if (u.includes("/usage/daily")) return new Response(JSON.stringify({ timeZone: "America/Toronto", rows: [{ day: "2026-10-13", requests: 3, tokens: 1150, cloudUsd: 0.0123, localUsd: 0.001 }] }));
      if (u.includes("/usage/energy")) return new Response(JSON.stringify({ wh: 5, costUsd: 0.001, attributedUsd: 0.0005, unattributedUsd: 0.0005, minutesWithoutRate: 0, pendingMinutes: 0, lastMinute: 0, rate: 0.2, byMachine: [{ machine: "spark-1", wh: 5, costUsd: 0.001, attributedUsd: 0.0005, unattributedUsd: 0.0005, serverTokens: 92, gatewayTokens: 46 }] }));
      return new Response(JSON.stringify({ range: "7d", groupBy: "person", since: 0, rows: [row] }));
    });
    const { container } = render(<UsageTab />);
    await flush();
    expect(fetchMock).toHaveBeenCalledWith("/api/gateway/admin/usage?range=7d&groupBy=person", expect.anything());
    expect(container.textContent).toContain("sam@onyx.test");
    expect(container.textContent).toContain("spark-1");
    expect(container.textContent).toContain("50%");
    expect(container.textContent).toContain("Days follow America/Toronto");
  });
});
