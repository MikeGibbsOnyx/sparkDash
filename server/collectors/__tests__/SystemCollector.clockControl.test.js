import test from "node:test";
import assert from "node:assert/strict";
import { SystemCollector } from "../SystemCollector.js";

/** Local collector with sysfs/smi/stubs — no real I/O anywhere. */
function localCollector() {
  const c = new SystemCollector({ id: "spark-test", kind: "spark", isLocal: true });
  return c;
}

const LIVE_DOMAINS = [
  { label: "X925", capMHz: 2600, maxMHz: 3900, capped: true },
  { label: "A725", capMHz: 2808, maxMHz: 2808, capped: false },
];

// ─── D5: volatile override merge ──────────────────────────

test("stale cache is merged with the volatile override (cpu)", async () => {
  const c = localCollector();
  c._clockCapsCache = {
    at: Date.now(),
    cpuDomains: LIVE_DOMAINS.map((d) => ({ ...d })),
    gpuLock: null,
    ok: true,
  };
  // Override targets the 3900 MHz domain (the "cpu-big" id per parseCpuClockCaps).
  c._clockCapsOverride["cpu-big"] = 3000;
  const caps = await c._getClockCaps();
  assert.equal(caps.cpuDomains[0].capMHz, 3000);
  assert.equal(caps.cpuDomains[0].capped, true);
  // Cache itself is never mutated.
  assert.equal(c._clockCapsCache.cpuDomains[0].capMHz, 2600);
});

test("override can remove a gpu lock (null) and the merge reflects it", async () => {
  const c = localCollector();
  c._clockCapsCache = {
    at: Date.now(),
    cpuDomains: LIVE_DOMAINS.map((d) => ({ ...d })),
    gpuLock: { minMHz: 0, maxMHz: 2200 },
    ok: true,
  };
  c._clockCapsOverride.gpu = null;
  const caps = await c._getClockCaps();
  assert.equal(caps.gpuLock, null);
});

test("a fresh converging read drops the override", async () => {
  const c = localCollector();
  c._clockCapsOverride["cpu-little"] = 2808;
  // Fresh read now reports the applied value — override is redundant.
  // cpu-little id = the 2808 MHz domain (per parseCpuClockCaps labels).
  c._readLocalCpuCapDump = async () => "cpu0:2808000:2808000\ncpu5:2600000:3900000";
  c._readLocalGpuLockUnit = async () => "";
  const caps = await c._getClockCaps();
  assert.equal(caps.cpuDomains.find((d) => d.maxMHz === 2808).capMHz, 2808);
  assert.deepEqual(c._clockCapsOverride, {});
});

test("a fresh diverging read also drops the override (fresh value wins)", async () => {
  const c = localCollector();
  c._clockCapsOverride["cpu-little"] = 2808;
  // Fresh read says something else entirely (e.g. another operator changed it).
  c._readLocalCpuCapDump = async () => "cpu0:2000000:2808000\ncpu5:2600000:3900000";
  c._readLocalGpuLockUnit = async () => "";
  const caps = await c._getClockCaps();
  assert.equal(caps.cpuDomains.find((d) => d.maxMHz === 2808).capMHz, 2000);
  assert.deepEqual(c._clockCapsOverride, {});
});

test("clearClockCapsOverride drops all volatile state (hot config)", async () => {
  const c = localCollector();
  c._clockCapsOverride["cpu-big"] = 3000;
  c._clockCapsOverride.gpu = 2200;
  c.clearClockCapsOverride();
  assert.deepEqual(c._clockCapsOverride, {});
});

test("a gpu live-only override survives a diverging unit-file read (D5)", async () => {
  const c = localCollector();
  // A live-only -lgc apply is invisible to the unit file: until a read
  // actually reports the applied value, the override must keep the UI honest.
  c._clockCapsOverride.gpu = 2400;
  c._readLocalCpuCapDump = async () => "cpu0:2808000:2808000\ncpu5:2600000:3900000";
  c._readLocalGpuLockUnit = async () => "-lgc 0,2200"; // unit still says 2200
  await c._getClockCaps();
  assert.equal(c._clockCapsOverride.gpu, 2400);
});

test("a gpu override drops once a fresh read converges to it", async () => {
  const c = localCollector();
  c._clockCapsOverride.gpu = 2400;
  c._readLocalCpuCapDump = async () => "cpu0:2808000:2808000\ncpu5:2600000:3900000";
  c._readLocalGpuLockUnit = async () => "-lgc 0,2400";
  c._clockCapsCache = { at: 0, cpuDomains: null, gpuLock: null }; // force fresh read
  await c._getClockCaps();
  assert.ok(!Object.prototype.hasOwnProperty.call(c._clockCapsOverride, "gpu"));
});

// ─── D8: bounds discovery ─────────────────────────────────

