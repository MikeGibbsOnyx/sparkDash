import { afterEach, describe, expect, it, vi } from "vitest";
import { AccessGate } from "./AccessGate";
import { AccessContext } from "./AccessContext";
import { PeoplePage, assignableRoles } from "./PeoplePage";
import { flush, render } from "../../testing/render";
import type { Me } from "./accessApi";

function mockFetch(routes: Record<string, unknown>) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    const body = routes[url];
    if (body === undefined) return new Response(JSON.stringify({ error: "not mocked" }), { status: 404 });
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  });
}

const person = (role: string, extra: Record<string, unknown> = {}) => ({
  signedIn: true,
  via: "serve",
  login: "sam@onyx.test",
  name: "Sam",
  device: "sam-mbp",
  role,
  roleLabel: role[0].toUpperCase() + role.slice(1),
  tagged: false,
  canClaim: false,
  ...extra,
});

describe("AccessGate", () => {
  afterEach(() => window.history.replaceState(null, "", "/"));

  it("sends a Member to the Connect placeholder and never renders the dashboard", async () => {
    mockFetch({ "/api/access/me": person("member") });
    const { container } = render(
      <AccessGate>
        <div data-testid="fleet">fleet</div>
      </AccessGate>
    );
    await flush();
    expect(container.querySelector('[data-testid="fleet"]')).toBeNull();
    expect(container.textContent).toContain("Connect page");
    expect(container.textContent).toContain("ask an Owner or Admin to change your role");
  });

  it("shows a refused caller what happened and the fix", async () => {
    mockFetch({ "/api/access/me": { signedIn: false, error: "sparkDash can't identify a request forwarded from 203.0.113.9.", fix: "Open sparkDash through Tailscale Serve, or send SPARKDASH_TOKEN." } });
    const { container } = render(
      <AccessGate>
        <div data-testid="fleet">fleet</div>
      </AccessGate>
    );
    await flush();
    expect(container.querySelector('[data-testid="fleet"]')).toBeNull();
    expect(container.textContent).toContain("203.0.113.9");
    expect(container.textContent).toContain("Tailscale Serve");
  });

  it("renders the dashboard for Auditors and above, with the claim banner while unowned", async () => {
    mockFetch({ "/api/access/me": person("admin", { canClaim: true }) });
    const { container } = render(
      <AccessGate>
        <div data-testid="fleet">fleet</div>
      </AccessGate>
    );
    await flush();
    expect(container.querySelector('[data-testid="fleet"]')).not.toBeNull();
    expect(container.textContent).toContain("No one owns this sparkDash yet");
  });

  it("refuses tagged devices", async () => {
    mockFetch({ "/api/access/me": person("member", { tagged: true, role: null, login: null, device: "ci-runner" }) });
    const { container } = render(
      <AccessGate>
        <div data-testid="fleet">fleet</div>
      </AccessGate>
    );
    await flush();
    expect(container.textContent).toContain("ci-runner is tagged");
  });
});

describe("assignableRoles", () => {
  it("follows the role rules", () => {
    expect(assignableRoles("owner", "owner")).toEqual(["member", "auditor", "admin", "owner"]);
    expect(assignableRoles("admin", "member")).toEqual(["member", "auditor", "admin"]);
    expect(assignableRoles("admin", "owner")).toEqual([]);
    expect(assignableRoles("auditor", "member")).toEqual([]);
    expect(assignableRoles(null, "member")).toEqual([]);
  });
});

describe("PeoplePage", () => {
  const people = {
    people: [{ login: "sam@onyx.test", displayName: "Sam", role: "member", firstSeen: 1, lastSeen: Date.now(), lastDevice: "sam-mbp", groups: ["Eng"] }],
    groups: [{ id: 1, name: "Eng", members: ["sam@onyx.test"] }],
  };

  it("is read-only for an Auditor", async () => {
    mockFetch({ "/api/access/people": people });
    const { container } = render(
      <AccessContext.Provider value={{ me: person("auditor") as Me, reload: () => {} }}>
        <PeoplePage />
      </AccessContext.Provider>
    );
    await flush();
    expect(container.textContent).toContain("sam@onyx.test");
    expect(container.querySelector("select")).toBeNull();
    expect(container.textContent).toContain("You can view this page but not change it");
    expect(container.textContent).not.toContain("New group");
  });

  it("gives an Admin a role dropdown without Owner", async () => {
    mockFetch({ "/api/access/people": people });
    const { container } = render(
      <AccessContext.Provider value={{ me: person("admin", { login: "ada@onyx.test" }) as Me, reload: () => {} }}>
        <PeoplePage />
      </AccessContext.Provider>
    );
    await flush();
    const options = [...container.querySelectorAll("select option")].map((o) => o.textContent);
    expect(options).toEqual(["Member", "Auditor", "Admin"]);
  });
});
