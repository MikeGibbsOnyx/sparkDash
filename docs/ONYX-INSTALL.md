# Installing Onyx sparkDash (with the AI Gateway)

For whoever installs it (person or agent). One machine runs everything: usually a DGX Spark. Follow the sections in order. Commands run on that machine unless a step says otherwise.

Repository: `https://github.com/MikeGibbsOnyx/sparkDash`, branch **`onyx/main`**. Background on what each part does: `README.md` (sections "People and roles" and "AI Gateway") and `docs/GATEWAY-PLAN.md`.

**Credentials rule:** provider API keys (Anthropic, OpenAI, Gemini, OpenRouter) and MCP server credentials are entered by the owner in the dashboard, in the paste field built for them. An installing agent never asks for a key in chat, never writes one into a file it creates, and never prints one.

---

## 1. Before you start

- An arm64 Linux machine with Docker and Docker Compose v2 (`docker compose version`). A DGX Spark is the tested target. On x86 see the README section "Running it on a machine that is not a Spark".
- Tailscale installed and signed in on that machine (`tailscale status` shows it online).
- In the Tailscale admin console, **MagicDNS → HTTPS Certificates** and **Tailscale Serve** are enabled for the tailnet (done once per tailnet).
- `git` and outbound internet (GitHub, npm, Docker Hub) for the build.
- Ports 5555 (dashboard) and 5556 (gateway) free on 127.0.0.1. Both bind to loopback only; Tailscale Serve publishes them.

## 2. Get the code

**Fresh install:**

```bash
git clone -b onyx/main https://github.com/MikeGibbsOnyx/sparkDash.git
cd sparkDash
```

**Upgrading an existing sparkDash** (upstream, or an earlier Onyx build): keep the same folder, because `config/` holds the fleet, settings and people.

```bash
cd sparkDash
git remote get-url onyx >/dev/null 2>&1 || git remote add onyx https://github.com/MikeGibbsOnyx/sparkDash.git
git fetch onyx
git checkout -B onyx/main onyx/onyx/main
```

If it was cloned from the fork already, `git checkout onyx/main && git pull` is enough.

## 3. Optional settings file

Nothing is required. To set options, create `.env` next to `docker-compose.yml`. Useful ones:

| Variable | Default | When to set it |
| --- | --- | --- |
| `SPARKDASH_TOKEN` | unset | Scripts or Prometheus need to call the dashboard API (acts as Admin) |
| `SPARKDASH_LOCAL_CONSOLE` | `1` | Set `0` if a reverse proxy without `X-Forwarded-For` sits in front |
| `GATEWAY_PORT` | `5556` | Port 5556 is taken |
| `GATEWAY_SECRETS_KEY` | unset | To keep the key that encrypts saved provider keys outside the data volume (64 hex chars); otherwise it's generated into the gateway's volume |
| `GATEWAY_ANTHROPIC_API_KEY`, `GATEWAY_OPENAI_API_KEY`, `GATEWAY_GEMINI_API_KEY` | unset | Only if the owner wants keys from the environment rather than pasted in the UI. The owner fills these in, not the installer |

Lock the file down if it holds anything secret: `chmod 600 .env`.

## 4. Build and start

```bash
docker compose up --build -d
docker compose ps
```

