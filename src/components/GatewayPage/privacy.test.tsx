import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { flush, render } from "../../testing/render";
import { FULL_CAPTURE_WARNING, PrivacyTab } from "./PrivacyTab";
import { RequestsTab } from "./RequestsTab";

const privacy = {
  capture: { mode: "metadata", retention: { bodiesDays: 7, metadataDays: 400 } },
  guardrails: {
    detectors: [
      { id: "card", name: "Payment card", builtin: true, mode: "off" },
      { id: "custom:3", name: "Project code", builtin: false, mode: "flag", pattern: "PRJ-\\d{4}", flags: "" },
    ],
    blockedTools: [],
    hook: null,
  },
};

const click = (el: Element) => act(async () => (el as HTMLElement).click());
const byText = (c: HTMLElement, t: string) => [...c.querySelectorAll("button")].find((b) => b.textContent === t)!;

describe("privacy and guardrails", () => {
  it("full capture asks first, with the plan's warning", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_u, init) =>
      init?.method === "PATCH" ? new Response(JSON.stringify({ capture: { ...privacy.capture, mode: "full" } })) : new Response(JSON.stringify(privacy))
    );
    const { container } = render(<PrivacyTab canEdit />);
    await flush();
    await click(byText(container, "Full capture"));
    expect(container.textContent).toContain(FULL_CAPTURE_WARNING);
    expect(fetchMock).not.toHaveBeenCalledWith("/api/gateway/admin/privacy/capture", expect.anything());
    await click(byText(container, "Turn on full capture"));
    await flush();
    expect(fetchMock).toHaveBeenCalledWith("/api/gateway/admin/privacy/capture", expect.objectContaining({ method: "PATCH", body: JSON.stringify({ mode: "full" }) }));
  });

  it("detector modes change in place, custom ids included", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify(privacy)));
    const { container } = render(<PrivacyTab canEdit />);
    await flush();
    const group = container.querySelector('[aria-label="Project code mode"]')!;
    await click([...group.querySelectorAll("button")].find((b) => b.textContent === "Block")!);
    expect(fetchMock).toHaveBeenCalledWith("/api/gateway/admin/guardrails/detectors/custom:3", expect.objectContaining({ method: "PATCH", body: JSON.stringify({ mode: "block" }) }));
  });

  it("Auditors see the settings but can't change them", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify(privacy)));
    const { container } = render(<PrivacyTab canEdit={false} />);
    await flush();
    expect(byText(container, "Full capture").disabled).toBe(true);
    expect([...container.querySelectorAll("button")].some((b) => b.textContent === "Add a pattern")).toBe(false);
  });
});

describe("requests tab", () => {
  const row = {
    id: 7, ts: Date.now() - 60_000, identity: "sam@onyx.test", via: "serve", device: "sam-mbp", client: "Claude Code", providerId: "env-anthropic", model: "claude-test", format: "anthropic", stream: true,
    status: 200, latencyMs: 1200, ttfbMs: 300, inTok: 10, outTok: 5, cacheReadTok: 0, cacheWriteTok: 0, costUsd: 0.0001, costBasis: "key", partial: false, usageState: "ok", sessionId: "s-1", agentId: null,
    guardrailHits: [{ detector: "card", name: "Payment card", action: "redacted", count: 1 }], error: null, headers: { "user-agent": "claude-cli/2" }, hasContent: true,
  };

  it("content is shown only after confirming that the view is logged", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (u) =>
      String(u).includes("/content")
        ? new Response(JSON.stringify({ content: { request: '{"messages":[]}', response: "event: message_stop", requestTruncated: false, responseTruncated: false } }))
        : new Response(JSON.stringify({ requests: [row], more: false }))
    );
    const { container } = render(<RequestsTab />);
    await flush();
    expect(container.textContent).toContain("sam@onyx.test");
    expect(container.textContent).toContain("Guardrail");
    await click(container.querySelector("tbody tr")!);
    expect(container.textContent).toContain("Payment card: redacted");
    await click(byText(container, "View content…"));
    expect(container.textContent).toContain("written to the audit trail");
    expect(fetchMock).not.toHaveBeenCalledWith("/api/gateway/admin/requests/7/content", expect.anything());
    await click(byText(container, "View content"));
    await flush();
    expect(fetchMock).toHaveBeenCalledWith("/api/gateway/admin/requests/7/content", expect.anything());
    expect(container.textContent).toContain("event: message_stop");
  });
});
