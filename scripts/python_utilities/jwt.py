#!/usr/bin/env python3
"""Decode a JWT from stdin and check the claims that matter for Easy Auth.
Usage:  echo "$TOKEN" | python3 decode_jwt.py [expected-client-id]
No third-party libs — just base64 + json from the stdlib.
"""
import base64
import json
import sys


def b64url_decode(segment: str) -> bytes:
    # JWT uses base64url WITHOUT padding; restore it before decoding.
    padding = "-" * 0  # noop, keeps linters quiet
    rem = len(segment) % 4
    if rem:
        segment += "=" * (4 - rem)
    return base64.urlsafe_b64decode(segment)


def main() -> int:
    token = sys.stdin.read().strip()
    if not token or token.count(".") != 2:
        print("ERROR: stdin did not contain a well-formed JWT "
              "(expected three dot-separated segments).", file=sys.stderr)
        print(f"Got {len(token)} chars.", file=sys.stderr)
        return 1

    header_b64, payload_b64, _sig = token.split(".")
    header = json.loads(b64url_decode(header_b64))
    payload = json.loads(b64url_decode(payload_b64))

    print("=== HEADER ===")
    print(json.dumps(header, indent=2))
    print("\n=== PAYLOAD ===")
    print(json.dumps(payload, indent=2))

    print("\n=== KEY CLAIMS ===")
    aud = payload.get("aud", "<missing>")
    scp = payload.get("scp", "<missing>")
    iss = payload.get("iss", "<missing>")
    appid = payload.get("appid") or payload.get("azp", "<missing>")
    ver = payload.get("ver", "<missing>")
    print(f"aud   : {aud}")
    print(f"scp   : {scp}")
    print(f"iss   : {iss}")
    print(f"appid : {appid}   (the client that obtained the token)")
    print(f"ver   : {ver}")

    expected = sys.argv[1] if len(sys.argv) > 1 else None
    if expected:
        print("\n=== CHECKS ===")
        aud_ok = expected in str(aud)  # matches api://<id> or bare GUID
        scp_ok = "user_impersonation" in str(scp)
        print(f"[{'PASS' if aud_ok else 'FAIL'}] aud references {expected}")
        print(f"[{'PASS' if scp_ok else 'FAIL'}] scp contains user_impersonation")
        if not aud_ok:
            print("  -> Token audience is NOT your API. Easy Auth will 401. "
                  "You probably got an ARM token, not an api:// token.")
        if not scp_ok:
            print("  -> No delegated scope present. Check the scope was "
                  "consented / the .default request carried it.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())