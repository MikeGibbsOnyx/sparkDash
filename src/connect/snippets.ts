// Onyx: client setup blocks. URL, models and keys are filled in live. Each shape was checked
// against the client in the spike (docs/GATEWAY-PLAN.md): Codex 0.162, OpenCode 1.19, Gemini CLI 0.63.

export type ToolId = "claude-code" | "claude-desktop" | "codex" | "gemini-cli" | "opencode" | "other" | "ci" | "mcp";
export type Os = "unix" | "windows";
export type Credential = "own" | "company";

export const TOOLS: { id: ToolId; label: string; blurb: string; own?: boolean }[] = [
  { id: "claude-code", label: "Claude Code", blurb: "Anthropic's coding agent", own: true },
  { id: "claude-desktop", label: "Claude Desktop", blurb: "The Claude app" },
  { id: "codex", label: "Codex", blurb: "OpenAI's coding agent" },
  { id: "gemini-cli", label: "Gemini CLI", blurb: "Google's coding agent" },
  { id: "opencode", label: "OpenCode", blurb: "Any model, including local ones" },
  { id: "other", label: "Other", blurb: "Anything OpenAI-compatible" },
  { id: "ci", label: "CI", blurb: "GitHub Actions with a gateway key" },
  { id: "mcp", label: "MCP", blurb: "Tools for your agents" },
];

export type SnippetInput = {
  url: string;
  tool: ToolId;
  os: Os;
  credential: Credential;
  /** A gateway key to fill in, when the caller isn't on the tailnet. */
  key?: string;
  models: { name: string; provider: string }[];
};

export type Snippet = { title: string; file?: string; code: string; note?: string }[];

const pick = (models: SnippetInput["models"], providers: string[], fallback: string) =>
  models.find((m) => providers.includes(m.provider))?.name ?? fallback;

export function snippetFor(i: SnippetInput): Snippet {
  const url = i.url.replace(/\/+$/, "");
  const key = i.key || "sparkdash";
  const win = i.os === "windows";
  const env = (name: string, value: string) => (win ? `setx ${name} "${value}"` : `export ${name}="${value}"`);
  switch (i.tool) {
    case "claude-code": {
      const vars: Record<string, string> = { ANTHROPIC_BASE_URL: url, CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1" };
      if (i.credential === "company" || i.key) vars.ANTHROPIC_AUTH_TOKEN = key;
      return [
        {
          title: "Add to the env block of your Claude Code settings",
          file: win ? "%USERPROFILE%\\.claude\\settings.json" : "~/.claude/settings.json",
          code: JSON.stringify({ env: vars }, null, 2),
          note:
            i.credential === "own" && !i.key
              ? "Keep signed in to your own Claude subscription; requests go through the gateway with your login."
              : "The gateway uses your company's key; you don't need one of your own.",
        },
      ];
    }
    case "claude-desktop":
      return [
        {
          title: "In Claude Desktop",
          code: `Developer → Configure Third-Party Inference\nGateway URL: ${url}\nAPI key: ${key}`,
          note: "The gateway's HTTPS address comes from Tailscale Serve, so Claude Desktop trusts its certificate.",
        },
      ];
    case "codex": {
      const model = pick(i.models, ["openai", "openrouter", "local"], "gpt-5-mini");
      return [
        {
          title: "Codex config",
          file: win ? "%USERPROFILE%\\.codex\\config.toml" : "~/.codex/config.toml",
          code: `model = "${model}"\nmodel_provider = "sparkdash"\n\n[model_providers.sparkdash]\nname = "sparkDash"\nbase_url = "${url}/v1"\nenv_key = "SPARKDASH_KEY"\nwire_api = "responses"`,
        },
        { title: "Then, in your shell", code: env("SPARKDASH_KEY", key) },
      ];
    }
    case "gemini-cli": {
      const model = pick(i.models, ["gemini"], "gemini-3.5-flash");
      return [
        { title: "In your shell", code: [env("GOOGLE_GEMINI_BASE_URL", url), env("GEMINI_API_KEY", key), env("GEMINI_MODEL", model)].join("\n") },
        {
          title: "Pick API-key sign-in once",
          file: win ? "%USERPROFILE%\\.gemini\\settings.json" : "~/.gemini/settings.json",
          code: JSON.stringify({ security: { auth: { selectedType: "gemini-api-key" } } }, null, 2),
          note: "Without this, Gemini CLI stops with “Invalid auth method selected”. It also uses a small Gemini model in the background, so your access needs that model too.",
        },
      ];
    }
    case "opencode": {
      const models = i.models.filter((m) => ["openai", "openrouter", "local"].includes(m.provider)).slice(0, 8);
      const listed = Object.fromEntries((models.length ? models : [{ name: "gpt-5-mini" }]).map((m) => [m.name, {}]));
      const first = Object.keys(listed)[0];
      return [
        {
          title: "OpenCode config",
          file: win ? "%USERPROFILE%\\.config\\opencode\\opencode.json" : "~/.config/opencode/opencode.json",
          code: JSON.stringify(
            {
              $schema: "https://opencode.ai/config.json",
              provider: { sparkdash: { npm: "@ai-sdk/openai-compatible", name: "sparkDash", options: { baseURL: `${url}/v1`, apiKey: key }, models: listed } },
              model: `sparkdash/${first}`,
            },
            null,
            2
          ),
        },
      ];
    }
    case "other":
      return [{ title: "Any OpenAI-compatible tool", code: `Base URL: ${url}/v1\nAPI key:  ${key}` }];
    case "ci":
      return [
        {
          title: "GitHub Actions",
          file: ".github/workflows/claude.yml (excerpt)",
          code: `- uses: tailscale/github-action@v3\n  with:\n    oauth-client-id: \${{ secrets.TS_OAUTH_CLIENT_ID }}\n    oauth-secret: \${{ secrets.TS_OAUTH_SECRET }}\n    tags: tag:ci\n- uses: anthropics/claude-code-action@v1\n  env:\n    ANTHROPIC_BASE_URL: ${url}\n  with:\n    anthropic_api_key: \${{ secrets.SPARKDASH_GATEWAY_KEY }}`,
          note: "Store the gateway key as the SPARKDASH_GATEWAY_KEY secret; it's sent as x-api-key. The runner joins your tailnet to reach the gateway.",
        },
      ];
    case "mcp":
      return [
        {
          title: "Claude Code",
          code: key && key !== "sparkdash" ? `claude mcp add --transport http sparkdash ${url}/mcp --header "Authorization: Bearer ${key}"` : `claude mcp add --transport http sparkdash ${url}/mcp`,
          note: "Tools appear as sparkdash's <server>__<tool>; you see the ones your access allows. On the tailnet no key is needed.",
        },
        { title: "Any MCP client (Streamable HTTP)", code: `${url}/mcp` },
      ];
  }
}

export function curlCheck(url: string, key = "sparkdash", os: Os = "unix"): string {
  const u = url.replace(/\/+$/, "");
  return os === "windows"
    ? `curl.exe -s ${u}/v1/models -H "authorization: Bearer ${key}"`
    : `curl -s ${u}/v1/models -H "authorization: Bearer ${key}" | head -c 400`;
}
