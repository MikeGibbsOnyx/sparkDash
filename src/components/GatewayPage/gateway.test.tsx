import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { AddProviderKey } from "./ModelsTab";
import { RevealKeyDialog } from "./AccessTab";
import { detectProvider } from "./gatewayApi";
import { flush, render } from "../../testing/render";
import { curlCheck, snippetFor } from "../../connect/snippets";

function typeInto(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("paste a provider key", () => {
  it("detects the provider from the prefix and shows only a masked key", () => {
    const { container } = render(<AddProviderKey onSaved={() => {}} />);
    typeInto(container.querySelector("#gw-paste") as HTMLInputElement, "sk-ant-api03-abcdefghijklmnopqrstuvwxyza3F9");
    expect(container.textContent).toContain("Detected: Anthropic");
    expect(container.textContent).toContain("sk-ant-…a3F9");
    expect(container.textContent).not.toContain("abcdefghijklmnop");
    expect((container.querySelector("#gw-paste") as HTMLInputElement).type).toBe("password");
  });

  it("Test and save answers in place, and clears the field once saved", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ saved: true, ok: true, message: "Works. 23 models available." }), { status: 200 }));
    const onSaved = vi.fn();
    const { container } = render(<AddProviderKey onSaved={onSaved} />);
    const input = container.querySelector("#gw-paste") as HTMLInputElement;
    typeInto(input, "sk-proj-abcdefghijklmnopqrstuvwxyz");
    const button = [...container.querySelectorAll("button")].find((b) => b.textContent === "Test and save")!;
    await act(async () => button.click());
    await flush();
    expect(fetchMock).toHaveBeenCalledWith("/api/gateway/admin/providers", expect.objectContaining({ method: "POST" }));
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]!.body))).toMatchObject({ type: "openai" });
    expect(container.textContent).toContain("Works. 23 models available.");
    expect(input.value).toBe("");
    expect(onSaved).toHaveBeenCalled();
  });

  it("a failing key names the fix, keeps the raw error behind Details, and offers Save anyway", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ saved: false, ok: false, message: "Anthropic rejected this key (401). Copy the whole key and paste it again.", details: '{"error":"invalid x-api-key"}' }), { status: 200 })
    );
    const { container } = render(<AddProviderKey onSaved={() => {}} />);
    typeInto(container.querySelector("#gw-paste") as HTMLInputElement, "sk-ant-api03-wrongwrongwrongwrong");
    await act(async () => [...container.querySelectorAll("button")].find((b) => b.textContent === "Test and save")!.click());
    await flush();
    expect(container.textContent).toContain("Copy the whole key");
    expect(container.querySelector("details summary")?.textContent).toBe("Details");
    expect([...container.querySelectorAll("button")].some((b) => b.textContent === "Save anyway")).toBe(true);
  });

  it("an unrecognised key asks for the provider", () => {
    expect(detectProvider("xyz-123")).toBeNull();
    const { container } = render(<AddProviderKey onSaved={() => {}} />);
    typeInto(container.querySelector("#gw-paste") as HTMLInputElement, "xyz-1234567890");
    expect(container.textContent).toContain("Pick one below");
  });
});

describe("a new gateway key is shown once", () => {
  it("can't be closed until 'I've saved this key' is ticked, and fills the key into the setup block", () => {
    const onClose = vi.fn();
    const key = "sdgw_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345";
    const { container } = render(<RevealKeyDialog keyValue={key} name="ci-deploy" url="https://rin-den.tail1.ts.net:8443" onClose={onClose} />);
    const close = [...container.querySelectorAll("button")].find((b) => b.textContent === "Close")!;
    expect(close.disabled).toBe(true);
    expect(container.textContent).toContain(`ANTHROPIC_API_KEY=${key}`);
    expect(container.textContent).toContain("ANTHROPIC_BASE_URL=https://rin-den.tail1.ts.net:8443");
    act(() => (container.querySelector('input[type="checkbox"]') as HTMLInputElement).click());
    expect(close.disabled).toBe(false);
    act(() => close.click());
    expect(onClose).toHaveBeenCalled();
  });
});

describe("setup snippets match what the clients actually send (spike)", () => {
  const url = "https://gw.tail1.ts.net:8443";
  const models = [
    { name: "gpt-5-mini", provider: "openai" },
    { name: "gemini-3.5-flash", provider: "gemini" },
    { name: "spark-1/qwen3-coder", provider: "local" },
  ];
  it("Claude Code: base URL in settings.json; the company key adds the placeholder token", () => {
    const own = JSON.parse(snippetFor({ url, tool: "claude-code", os: "unix", credential: "own", models })[0].code);
    expect(own.env.ANTHROPIC_BASE_URL).toBe(url);
    expect(own.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    const company = JSON.parse(snippetFor({ url, tool: "claude-code", os: "unix", credential: "company", models })[0].code);
    expect(company.env.ANTHROPIC_AUTH_TOKEN).toBe("sparkdash");
  });
  it("Codex: base_url ends in /v1, wire_api responses, the key from env_key", () => {
    const [cfg, shell] = snippetFor({ url, tool: "codex", os: "unix", credential: "company", models });
    expect(cfg.code).toContain(`base_url = "${url}/v1"`);
    expect(cfg.code).toContain('wire_api = "responses"');
    expect(cfg.code).toContain('env_key = "SPARKDASH_KEY"');
    expect(shell.code).toBe('export SPARKDASH_KEY="sparkdash"');
  });
  it("Gemini CLI: bare origin as base URL, and the api-key auth setting it needs", () => {
    const [shell, settings] = snippetFor({ url, tool: "gemini-cli", os: "unix", credential: "company", models });
    expect(shell.code).toContain(`GOOGLE_GEMINI_BASE_URL="${url}"`);
    expect(JSON.parse(settings.code)).toEqual({ security: { auth: { selectedType: "gemini-api-key" } } });
  });
  it("OpenCode: openai-compatible provider at /v1 with local models listed", () => {
    const cfg = JSON.parse(snippetFor({ url, tool: "opencode", os: "unix", credential: "company", models })[0].code);
    expect(cfg.provider.sparkdash.options.baseURL).toBe(`${url}/v1`);
    expect(Object.keys(cfg.provider.sparkdash.models)).toContain("spark-1/qwen3-coder");
  });
  it("Windows uses setx; curl checks list models", () => {
    expect(snippetFor({ url, tool: "codex", os: "windows", credential: "company", models })[1].code).toBe('setx SPARKDASH_KEY "sparkdash"');
    expect(curlCheck(url)).toContain(`${url}/v1/models`);
  });
});
