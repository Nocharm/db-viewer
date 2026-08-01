"""Seed fixture JSON into a running backend. / 실행 중인 백엔드에 픽스처 적재.

Usage:
  python tools/seed_fixtures.py --base http://localhost:6678 \
      --api-key local-ingest-key [--dir fixtures] [--seed 42]

픽스처 디렉터리가 없으면 fixture_gen으로 즉석 생성한다.
"""

import argparse
import json
import sys
import urllib.error
import urllib.request
from pathlib import Path


def post_json(url: str, payload: dict, api_key: str | None) -> dict:
    body = json.dumps(payload).encode()
    request = urllib.request.Request(
        url, data=body, method="POST",
        headers={"Content-Type": "application/json"},
    )
    if api_key:
        request.add_header("X-API-Key", api_key)
    try:
        with urllib.request.urlopen(request, timeout=300) as response:
            return json.loads(response.read())
    except urllib.error.HTTPError as e:
        detail = e.read().decode(errors="replace")[:500]
        raise SystemExit(f"POST {url} failed: {e.code} {detail}") from e


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", default="http://localhost:6678")
    parser.add_argument("--api-key", default=None)
    parser.add_argument("--dir", type=Path, default=Path("fixtures"))
    parser.add_argument("--seed", type=int, default=42)
    args = parser.parse_args()

    if not (args.dir / "catalog.json").exists():
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        import fixture_gen

        print(f"generating fixtures into {args.dir} (seed={args.seed})")
        fixture_gen.generate(seed=args.seed, out_dir=args.dir)

    catalog = json.loads((args.dir / "catalog.json").read_text())
    result = post_json(f"{args.base}/api/ingest/catalog", catalog, args.api_key)
    snapshot_id = result["snapshot_id"]
    print(f"catalog → snapshot {snapshot_id}: {result['counts']}")

    view_deps = json.loads((args.dir / "view_deps.json").read_text())
    view_deps["snapshot_id"] = snapshot_id
    result = post_json(f"{args.base}/api/ingest/view-deps", view_deps, args.api_key)
    print(f"view-deps → {result['counts']}")


if __name__ == "__main__":
    main()