test("_getClockBounds parses cpu bounds and the GPU ceiling from smi output", async () => {
  const c = localCollector();
  c._readLocalCpuBoundsDump = async () =>
    ["cpu0:338000:2808000", "cpu5:1378000:3900000"].join("\n");
  c._nvidiaSmi = async () =>
    "Default Applications Clock\n        Graphics : 3003 MHz";
  const b = await c._getClockBounds();
  assert.deepEqual(b.cpuBounds, [
    { minKhz: 1378000, maxKhz: 3900000 },
    { minKhz: 338000, maxKhz: 2808000 },
  ]);
  assert.equal(b.gpuCeilingMHz, 3003);
  assert.equal(b.gpuCeilingSource, "smi");
});

test("_getClockBounds falls back to GPU_CLOCK_MAX_MHZ with source=fallback on unparseable output", async () => {
  const c = localCollector();
  c._readLocalCpuBoundsDump = async () => "cpu0:338000:2808000";
  c._nvidiaSmi = async () => "Graphics : [N/A]";
  const b = await c._getClockBounds();
  assert.equal(b.gpuCeilingSource, "fallback");
  assert.equal(Number.isFinite(b.gpuCeilingMHz), true);
  assert.equal(b.gpuCeilingMHz, 3003); // documented default
});

test("remote bounds command dumps min/max freqs, -q -d CLOCK, then both boot units", () => {
  const c = new SystemCollector({ id: "t", kind: "spark", isLocal: false });
  const cmd = c._buildRemoteClockBoundsCommand();
  assert.match(cmd, /cpuinfo_min_freq/);
  assert.match(cmd, /cpuinfo_max_freq/);
  assert.match(cmd, /nvidia-smi -q -d CLOCK/);
  assert.match(cmd, /cpu-clock-cap\.service/);
  assert.match(cmd, /gpu-clock-lock\.service/);
  assert.equal((cmd.match(/echo '---'/g) || []).length, 3);
});

// ─── D4: the single apply path (host helper over SSH) ─────────────────────

const JOURNAL_SET_TO_1976 = 'GPU clocks set to "(gpuClkMin 0, gpuClkMax 1976)" for GPU 0000000F:01:00.0';
const JOURNAL_SET_TO_2200 = 'GPU clocks set to "(gpuClkMin 0, gpuClkMax 2200)" for GPU 0000000F:01:00.0';
const DONE = "All done.";

/** Collector whose helper SSH call returns `out` (or throws it when an Error). */
function helperCollector(out, opts = {}) {
  const c = new SystemCollector({
    id: "spark-test",
    kind: "spark",
    isLocal: opts.isLocal ?? true,
    ssh: { host: "127.0.0.1", user: "dgx" },
  });
  c.cmds = [];
  c._sshExec = async (_spark, cmd) => {
    c.cmds.push(String(cmd));
    if (out instanceof Error) throw out;
    return out;
  };
  // Any local exec / sysfs write here would be a regression: the container
  // path is gone and the server must never touch host state itself.
  c._exec = async (cmd) => {
    throw new Error(`no local exec allowed on the apply path: ${cmd}`);
  };
  return c;
}

test("the container apply/persist path no longer exists", () => {
  const c = new SystemCollector({ id: "t", kind: "spark", isLocal: true });
  assert.equal(c._applyClockCapLocal, undefined);
  assert.equal(c._persistClockUnitLocal, undefined);
  assert.equal(c._clockControlPaths, undefined);
});

test("a local unit whose helper is missing fails (423) — no container fallback", async () => {
  const c = helperCollector(new Error("missing /usr/local/bin/sparkdash-set-clock"));
  const res = await c.applyClockCap(
    { domain: "cpu-big", maxMHz: 2600, persist: false },
    { hardMinMHz: 1378, hardMaxMHz: 3900 }
  );
  assert.equal(res.ok, false);
  assert.equal(res.status, 423);
});

test("a remote unit with no helper fails without a container source", async () => {
  const c = helperCollector(new Error("ssh: connect to host x: No route to host"), { isLocal: false });
  const res = await c.applyClockCap(
    { domain: "gpu", maxMHz: 2200, persist: true },
    { hardMinMHz: 0, hardMaxMHz: 3003 }
  );
  assert.equal(res.ok, false);
  assert.notEqual(res.source, "container");
});

