// Helper-behaviour tests for scripts/sparkdash-clock-addon/sparkdash-set-clock.
//
// The helper runs against a stubbed sysfs tree under a temp dir (via the
// SPARKDASH_CPU_SYS / SPARKDASH_UNIT_DIR / SPARKDASH_SMI test hooks; sudo's
// env reset means a real remote invocation always uses the real /sys and
// /etc). Executed with `sh` — POSIX syntax only. Nothing here touches the
// real /sys, /etc, or /usr/local.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const HELPER = path.join(ROOT, "scripts", "sparkdash-clock-addon", "sparkdash-set-clock");
const INSTALLER = path.join(ROOT, "scripts", "sparkdash-clock-addon", "install-clock-helper.sh");

/**
 * Stub sysfs: cores → { maxKhz, minKhz?, perfKhz?, scalingKhz?, perfReadOnly? }.
 * perfKhz creates max_perf; scalingKhz creates scaling_max_freq. A core with
 * only scalingKhz mirrors iris (cppc_cpufreq, no max_perf node).
 */
function makeSysfs(root, cores) {
  const cpuRoot = path.join(root, "sys");
  for (const [cpuN, c] of Object.entries(cores)) {
    const dir = path.join(cpuRoot, cpuN, "cpufreq");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "cpuinfo_max_freq"), `${c.maxKhz}\n`);
    if (c.minKhz != null) fs.writeFileSync(path.join(dir, "cpuinfo_min_freq"), `${c.minKhz}\n`);
    if (c.perfKhz != null) {
      fs.writeFileSync(path.join(dir, "max_perf"), `${c.perfKhz}\n`);
      if (c.perfReadOnly) fs.chmodSync(path.join(dir, "max_perf"), 0o444);
    }
    if (c.scalingKhz != null) fs.writeFileSync(path.join(dir, "scaling_max_freq"), `${c.scalingKhz}\n`);
  }
  return cpuRoot;
}

const read = (cpuRoot, cpuN, f) => fs.readFileSync(path.join(cpuRoot, cpuN, "cpufreq", f), "utf8").trim();

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clock-helper-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Run the helper; returns { stdout, status, stderr } (never throws). */
function runHelper(cpuRoot, args, opts = {}) {
  const unitDir = opts.unitDir ?? path.join(cpuRoot, "..", "units");
  fs.mkdirSync(unitDir, { recursive: true });
  const stubDir = path.join(path.dirname(cpuRoot), "stub-bin");
  fs.mkdirSync(stubDir, { recursive: true });
  const smiPath = path.join(stubDir, "nvidia-smi");
  fs.writeFileSync(path.join(stubDir, "systemctl"), "#!/bin/sh\nexit 0\n");
  fs.writeFileSync(smiPath, `#!/bin/sh\n${opts.smiBody ?? 'echo "All done."'}\n`);
  fs.chmodSync(path.join(stubDir, "systemctl"), 0o755);
  fs.chmodSync(smiPath, 0o755);
  try {
    const stdout = execFileSync("sh", [HELPER, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        PATH: `${stubDir}:${process.env.PATH}`,
        SPARKDASH_CPU_SYS: cpuRoot,
        SPARKDASH_UNIT_DIR: unitDir,
        SPARKDASH_SMI: smiPath,
      },
    });
    return { stdout, status: 0, stderr: "", smiPath, unitDir };
  } catch (e) {
    return { stdout: String(e.stdout ?? ""), status: e.status, stderr: String(e.stderr ?? ""), smiPath, unitDir };
  }
}

const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

// ─── output contract ───────────────────────────────────────

test("every success ends with persisted=<0|1> then All done.", (t) => {
  const cpuRoot = makeSysfs(tmp(t), { cpu0: { maxKhz: 3900000, perfKhz: 3900000 } });
  const r = runHelper(cpuRoot, ["--domain", "cpu-big", "--max-mhz", "2600", "--no-persist"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^core=cpu0 knob=max_perf khz=2600000$/m);
  assert.match(r.stdout, /persisted=0\nAll done\.\n$/);
});

test("--check prints the ok line, exits 0, and touches nothing", (t) => {
  const cpuRoot = makeSysfs(tmp(t), { cpu0: { maxKhz: 3900000, perfKhz: 3900000 } });
  const r = runHelper(cpuRoot, ["--check"]);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "sparkdash-set-clock: ok\n");
  assert.equal(read(cpuRoot, "cpu0", "max_perf"), "3900000");
  assert.equal(runHelper(cpuRoot, ["--check", "--domain", "gpu"]).status, 1, "--check takes no other args");
});

