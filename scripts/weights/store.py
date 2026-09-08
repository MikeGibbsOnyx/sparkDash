#!/usr/bin/env python3
"""Canonical weights-store tooling (FLEET-OPS.md §1).

Subcommands: ingest | verify | manifest | pull

Hard gate: any write under /srv/weights (or WEIGHTS_STORE_ROOT if it
resolves there) requires env WEIGHTS_STORE_GO=1 AND --apply.
Default is dry-run. Stdlib only.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

CANONICAL_ROOT = Path("/srv/weights")
MODEL_TOML = "MODEL.toml"
MODEL_SHA = "MODEL.sha256"
SKIP_NAMES = {MODEL_TOML, MODEL_SHA}
CHUNK = 8 * 1024 * 1024
STATUSES = ("candidate", "verified", "retired")


def utc_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def eprint(*a) -> None:
    print(*a, file=sys.stderr)


def dumps_toml(data: dict) -> str:
    lines = []
    for key, val in data.items():
        if val is None:
            continue
        if isinstance(val, bool):
            lines.append(f"{key} = {'true' if val else 'false'}")
        elif isinstance(val, int) and not isinstance(val, bool):
            lines.append(f"{key} = {val}")
        else:
            escaped = str(val).replace("\\", "\\\\").replace('"', '\\"')
            lines.append(f'{key} = "{escaped}"')
    return "\n".join(lines) + "\n"


def loads_toml(text: str) -> dict:
    import tomllib

    return tomllib.loads(text)


def resolve_root(raw: str | None) -> Path:
    return Path(raw or os.environ.get("WEIGHTS_STORE_ROOT", str(CANONICAL_ROOT))).expanduser()


def is_canonical(path: Path) -> bool:
    try:
        resolved = path.resolve()
    except OSError:
        resolved = path
    canon = CANONICAL_ROOT.resolve() if CANONICAL_ROOT.exists() else CANONICAL_ROOT
    if resolved == canon:
        return True
    try:
        return resolved.is_relative_to(canon)
    except AttributeError:
        return str(resolved).startswith(str(canon) + os.sep)


def require_go_for(path: Path, apply: bool) -> None:
    if not apply:
        return
    if not is_canonical(path):
        return
    if os.environ.get("WEIGHTS_STORE_GO") != "1":
        sys.exit(
            "refusing: canonical store write requires WEIGHTS_STORE_GO=1 "
            f"(dest={path})"
        )


def iter_payload_files(variant_dir: Path) -> list[Path]:
    files = []
    for p in sorted(variant_dir.rglob("*")):
        if not p.is_file():
            continue
        if p.name in SKIP_NAMES:
            continue
        files.append(p)
    return files


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        while True:
            chunk = f.read(CHUNK)
            if not chunk:
                break
            h.update(chunk)
    return h.hexdigest()


def write_sha256(variant_dir: Path) -> tuple[int, int]:
    """Write MODEL.sha256 (GNU sha256sum two-space format). Returns (nfiles, nbytes)."""
    lines = []
    nbytes = 0
    for path in iter_payload_files(variant_dir):
        digest = sha256_file(path)
        rel = path.relative_to(variant_dir).as_posix()
        lines.append(f"{digest}  {rel}")
        nbytes += path.stat().st_size
    (variant_dir / MODEL_SHA).write_text("\n".join(lines) + ("\n" if lines else ""), encoding="utf-8")
    return len(lines), nbytes


def read_toml(variant_dir: Path) -> dict:
    return loads_toml((variant_dir / MODEL_TOML).read_text(encoding="utf-8"))


def write_toml(variant_dir: Path, data: dict) -> None:
    (variant_dir / MODEL_TOML).write_text(dumps_toml(data), encoding="utf-8")


def copy_tree(src: Path, dst: Path) -> None:
    dst.mkdir(parents=True, exist_ok=True)
    rsync = shutil.which("rsync")
    if rsync:
        subprocess.check_call([rsync, "-a", f"{src}/", f"{dst}/"])
        return
    shutil.copytree(src, dst, dirs_exist_ok=True)


def variant_dir(root: Path, family: str, variant: str) -> Path:
    if not family or family != family.lower() or "/" in family or ".." in family:
        sys.exit(f"bad family {family!r}: lowercase, no slash")
    if not variant or "/" in variant or ".." in variant:
        sys.exit(f"bad variant {variant!r}: no slash")
    return root / family / variant


def cmd_ingest(args: argparse.Namespace) -> int:
    root = resolve_root(args.root)
    dest = variant_dir(root, args.family, args.variant)
    source = Path(args.source).expanduser().resolve()
    apply = args.apply
    require_go_for(dest, apply)

    if not source.exists():
        sys.exit(f"source missing: {source}")

    print(f"ingest family={args.family} variant={args.variant}")
    print(f"  source={source}")
    print(f"  dest={dest}")
    print(f"  apply={apply} in_place={args.in_place}")

    if not apply:
        print("dry-run: no copy, no MODEL.toml, no hashes")
        return 0

    if args.in_place:
        if source != dest.resolve() and source != dest:
            # in-place means dest IS source; allow dest to be created as source
            dest = source
        dest.mkdir(parents=True, exist_ok=True)
    else:
        dest.mkdir(parents=True, exist_ok=True)
        copy_tree(source, dest)

    nfiles, nbytes = write_sha256(dest)
    meta = {
        "name": args.variant,
        "family": args.family,
        "variant": args.variant,
        "quant": args.quant or "",
        "params": args.params or "",
        "size_bytes": nbytes,
        "source_hf_repo": args.hf_repo or "",
        "source_hf_commit": args.hf_commit or "",
        "source_host": args.source_host or "",
        "source_path": str(source),
        "ingested_utc": utc_now(),
        "verified_by": "",
        "verified_utc": "",
        "status": "candidate",
        "retention_note": "",
    }
    write_toml(dest, meta)
    print(f"  wrote {MODEL_TOML} status=candidate files={nfiles} size_bytes={nbytes}")

    if args.verify_after:
        return verify_one(dest, apply=True, set_verified=True)
    return 0


def parse_sha256_line(line: str) -> tuple[str, str] | None:
    line = line.rstrip("\n")
    if not line or line.startswith("#"):
        return None
    if "  " in line:
        digest, name = line.split("  ", 1)
        return digest, name
    parts = line.split()
    if len(parts) >= 2:
        return parts[0], parts[-1]
    return None


def verify_one(dest: Path, apply: bool, set_verified: bool) -> int:
    sha_path = dest / MODEL_SHA
    toml_path = dest / MODEL_TOML
    if not sha_path.is_file():
        eprint(f"FAIL: missing {sha_path}")
        return 1
    if not toml_path.is_file():
        eprint(f"FAIL: missing {toml_path}")
        return 1
    meta = read_toml(dest)
    bad = 0
    checked = 0
    for raw in sha_path.read_text(encoding="utf-8").splitlines():
        parsed = parse_sha256_line(raw)
        if not parsed:
            continue
        digest, rel = parsed
        path = dest / rel
        checked += 1
        if not path.is_file():
            eprint(f"FAIL missing {rel}")
            bad += 1
            continue
        got = sha256_file(path)
        if got != digest:
            eprint(f"FAIL hash {rel}")
            bad += 1
    if bad:
        eprint(f"FAIL {dest}: {bad}/{checked} mismatch")
        return 1
    print(f"PASS {dest}: {checked} files")
    if set_verified and apply:
        require_go_for(dest, apply)
        meta["status"] = "verified"
        meta["verified_utc"] = utc_now()
        meta["verified_by"] = os.environ.get("USER") or os.environ.get("LOGNAME") or "unknown"
        write_toml(dest, meta)
        print("  status -> verified")
    return 0


def cmd_verify(args: argparse.Namespace) -> int:
    root = resolve_root(args.root)
    apply = args.apply
    if args.family and args.variant:
        dest = variant_dir(root, args.family, args.variant)
        require_go_for(dest, apply)
        if not dest.is_dir():
            sys.exit(f"missing variant dir {dest}")
        return verify_one(dest, apply=apply, set_verified=args.set_verified)
    # walk
    rc = 0
    found = 0
    for toml in sorted(root.glob(f"*/*/{MODEL_TOML}")):
        dest = toml.parent
        found += 1
        rc |= verify_one(dest, apply=False, set_verified=False)
    if found == 0:
        eprint(f"no {MODEL_TOML} under {root}")
        return 1
    return rc


def walk_models(root: Path) -> list[dict]:
    rows = []
    if not root.exists():
        return rows
    for toml in sorted(root.glob(f"*/*/{MODEL_TOML}")):
        dest = toml.parent
        meta = read_toml(dest)
        sha = dest / MODEL_SHA
        rows.append(
            {
                "family": meta.get("family", dest.parent.name),
                "variant": meta.get("variant", dest.name),
                "quant": meta.get("quant", ""),
                "params": meta.get("params", ""),
                "status": meta.get("status", "candidate"),
                "size_bytes": int(meta.get("size_bytes") or 0),
                "path": f"{dest.parent.name}/{dest.name}",
                "ingested_utc": meta.get("ingested_utc", ""),
                "verified_utc": meta.get("verified_utc", ""),
                "verified_by": meta.get("verified_by", ""),
                "source_hf_repo": meta.get("source_hf_repo", ""),
                "has_sha256": sha.is_file(),
            }
        )
    return rows


def cmd_manifest(args: argparse.Namespace) -> int:
    root = resolve_root(args.root)
    rows = walk_models(root)
    if args.verified_only:
        rows = [r for r in rows if r["status"] == "verified"]
    payload = {
        "generated_utc": utc_now(),
        "origin": str(root),
        "count": len(rows),
        "models": rows,
    }
    text = json.dumps(payload, indent=2) + "\n"
    if args.out:
        out = Path(args.out)
        if args.apply:
            require_go_for(out, True)
            out.parent.mkdir(parents=True, exist_ok=True)
            out.write_text(text, encoding="utf-8")
            print(f"wrote {out}")
        else:
            print(f"dry-run would write {out} ({len(rows)} models)")
    print(text, end="")
    if args.markdown:
        md = ["# weights manifest", "", f"generated: {payload['generated_utc']}", f"origin: `{root}`", ""]
        md.append("| family | variant | quant | status | size_bytes | verified_utc |")
        md.append("|---|---|---|---|---|---|")
        for r in rows:
            md.append(
                f"| {r['family']} | {r['variant']} | {r['quant']} | {r['status']} | {r['size_bytes']} | {r['verified_utc']} |"
            )
        md_text = "\n".join(md) + "\n"
        if args.markdown_out and args.apply:
            Path(args.markdown_out).write_text(md_text, encoding="utf-8")
        else:
            print(md_text)
    return 0


def cmd_pull(args: argparse.Namespace) -> int:
    """rsync a verified variant to a local cache, then verify hashes."""
    root = resolve_root(args.root)
    dest_cache = Path(args.dest).expanduser()
    src = variant_dir(root, args.family, args.variant)
    apply = args.apply
    require_go_for(src, apply)
    require_go_for(dest_cache, apply)

    meta_path = src / MODEL_TOML
    if apply and not meta_path.is_file():
        sys.exit(f"source not ingested: {src}")
    if apply:
        meta = read_toml(src)
        if meta.get("status") != "verified":
            sys.exit(f"refusing pull: status={meta.get('status')!r} (need verified)")

    print(f"pull {src} -> {dest_cache}")
    if not apply:
        print("dry-run: no rsync")
        return 0

    dest_cache.mkdir(parents=True, exist_ok=True)
    copy_tree(src, dest_cache)
    return verify_one(dest_cache, apply=False, set_verified=False)


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="store.py")
    sub = p.add_subparsers(dest="cmd", required=True)

    ing = sub.add_parser("ingest", help="copy source into store, write MODEL.toml + MODEL.sha256")
    ing.add_argument("--source", required=True)
    ing.add_argument("--family", required=True)
    ing.add_argument("--variant", required=True)
    ing.add_argument("--quant", default="")
    ing.add_argument("--params", default="")
    ing.add_argument("--hf-repo", default="")
    ing.add_argument("--hf-commit", default="")
    ing.add_argument("--source-host", default="")
    ing.add_argument("--root", default=None)
    ing.add_argument("--in-place", action="store_true")
    ing.add_argument("--verify-after", action="store_true")
    ing.add_argument("--apply", action="store_true")

    ver = sub.add_parser("verify", help="check MODEL.sha256")
    ver.add_argument("--family", default="")
    ver.add_argument("--variant", default="")
    ver.add_argument("--root", default=None)
    ver.add_argument("--set-verified", action="store_true")
    ver.add_argument("--apply", action="store_true")

    man = sub.add_parser("manifest", help="emit JSON (and optional markdown) of store contents")
    man.add_argument("--root", default=None)
    man.add_argument("--out", default=None)
    man.add_argument("--markdown", action="store_true")
    man.add_argument("--markdown-out", default=None)
    man.add_argument("--verified-only", action="store_true")
    man.add_argument("--apply", action="store_true")

    pul = sub.add_parser("pull", help="rsync a verified variant to a local cache and re-hash")
    pul.add_argument("--family", required=True)
    pul.add_argument("--variant", required=True)
    pul.add_argument("--dest", required=True)
    pul.add_argument("--root", default=None)
    pul.add_argument("--apply", action="store_true")
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.cmd == "ingest":
        return cmd_ingest(args)
    if args.cmd == "verify":
        return cmd_verify(args)
    if args.cmd == "manifest":
        return cmd_manifest(args)
    if args.cmd == "pull":
        return cmd_pull(args)
    return 2


if __name__ == "__main__":
    sys.exit(main())
