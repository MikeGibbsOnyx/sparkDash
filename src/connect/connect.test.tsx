import { describe, expect, it, vi } from "vitest";
import { ConnectPage, ago } from "./ConnectPage";
import { flush, render } from "../testing/render";

function mockMe(me: unknown) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    if (url === "/me") return new Response(JSON.stringify(me), { status: 200 });
    if (url === "/me/usage") return new Response(JSON.stringify({ byModel: [] }), { status: 200 });
    if (url === "/me/keys") return new Response(JSON.stringify({ keys: [] }), { status: 200 });
    return new Response("{}", { status: 404 });
  });
}

const base = {
  who: { kind: "person", login: "sam@onyx.test", name: "Sam", label: "sam@onyx.test", device: "sam-mbp", role: "member", via: "serve" },
  gatewayEnabled: true,
  models: [{ name: "claude-sonnet-4-6", provider: "anthropic" }],
  personalKeys: true,
};

describe("Connect page", () => {
  it("shows who you are and waits for the first request", async () => {
    mockMe({ ...base, lastRequest: null });
    const { container } = render(<ConnectPage />);
    await flush();
    expect(container.textContent).toContain("Signed in as Sam on sam-mbp");
    expect(container.textContent).toContain("You can use 1 model");
    expect(container.textContent).toContain("Waiting for your first request…");
    expect(container.textContent).toContain("Use my own subscription");
    expect(container.textContent).toContain("My gateway keys");
  });

  it("says Connected with the tool, model and time once a request arrives", async () => {
    mockMe({ ...base, lastRequest: { ts: Date.now() - 3000, client: "Claude Code", model: "claude-sonnet-4-6", status: 200 } });
    const { container } = render(<ConnectPage />);
    await flush();
    expect(container.textContent).toMatch(/Connected: Claude Code, claude-sonnet-4-6, \d seconds? ago/);
  });

  it("formats relative times", () => {
    expect(ago(1000 - 3000, 1000)).toBe("3 seconds ago");
    expect(ago(0, 90_000)).toBe("2 minutes ago");
  });
});