test("CPU apply: per-core read-back from the helper is the applied truth (item 6)", async () => {
  const c = helperCollector(
    [
      "core=cpu5 knob=scaling_max_freq khz=2600000",
      "core=cpu15 knob=scaling_max_freq khz=2600000",
      "persisted=0",
      DONE,
    ].join("\n"),
    { isLocal: false }
  );
  const res = await c.applyClockCap(
    { domain: "cpu-big", maxMHz: 2600, persist: false },
    { hardMinMHz: 1378, hardMaxMHz: 3900 }
  );
  assert.equal(res.ok, true);
  assert.equal(res.source, "helper");
  assert.equal(res.appliedMHz, 2600);
  assert.equal(res.verified, true, "a remote CPU apply is now verified from the helper echo");
  assert.equal(res.snapped, false);
  assert.deepEqual(res.knobs, [
    { core: "cpu5", knob: "scaling_max_freq" },
    { core: "cpu15", knob: "scaling_max_freq" },
  ]);
  assert.ok(!res.warnings.some((w) => /could not be read back/.test(w)));
  assert.equal(c._clockCapsOverride["cpu-big"], 2600);
});

test("CPU apply: a driver-clamped core reports the strictest read-back and flags the snap", async () => {
  const c = helperCollector(
    ["core=cpu5 knob=max_perf khz=1976000", "core=cpu6 knob=max_perf khz=2000000", "persisted=0", DONE].join("\n")
  );
  const res = await c.applyClockCap(
    { domain: "cpu-little", maxMHz: 2000, persist: false },
    { hardMinMHz: 338, hardMaxMHz: 2808 }
  );
  assert.equal(res.requestedMHz, 2000);
  assert.equal(res.appliedMHz, 1976);
  assert.equal(res.snapped, true);
  assert.ok(res.warnings.some((w) => /accepted 1976 MHz for a request of 2000/.test(w)));
  assert.equal(c._clockCapsOverride["cpu-little"], 1976);
});

test("CPU apply without read-back lines reports the request WITH a verification warning", async () => {
  const c = helperCollector(`persisted=0\n${DONE}`);
  const res = await c.applyClockCap(
    { domain: "cpu-big", maxMHz: 2600, persist: false },
    { hardMinMHz: 1378, hardMaxMHz: 3900 }
  );
  assert.equal(res.ok, true);
  assert.equal(res.appliedMHz, 2600);
  assert.equal(res.verified, false);
  assert.ok(res.warnings.some((w) => /could not be read back from the hardware/.test(w)));
});

test("persisted comes from the helper's persisted=1 line, not the request (item 5)", async () => {
  const c = helperCollector(`core=cpu0 knob=max_perf khz=2600000\npersisted=1\n${DONE}`);
  c._clockCapsOverride = { gpu: 2200 };
  const res = await c.applyClockCap(
    { domain: "cpu-big", maxMHz: 2600, persist: true },
    { hardMinMHz: 1378, hardMaxMHz: 3900 }
  );
  assert.equal(res.persisted, true);
  assert.equal(res.bootUnit, "cpu-clock-cap.service");
  assert.deepEqual(c._clockCapsOverride, {}, "a real persist drops volatile state");
  assert.ok(!res.warnings.some((w) => /reverts on reboot/.test(w)));
});

test("a persist the helper could not complete reports persisted:false + reboot warning (item 5)", async () => {
  const c = helperCollector(`core=cpu0 knob=max_perf khz=2600000\npersisted=0\n${DONE}`);
  const res = await c.applyClockCap(
    { domain: "cpu-big", maxMHz: 2600, persist: true },
    { hardMinMHz: 1378, hardMaxMHz: 3900 }
  );
  assert.equal(res.ok, true);
  assert.equal(res.persisted, false, "persist:true in the request must not become persisted:true");
  assert.equal(res.bootUnit, null);
  assert.ok(res.warnings.some((w) => /reverts on reboot/.test(w)));
  assert.equal(c._clockCapsOverride["cpu-big"], 2600);
});

test("a helper reply with no persisted= line is treated as not persisted", async () => {
  const c = helperCollector(`${JOURNAL_SET_TO_2200}\n${DONE}`);
  const res = await c.applyClockCap(
    { domain: "gpu", maxMHz: 2200, persist: true },
    { hardMinMHz: 0, hardMaxMHz: 3003 }
  );
  assert.equal(res.persisted, false);
});

test("GPU apply: the driver's quoted gpuClkMax is the applied truth", async () => {
  const c = helperCollector(`${JOURNAL_SET_TO_1976}\n${DONE}\npersisted=0\n${DONE}`);
  const res = await c.applyClockCap(
    { domain: "gpu", maxMHz: 2000, persist: false },
    { hardMinMHz: 0, hardMaxMHz: 3003 }
  );
  assert.match(c.cmds[0], /--domain .gpu. --max-mhz 2000 --no-persist/);
  assert.equal(res.ok, true);
  assert.equal(res.appliedMHz, 1976);
  assert.equal(res.snapped, true);
  assert.equal(res.verified, true);
  assert.ok(res.warnings.some((w) => /accepted 1976 MHz for a request of 2000/.test(w)));
  assert.equal(c._clockCapsOverride.gpu, 1976);
});