test("an argumentless invocation prints usage and exits 1", (t) => {
  const r = runHelper(makeSysfs(tmp(t), {}), []);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^usage: /m);
});

test("an empty or non-numeric --max-mhz is refused", (t) => {
  const cpuRoot = makeSysfs(tmp(t), { cpu0: { maxKhz: 3900000, perfKhz: 3900000 } });
  for (const v of ["", "12a", "-5", "0"]) {
    const r = runHelper(cpuRoot, ["--domain", "cpu-big", "--max-mhz", v, "--no-persist"]);
    assert.equal(r.status, 1, `value ${JSON.stringify(v)} must be refused`);
  }
  assert.equal(read(cpuRoot, "cpu0", "max_perf"), "3900000");
});

test("an unsupported domain exits 3 without writing any unit", (t) => {
  const cpuRoot = makeSysfs(tmp(t), { cpu0: { maxKhz: 2808000, perfKhz: 2808000 } });
  const r = runHelper(cpuRoot, ["--domain", "mem", "--max-mhz", "2200", "--persist"]);
  assert.equal(r.status, 3);
  assert.deepEqual(fs.readdirSync(r.unitDir), []);
});

// ─── item 2: clamp + apply-before-persist ──────────────────

test("cpu_apply clamps to each core's own cpuinfo_min/max", (t) => {
  const cpuRoot = makeSysfs(tmp(t), {
    cpu0: { maxKhz: 3900000, minKhz: 1378000, perfKhz: 3900000 },
    cpu1: { maxKhz: 3900000, minKhz: 1378000, perfKhz: 3900000 },
  });
  runHelper(cpuRoot, ["--domain", "cpu-big", "--max-mhz", "9999", "--no-persist"]);
  assert.equal(read(cpuRoot, "cpu0", "max_perf"), "3900000");
  runHelper(cpuRoot, ["--domain", "cpu-big", "--max-mhz", "100", "--no-persist"]);
  assert.equal(read(cpuRoot, "cpu1", "max_perf"), "1378000");
});

test("a failed apply exits nonzero and writes NO boot unit", { skip: isRoot && "root ignores file modes" }, (t) => {
  const cpuRoot = makeSysfs(tmp(t), { cpu0: { maxKhz: 3900000, perfKhz: 3900000, perfReadOnly: true } });
  const r = runHelper(cpuRoot, ["--domain", "cpu-big", "--max-mhz", "2600", "--persist"]);
  assert.equal(r.status, 4);
  assert.match(r.stderr, /nothing persisted/);
  assert.ok(!fs.existsSync(path.join(r.unitDir, "cpu-clock-cap.service")));
  assert.doesNotMatch(r.stdout, /All done\./);
});

test("a failed GPU apply exits 4 and writes no unit", (t) => {
  const cpuRoot = makeSysfs(tmp(t), {});
  const r = runHelper(cpuRoot, ["--domain", "gpu", "--max-mhz", "2200", "--persist"], { smiBody: "exit 9" });
  assert.equal(r.status, 4);
  assert.ok(!fs.existsSync(path.join(r.unitDir, "gpu-clock-lock.service")));
});

// ─── item 2 add-on: scaling_max_freq fallback (iris / cppc_cpufreq) ──────

