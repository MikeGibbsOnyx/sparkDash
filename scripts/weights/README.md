# weights store tooling

Implements FLEET-OPS.md §1. Canonical origin is rin-den `/srv/weights`.

Hard gate: nothing writes `/srv/weights` unless `WEIGHTS_STORE_GO=1` and `--apply`.
Default is dry-run. Local tests use a tmpdir and do not need GO.

```
/srv/weights/<family>/<variant>/
    MODEL.toml
    MODEL.sha256
    <payload>
```

family = lowercase (`deepseek`, `glm`, `gpt-oss`). variant = exact upstream id.

```
# dry-run (safe)
python3 scripts/weights/store.py ingest --source ./src --family deepseek --variant DS4-Flash-0731-FP8 --root /tmp/w

# apply to a NON-canonical root (tests / staging)
python3 scripts/weights/store.py ingest --source ./src --family deepseek --variant DS4-Flash-0731-FP8 \
  --root /tmp/w --apply --verify-after

# canonical (rin-den) — needs Mike GO
WEIGHTS_STORE_GO=1 bash scripts/weights/bootstrap-store.sh --apply
WEIGHTS_STORE_GO=1 python3 scripts/weights/store.py ingest ... --root /srv/weights --apply --verify-after
```

Recorded gate: `python3 scripts/weights/test_store.py`