test("GPU apply with no set-to line carries an explicit verification warning", async () => {
  const c = helperCollector(`${DONE}\npersisted=0\n${DONE}`);
  const res = await c.applyClockCap(
    { domain: "gpu", maxMHz: 2200, persist: false },
    { hardMinMHz: 0, hardMaxMHz: 3003 }
  );
  assert.equal(res.appliedMHz, 2200);
  assert.equal(res.verified, false);
  assert.ok(res.warnings.some((w) => /could not be read back from the hardware/.test(w)));
});

test("a transcript without the completion line is a failure, never a success (done gate)", async () => {
  const c = helperCollector(JOURNAL_SET_TO_1976);
  const res = await c.applyClockCap(
    { domain: "gpu", maxMHz: 2000, persist: false },
    { hardMinMHz: 0, hardMaxMHz: 3003 }
  );
  assert.equal(res.ok, false);
  assert.equal(res.status, 502);
});

test("CPU cap removal: no bogus quantisation or read-back warning", async () => {
  const c = helperCollector(`core=cpu5 knob=max_perf khz=2808000\npersisted=0\n${DONE}`);
  const res = await c.applyClockCap(
    { domain: "cpu-little", maxMHz: null, persist: false },
    { hardMinMHz: 338, hardMaxMHz: 2808 }
  );
  assert.equal(res.ok, true);
  assert.equal(res.appliedMHz, null);
  assert.equal(res.snapped, false);
  assert.equal(res.verified, true);
  assert.match(c.cmds[0], /--unlock/);
  assert.ok(!res.warnings.some((w) => /accepted .* for a request|read back/.test(w)));
});

test("GPU cap removal clears the recorded lock and stays silent about verification", async () => {
  const c = helperCollector(`${DONE}\npersisted=0\n${DONE}`);
  const res = await c.applyClockCap(
    { domain: "gpu", maxMHz: null, persist: false },
    { hardMinMHz: 0, hardMaxMHz: 3003 }
  );
  assert.equal(res.appliedMHz, null);
  assert.ok(!res.warnings.some((w) => /read back|accepted/.test(w)));
  assert.equal(c._clockCapsOverride.gpu, null);
});

test("above-max requests are clamped server-side before the helper sees them (D2)", async () => {
  const c = helperCollector(`core=cpu0 knob=max_perf khz=2808000\npersisted=0\n${DONE}`);
  const res = await c.applyClockCap(
    { domain: "cpu-little", maxMHz: 9999, persist: false },
    { hardMinMHz: 338, hardMaxMHz: 2808 }
  );
  assert.match(c.cmds[0], /--max-mhz 2808 /);
  assert.equal(res.requestedMHz, 9999);
  assert.equal(res.appliedMHz, 2808);
  assert.equal(res.snapped, true);
  assert.ok(res.warnings.some((w) => /clamped/.test(w)));
});

test("_verifyAppliedClockCap reads only the helper transcript (never local sysfs)", () => {
  const c = new SystemCollector({ id: "t", kind: "spark", isLocal: true });
  c._readSysFile = () => {
    throw new Error("verification must not read local sysfs");
  };
  assert.equal(c._verifyAppliedClockCap("gpu", JOURNAL_SET_TO_2200), 2200);
  assert.equal(c._verifyAppliedClockCap("gpu", DONE), null);
  assert.equal(c._verifyAppliedClockCap("cpu-big", "core=cpu0 knob=scaling_max_freq khz=2600000"), 2600);
  assert.equal(c._verifyAppliedClockCap("cpu-big", "no observation"), null);
});

test("the local cap dump falls back to scaling_max_freq when max_perf is absent", async () => {
  const c = new SystemCollector({ id: "t", kind: "spark", isLocal: true });
  const fsMod = await import("node:fs");
  const orig = fsMod.default.readdirSync;
  fsMod.default.readdirSync = () => ["cpu15"];
  c._readSysFile = (p) =>
    /scaling_max_freq$/.test(p) ? "2600000\n" : /cpuinfo_max_freq$/.test(p) ? "3900000\n" : null;
  try {
    assert.equal(await c._readLocalCpuCapDump(), "cpu15:2600000:3900000");
  } finally {
    fsMod.default.readdirSync = orig;
  }
});

test("a unit with no SSH settings gets an explicit 423, never a container write", async () => {
  const c = new SystemCollector({ id: "local", kind: "spark", isLocal: true });
  c._sshExec = async () => {
    throw new Error("must not attempt SSH without settings");
  };
  const res = await c.applyClockCap(
    { domain: "gpu", maxMHz: 2200, persist: false },
    { hardMinMHz: 0, hardMaxMHz: 3003 }
  );
  assert.equal(res.ok, false);
  assert.equal(res.status, 423);
  assert.match(res.reason, /SSH host and user/);
  const probe = await c.checkClockHelper();
  assert.equal(probe.available, false);
  assert.match(probe.reason, /SSH host and user/);
});
