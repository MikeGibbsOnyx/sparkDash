#!/usr/bin/env python3
"""Local recorded test gate for scripts/weights/store.py. No dens, no /srv/weights."""
from __future__ import annotations

import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
STORE = HERE / "store.py"
BOOT = HERE / "bootstrap-store.sh"


def run(args, env=None, cwd=None) -> subprocess.CompletedProcess:
    e = os.environ.copy()
    e.pop("WEIGHTS_STORE_GO", None)
    if env:
        e.update(env)
    return subprocess.run(
        [sys.executable, str(STORE), *args],
        cwd=cwd or str(HERE),
        env=e,
        capture_output=True,
        text=True,
    )


class StoreTests(unittest.TestCase):
    def test_dry_run_does_not_write(self):
        with tempfile.TemporaryDirectory() as td:
            src = Path(td) / "src"
            src.mkdir()
            (src / "w.bin").write_bytes(b"hello")
            root = Path(td) / "store"
            r = run(
                [
                    "ingest",
                    "--source",
                    str(src),
                    "--family",
                    "deepseek",
                    "--variant",
                    "DS4-Flash-0731-FP8",
                    "--root",
                    str(root),
                ]
            )
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertIn("dry-run", r.stdout)
            self.assertFalse((root / "deepseek").exists())

    def test_ingest_verify_manifest_pull(self):
        with tempfile.TemporaryDirectory() as td:
            src = Path(td) / "src"
            src.mkdir()
            (src / "weights.bin").write_bytes(b"payload-bytes-01")
            (src / "nested").mkdir()
            (src / "nested" / "ok.txt").write_text("ok\n", encoding="utf-8")
            root = Path(td) / "store"
            r = run(
                [
                    "ingest",
                    "--source",
                    str(src),
                    "--family",
                    "deepseek",
                    "--variant",
                    "DS4-Flash-0731-FP8",
                    "--quant",
                    "FP8",
                    "--params",
                    "284B-MoE",
                    "--hf-repo",
                    "deepseek-ai/example",
                    "--root",
                    str(root),
                    "--verify-after",
                    "--apply",
                ]
            )
            self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
            dest = root / "deepseek" / "DS4-Flash-0731-FP8"
            self.assertTrue((dest / "MODEL.toml").is_file())
            self.assertTrue((dest / "MODEL.sha256").is_file())
            toml = (dest / "MODEL.toml").read_text(encoding="utf-8")
            self.assertIn('status = "verified"', toml)
            self.assertIn("size_bytes = ", toml)

            v = run(
                [
                    "verify",
                    "--family",
                    "deepseek",
                    "--variant",
                    "DS4-Flash-0731-FP8",
                    "--root",
                    str(root),
                ]
            )
            self.assertEqual(v.returncode, 0, v.stderr)
            self.assertIn("PASS", v.stdout)

            m = run(["manifest", "--root", str(root), "--verified-only"])
            self.assertEqual(m.returncode, 0, m.stderr)
            self.assertIn("DS4-Flash-0731-FP8", m.stdout)
            self.assertIn('"count": 1', m.stdout)

            cache = Path(td) / "cache"
            p = run(
                [
                    "pull",
                    "--family",
                    "deepseek",
                    "--variant",
                    "DS4-Flash-0731-FP8",
                    "--root",
                    str(root),
                    "--dest",
                    str(cache),
                    "--apply",
                ]
            )
            self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
            self.assertTrue((cache / "weights.bin").is_file())

    def test_verify_detects_tamper(self):
        with tempfile.TemporaryDirectory() as td:
            src = Path(td) / "src"
            src.mkdir()
            (src / "w.bin").write_bytes(b"aaaa")
            root = Path(td) / "store"
            r = run(
                [
                    "ingest",
                    "--source",
                    str(src),
                    "--family",
                    "glm",
                    "--variant",
                    "GLM-5.3-exl3",
                    "--root",
                    str(root),
                    "--apply",
                ]
            )
            self.assertEqual(r.returncode, 0, r.stderr)
            dest = root / "glm" / "GLM-5.3-exl3"
            (dest / "w.bin").write_bytes(b"bbbb")
            v = run(
                [
                    "verify",
                    "--family",
                    "glm",
                    "--variant",
                    "GLM-5.3-exl3",
                    "--root",
                    str(root),
                ]
            )
            self.assertEqual(v.returncode, 1)
            self.assertIn("FAIL", v.stderr)

    def test_go_gate_blocks_canonical_apply(self):
        # Dest is the canonical root; apply must refuse before mkdir/copy.
        with tempfile.TemporaryDirectory() as td:
            src = Path(td) / "src"
            src.mkdir()
            (src / "w.bin").write_bytes(b"x")
            r = run(
                [
                    "ingest",
                    "--source",
                    str(src),
                    "--family",
                    "deepseek",
                    "--variant",
                    "nope",
                    "--root",
                    "/srv/weights",
                    "--apply",
                ]
            )
        self.assertEqual(r.returncode, 1)
        self.assertIn("WEIGHTS_STORE_GO=1", r.stderr)
        self.assertFalse(Path("/srv/weights/deepseek").exists())

    def test_bad_family_rejected(self):
        with tempfile.TemporaryDirectory() as td:
            src = Path(td) / "src"
            src.mkdir()
            (src / "w.bin").write_bytes(b"x")
            r = run(
                [
                    "ingest",
                    "--source",
                    str(src),
                    "--family",
                    "DeepSeek",
                    "--variant",
                    "x",
                    "--root",
                    str(Path(td) / "store"),
                    "--apply",
                ]
            )
            self.assertEqual(r.returncode, 1)
            self.assertIn("bad family", r.stderr)

    def test_bootstrap_dry_run(self):
        r = subprocess.run(
            ["bash", str(BOOT)],
            capture_output=True,
            text=True,
            env={**os.environ, "WEIGHTS_STORE_GO": ""},
        )
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("dry-run", r.stdout)
        self.assertIn("/srv/weights", r.stdout)

    def test_bootstrap_apply_without_go_refuses(self):
        r = subprocess.run(
            ["bash", str(BOOT), "--apply"],
            capture_output=True,
            text=True,
            env={k: v for k, v in os.environ.items() if k != "WEIGHTS_STORE_GO"},
        )
        self.assertEqual(r.returncode, 2)
        self.assertIn("WEIGHTS_STORE_GO=1", r.stderr)


if __name__ == "__main__":
    unittest.main(verbosity=2)
