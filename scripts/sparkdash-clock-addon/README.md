# sparkDash clock-cap add-on

**Not core sparkDash.** Core stays read-only collectors. This package is the
privileged actuator: CPU/GPU clock caps from the device page.

## Arming (all three required)

1. Install this helper **on the Spark host** (once).
2. Sudoers drop-in present (`/etc/sudoers.d/sparkdash-clock`).
3. Edit Spark → **Allow clock control** (`clockControlEnabled`, default off).

Missing any of those: Clock Cap rows stay read-only, API 403, no slider.

```bash
# On the Spark, from the account sparkDash SSHes in as (its "SSH user"):
sudo ./scripts/sparkdash-clock-addon/install-clock-helper.sh
```

No new account is created: the grant names that one existing SSH user.

## Privilege facts

Every apply form is **argv-pinned** (`--max-mhz` via anchored sudoers regex,
digits only, sudo ≥ 1.9.10). Not `%sudo`, not `ALL ALL`. There is no
bare-binary entry (sudoers would read it as *any argv*); the probe is the
pinned no-op `--check` form.

The helper applies first, persists only on success, falls back from
`max_perf` to `scaling_max_freq` on `cppc_cpufreq` hosts, and reports
`core=… knob=… khz=<read-back>` + `persisted=<0|1>`. The dashboard never
writes host state from its container.

Live apply is the default UI action. **Save (survive reboot)** writes
`cpu-clock-cap.service` / `gpu-clock-lock.service` — a second, labeled step.

Revoke: delete `/etc/sudoers.d/sparkdash-clock` and/or the helper binary,
and turn the Edit Spark flag off.