Two containers should be running: **`sparkDash`** (the dashboard, privileged, reads the host's GPUs and sensors) and **`sparkDash-gateway`** (the AI gateway: non-root, read-only, no capabilities, only its own volumes).

Check the logs:

```bash
docker logs sparkDash 2>&1 | tail -20
docker logs sparkDash-gateway 2>&1 | tail -5
```

- The dashboard log shows `server listening on http://127.0.0.1:5555`. With no Owner yet it also prints a one-time **claim code**; note it for step 6.
- The gateway log shows `listening on http://127.0.0.1:5556` and `internal API on /app/ipc/gateway.sock`.

The databases create and upgrade themselves on start (`config/sparkdash.db`, and `gateway.db` in the `gateway-data` volume). There is no manual migration step.

## 5. Publish on the tailnet

```bash
sudo tailscale serve --bg --https=443  http://127.0.0.1:5555   # the dashboard
sudo tailscale serve --bg --https=8443 http://127.0.0.1:5556   # the AI gateway and its Connect page
tailscale serve status
```

`serve status` should list both, as tailnet only. **Never use `tailscale funnel` for either**: the gateway refuses Funnel traffic, and the dashboard flags it.

The addresses are `https://<machine>.<tailnet>.ts.net` (dashboard) and `https://<machine>.<tailnet>.ts.net:8443` (gateway). The gateway one can also be published later with the **Publish on your tailnet** button on the AI Gateway page.

## 6. Become Owner

Either:

- open the dashboard from a browser **on the machine itself** (or through `ssh -N -L 5555:127.0.0.1:5555 user@machine`, then `http://127.0.0.1:5555`); the local console has Owner rights; or
- open the Serve address from your own device, then enter the claim code from step 4 when asked. It's single use and lasts 24 hours.

Then, on **People**, promote anyone else who needs it (they appear after their first visit, as Members).

## 7. Set up (in the dashboard, as Owner or Admin)

1. **Settings**
   - **Time zone**, for example `America/Toronto`. Budget periods and usage days follow it.
   - **Energy → Electricity price**, in **US dollars per kWh**. Local model requests are costed from it.
   - **Default role for new people** (Member unless you want otherwise).
2. **Fleet**: add the Sparks, GPU hosts and Macs as in a normal sparkDash install (**Add Spark**). The machine running sparkDash is added as **This host**. Local model servers they run are detected automatically.
3. **AI Gateway** (sidebar):
   - **Turn on the gateway.** This creates the default grant, *Everyone → all models and all MCP tools*.
   - **Models tab: the owner pastes each provider key** into *Paste a provider key* and presses **Test and save**. Keys are write-only from then on.
   - **Models tab, local models:** switch on **Serve through the gateway** for each local server people should use.
   - **Models tab, prices:** set USD per million tokens for the cloud models in use. Models with no price count as $0, and the Overview says so.
   - **Access tab** (optional): narrow grants, add budgets, create gateway keys for CI runners.
   - **Privacy and guardrails** (optional): the defaults are metadata only and every guardrail off.
   - **MCP tab** (optional): add remote MCP servers (URL plus credential, then **Test and save**).
4. **Share** the gateway address (`https://<machine>.<tailnet>.ts.net:8443`). People open it, pick their tool and copy one block. On the tailnet nobody needs a key.

## 8. Check it works

From any device on the tailnet:

```bash
curl -s -o /dev/null -w "%{http_code}\n" -I https://<machine>.<tailnet>.ts.net:8443/api/hello   # 200
curl -s https://<machine>.<tailnet>.ts.net:8443/v1/models -H "authorization: Bearer sparkdash" | head -c 300
```

The second command lists the models you're granted.

Then:

- Open the gateway address in a browser: the **Connect page** says who you are and how many models you can use.
- Point one tool at it from the Connect page (Claude Code is the quickest) and send a message. The Connect page shows "Connected: …".
- **AI Gateway → Usage** shows the request, with tokens and cost, within a minute. **Requests** lists it.
- If a local model is served: a request to `<machine>/<model>` shows an energy cost within about 2 minutes.
- If an MCP server was added: `claude mcp add --transport http sparkdash https://<machine>.<tailnet>.ts.net:8443/mcp`, then `claude mcp list` shows `✔ Connected`.

## 9. Back up

Everything worth keeping:

- `config/` in the repo folder: fleet, settings, people, the dashboard's secrets key.
- The **`gateway-data`** volume: gateway database, encrypted provider keys and **their encryption key `secrets.key`**. Without that key, saved provider keys can't be read, so back it up with the database, or set `GATEWAY_SECRETS_KEY`.

```bash
docker run --rm -v sparkdash_gateway-data:/d -v "$PWD":/b alpine tar czf /b/gateway-data-$(date +%F).tgz -C /d .
tar czf config-$(date +%F).tgz config
```

The volume name is `<folder>_gateway-data`; check it with `docker volume ls`. Store the archives somewhere private: they hold encrypted keys and the key to decrypt them.

## 10. Updating later

```bash
cd sparkDash && git pull && docker compose up --build -d
```

Database changes apply themselves on start. Back up first (step 9); there is no downgrade.

## 11. When something's wrong

| Symptom | Check |
| --- | --- |
| AI Gateway page says the gateway isn't running | `docker compose ps gateway`, `docker logs sparkDash-gateway`. Both containers must share the `ipc` volume (they do in the shipped compose file) |
| `401` naming a fix when opening through Serve | You're coming through Funnel or a proxy without `X-Forwarded-For`; use Tailscale Serve |
| A teammate sees only the Connect page | They're a Member: promote them on **People** |
| A provider key shows **Failing** | Its card names the reason. **Replace key** tests the new one before dropping the old |
| A local server can't be switched on | It listens only on its own loopback on another machine: bind it to a LAN or tailnet address |
| Build fails fetching packages on a Spark | Retry. If a Tailwind native binding is missing afterwards, rebuild with `docker compose build --no-cache` |
| Outbound calls time out on a Spark | The gateway prefers IPv4 already; check the host's DNS and route to the provider |

Logs never contain keys. If you're sharing logs for help, `docker logs sparkDash-gateway` and `docker logs sparkDash` are safe to share as they are.
