import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { flush, render } from "../../testing/render";
import { McpTab } from "./McpTab";
import { GrantsSection } from "./AccessEditors";
import { snippetFor } from "../../connect/snippets";

function typeInto(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const byText = (c: HTMLElement, t: string) => [...c.querySelectorAll("button")].find((b) => b.textContent === t)!;

describe("MCP tab", () => {
  it("Test and save sends the URL and credential once; the card never shows the credential", async () => {
    const server = { id: 1, name: "github", url: "https://mcp.github.com/mcp", enabled: true, status: "Connected", lastError: null, lastTestedAt: Date.now(), toolCount: 18, tools: ["create_issue"], headerName: "Authorization", headerLast4: "XyZ9", addedBy: "mike", addedAt: Date.now() };
    let saved = false;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_u, init) => {
      if (init?.method === "POST") {
        saved = true;
        return new Response(JSON.stringify({ saved: true, ok: true, message: "Connected. 18 tools.", server }));
      }
      return new Response(JSON.stringify({ servers: saved ? [server] : [] }));
    });
    const { container } = render(<McpTab canEdit url="https://rin-den.example.ts.net:8443" />);
    await flush();
    expect(container.textContent).toContain("https://rin-den.example.ts.net:8443/mcp");
    typeInto(container.querySelector('input[placeholder="https://mcp.example.com/mcp"]') as HTMLInputElement, "https://mcp.github.com/mcp");
    expect(container.textContent).toContain("github__<tool>");
    const secret = container.querySelector('input[aria-label="Header value"]') as HTMLInputElement;
    expect(secret.type).toBe("password");
    typeInto(secret, "Bearer ghp_secretsecretXyZ9");
    await act(async () => byText(container, "Test and save").click());
    await flush();
    const post = fetchMock.mock.calls.find(([, i]) => i?.method === "POST")!;
    expect(post[0]).toBe("/api/gateway/admin/mcp-servers");
    expect(JSON.parse(String(post[1]!.body))).toMatchObject({ url: "https://mcp.github.com/mcp", name: "github", headerName: "Authorization", headerValue: "Bearer ghp_secretsecretXyZ9" });
    expect(container.textContent).toContain("Connected. 18 tools.");
    expect(container.textContent).toContain("Authorization: …XyZ9");
    expect(container.textContent).not.toContain("ghp_secret");
  });
});

describe("grants editor", () => {
  it("edits MCP tool patterns alongside models", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify({ changes: [], grant: {} })));
    const { container } = render(<GrantsSection grants={[]} people={[]} groups={[]} canEdit onChanged={() => {}} />);
    await act(async () => byText(container, "New grant").click());
    typeInto(container.querySelector('input[placeholder="Engineering: Claude"]') as HTMLInputElement, "Eng tools");
    typeInto(container.querySelector('input[placeholder="group:eng, sam@example.com"]') as HTMLInputElement, "group:eng");
    typeInto(container.querySelector('input[placeholder="github__*, linear__create_issue"]') as HTMLInputElement, "github__*");
    await act(async () => byText(container, "Create grant").click());
    await flush();
    const post = fetchMock.mock.calls.find(([u, i]) => String(u).endsWith("/grants") && i?.method === "POST")!;
    expect(JSON.parse(String(post[1]!.body))).toMatchObject({ name: "Eng tools", selectors: ["group:eng"], modelPatterns: [], mcpPatterns: ["github__*"] });
  });
});

describe("Connect page MCP tile", () => {
  it("gives the claude mcp add command, with a gateway key only when there is one", () => {
    const url = "https://rin-den.example.ts.net:8443";
    expect(snippetFor({ url, tool: "mcp", os: "unix", credential: "company", models: [] })[0].code).toBe(`claude mcp add --transport http sparkdash ${url}/mcp`);
    expect(snippetFor({ url, tool: "mcp", os: "unix", credential: "company", key: "sdgw_abc", models: [] })[0].code).toContain('--header "Authorization: Bearer sdgw_abc"');
  });
});