test("iris shape: no max_perf node → writes scaling_max_freq and echoes that knob", (t) => {
  const cpuRoot = makeSysfs(tmp(t), {
    cpu5: { maxKhz: 3900000, minKhz: 1378000, scalingKhz: 3900000 },
    cpu15: { maxKhz: 3900000, minKhz: 1378000, scalingKhz: 3900000 },
    cpu0: { maxKhz: 2808000, minKhz: 338000, scalingKhz: 2808000 },
  });
  const r = runHelper(cpuRoot, ["--domain", "cpu-big", "--max-mhz", "2600", "--no-persist"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(read(cpuRoot, "cpu5", "scaling_max_freq"), "2600000");
  assert.equal(read(cpuRoot, "cpu15", "scaling_max_freq"), "2600000");
  assert.equal(read(cpuRoot, "cpu0", "scaling_max_freq"), "2808000", "sibling untouched");
  assert.ok(!fs.existsSync(path.join(cpuRoot, "cpu5", "cpufreq", "max_perf")), "never invents max_perf");
  assert.match(r.stdout, /^core=cpu5 knob=scaling_max_freq khz=2600000$/m);
  assert.match(r.stdout, /^core=cpu15 knob=scaling_max_freq khz=2600000$/m);
  assert.doesNotMatch(r.stdout, /knob=max_perf/);
});

test("an unwritable max_perf falls back to scaling_max_freq", { skip: isRoot && "root ignores file modes" }, (t) => {
  const cpuRoot = makeSysfs(tmp(t), {
    cpu0: { maxKhz: 3900000, perfKhz: 3900000, perfReadOnly: true, scalingKhz: 3900000 },
  });
  const r = runHelper(cpuRoot, ["--domain", "cpu-big", "--max-mhz", "2600", "--no-persist"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(read(cpuRoot, "cpu0", "scaling_max_freq"), "2600000");
  assert.match(r.stdout, /^core=cpu0 knob=scaling_max_freq khz=2600000$/m);
});

test("a persist after a max_perf→scaling fallback targets scaling_max_freq in the unit", { skip: isRoot && "root ignores file modes" }, (t) => {
  const cpuRoot = makeSysfs(tmp(t), {
    cpu0: { maxKhz: 3900000, perfKhz: 3900000, perfReadOnly: true, scalingKhz: 3900000 },
  });
  const r = runHelper(cpuRoot, ["--domain", "cpu-big", "--max-mhz", "2600", "--persist"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /persisted=1/);
  const unit = fs.readFileSync(path.join(r.unitDir, "cpu-clock-cap.service"), "utf8");
  assert.match(unit, /echo 2600000 > \S*cpu0\/cpufreq\/scaling_max_freq/);
  assert.doesNotMatch(unit, /max_perf/, "never boot-write the file that just refused the live write");
});

test("iris shape persist: the boot unit targets scaling_max_freq for both domains", (t) => {
  const cpuRoot = makeSysfs(tmp(t), {
    cpu5: { maxKhz: 3900000, scalingKhz: 3900000 },
    cpu0: { maxKhz: 2808000, scalingKhz: 2400000 },
  });
  const r = runHelper(cpuRoot, ["--domain", "cpu-big", "--max-mhz", "2600", "--persist"]);
  assert.match(r.stdout, /persisted=1/);
  const unit = fs.readFileSync(path.join(r.unitDir, "cpu-clock-cap.service"), "utf8");
  assert.match(unit, /echo 2600000 > \S*cpu5\/cpufreq\/scaling_max_freq/);
  assert.match(unit, /echo 2400000 > \S*cpu0\/cpufreq\/scaling_max_freq/);
  assert.doesNotMatch(unit, /max_perf/);
});

// ─── shared boot unit: the sibling survives a single-domain persist ───────

test("a cpu-little persist preserves the sibling big domain's live cap", (t) => {
  const cpuRoot = makeSysfs(tmp(t), {
    cpu0: { maxKhz: 3900000, perfKhz: 2600000 },
    cpu1: { maxKhz: 3900000, perfKhz: 2600000 },
    cpu5: { maxKhz: 2808000, perfKhz: 2808000 },
    cpu6: { maxKhz: 2808000, perfKhz: 2808000 },
  });
  const r = runHelper(cpuRoot, ["--domain", "cpu-little", "--max-mhz", "2400", "--persist"]);
  const unit = fs.readFileSync(path.join(r.unitDir, "cpu-clock-cap.service"), "utf8");
  assert.match(unit, /echo 2400000 > \S*cpu5\/cpufreq\/max_perf/);
  assert.match(unit, /echo 2400000 > \S*cpu6\/cpufreq\/max_perf/);
  assert.match(unit, /echo 2600000 > \S*cpu0\/cpufreq\/max_perf/);
  assert.match(unit, /echo 2600000 > \S*cpu1\/cpufreq\/max_perf/);
  assert.doesNotMatch(unit, /\$c\b/, "no shell loop variables in a unit");
});

test("a remove-cap persist restores own hardware max and keeps the sibling", (t) => {
  const cpuRoot = makeSysfs(tmp(t), {
    cpu0: { maxKhz: 3900000, perfKhz: 2600000 },
    cpu5: { maxKhz: 2808000, perfKhz: 2200000 },
  });
  const r = runHelper(cpuRoot, ["--domain", "cpu-little", "--unlock", "--persist"]);
  assert.equal(read(cpuRoot, "cpu5", "max_perf"), "2808000");
  const unit = fs.readFileSync(path.join(r.unitDir, "cpu-clock-cap.service"), "utf8");
  assert.match(unit, /cat \S*cpu5\/cpufreq\/cpuinfo_max_freq > \S*cpu5\/cpufreq\/max_perf/);
  assert.match(unit, /echo 2600000 > \S*cpu0\/cpufreq\/max_perf/);
});

// ─── item 5: persist is enabled, and reported honestly ────────────────────

test("a successful persist enables the unit and prints persisted=1", (t) => {
  const cpuRoot = makeSysfs(tmp(t), { cpu0: { maxKhz: 2808000, perfKhz: 2808000 } });
  const r = runHelper(cpuRoot, ["--domain", "gpu", "--max-mhz", "2200", "--persist"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /persisted=1\nAll done\.\n$/);
  const unit = fs.readFileSync(path.join(r.unitDir, "gpu-clock-lock.service"), "utf8");
  assert.match(unit, new RegExp(`^ExecStart=${r.smiPath.replace(/[/\\]/g, "\\$&")} -lgc 0,2200$`, "m"));
  assert.ok(fs.lstatSync(path.join(r.unitDir, "multi-user.target.wants", "gpu-clock-lock.service")).isSymbolicLink());
});

test("--no-persist writes no unit and prints persisted=0", (t) => {
  const cpuRoot = makeSysfs(tmp(t), { cpu0: { maxKhz: 2808000, perfKhz: 2808000 } });
  const r = runHelper(cpuRoot, ["--domain", "cpu-little", "--max-mhz", "2400", "--no-persist"]);
  assert.match(r.stdout, /persisted=0/);
  assert.deepEqual(fs.readdirSync(r.unitDir), []);
});

// ─── item 1: the installer's sudoers pins argv ─────────────────────────────

test("installer generates digits-only anchored regex pins, no glob [0-9]*", () => {
  const body = fs.readFileSync(INSTALLER, "utf8");
  assert.doesNotMatch(body, /\[0-9\]\*/, "glob [0-9]* matches empty and any trailing text");
  const pins = body.match(/\^--domain \$d --max-mhz \[0-9\]\+ --(no-)?persist/g) || [];
  assert.equal(pins.length, 3, "persist + no-persist (gpu and non-gpu branches) regex pins");
  assert.match(body, /echo "  \$HELLO_DST --check, /, "the probe is a pinned --check entry");
  // No bare-binary entry: every alias line carries arguments after the path.
  const bare = body.split("\n").filter((l) => /echo "  \$HELLO_DST(, |\s*\\)/.test(l) || /echo "  \$HELLO_DST,/.test(l));
  assert.deepEqual(bare, [], "a bare binary entry would mean any argv in sudoers");
  assert.doesNotMatch(body, /useradd/, "no login account is created (operator SSH user model)");
});

const VISUDO = ["/usr/sbin/visudo", "/usr/bin/visudo"].find((p) => fs.existsSync(p));

test("the generated sudoers drop-in passes visudo -c", { skip: !VISUDO && "visudo not installed" }, (t) => {
  const dir = tmp(t);
  const out = path.join(dir, "sparkdash-clock");
  // Run the real installer with only its privileged side effects redirected.
  const body = fs
    .readFileSync(INSTALLER, "utf8")
    .replace(/^SUDOERS_DST=.*$/m, `SUDOERS_DST=${out}`)
    .replace(/install -m 0755 "\$HELLO_SRC" "\$HELLO_DST"/, ":")
    .replace(/\[ "\$\(id -u\)" -eq 0 \]/, "true")
    .replace(/install -m 0440 "\$TMP" "\$SUDOERS_DST"/, 'cp "$TMP" "$SUDOERS_DST"')
    .replace(/^visudo /m, `${VISUDO} `);
  const script = path.join(dir, "install.sh");
  fs.writeFileSync(script, body);
  fs.copyFileSync(HELPER, path.join(dir, "sparkdash-set-clock"));
  execFileSync("sh", [script], {
    env: { ...process.env, SPARKDASH_SSH_USER: os.userInfo().username },
    stdio: "pipe",
  });
  execFileSync(VISUDO, ["-c", "-f", out], { stdio: "pipe" });
  const text = fs.readFileSync(out, "utf8");
  const entries = text.split("\n").filter((l) => /^\s+\/usr\/local\/bin\/sparkdash-set-clock/.test(l));
  assert.equal(entries.length, 13, "--check + 4 forms x 3 domains");
  for (const e of entries) {
    assert.match(e, /sparkdash-set-clock \S/, `entry must carry argv: ${e}`);
  }
  assert.doesNotMatch(text, /\[0-9\]\*/);
});
