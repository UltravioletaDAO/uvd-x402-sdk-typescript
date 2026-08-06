#!/usr/bin/env python3
"""Cross-language conformance AGENT — Python side.

A thin, dumb adapter: it reads ONE JSON request on stdin, calls the public
``uvd_x402_sdk.erc8128`` API, and writes ONE JSON response on stdout. It holds
no expectations and asserts nothing — the driver
(``cross-language-conformance.mjs``) owns every comparison, so neither side can
grade its own homework.

It imports the INSTALLED package. Point it at a source checkout with
``PYTHONPATH=<repo>/src`` (what ``pip install -e .`` gives you). If the import
fails the agent EXITS 1 with the fix — it never skips, and it never falls back
to a different copy of the SDK. That silent fallback is the failure mode this
whole harness exists to remove.

The signing key is the synthetic public test key from the F3-1 fixture (a key
that never held funds). No secret is read, written or printed.

Protocol
    stdin   {"op":"describe"}
            {"op":"sign","cases":[{id,method,url,body,nonce,chainId,profile,now}]}
            {"op":"verify","cases":[{id,method,url,body,headers,policy,authority,now}]}
    stdout  {"runtime":"python", ...}   exit 0
            {"error":"…"}               exit 1
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import sys


def die(message: str) -> "None":
    sys.stdout.write(json.dumps({"error": message}))
    sys.stdout.flush()
    raise SystemExit(1)


try:
    from uvd_x402_sdk.erc8128 import (
        CONFORMANCE_SHA256,
        POLICY_PRESETS,
        WIRE_CONTRACT_VERSION,
        VerifiableRequest,
        load_vectors,
        policy_from_preset,
        preset_as_data,
        run_conformance,
        sign_request,
        vector_bytes,
        verify_request,
    )
    from uvd_x402_sdk.wallet import EnvKeyAdapter
except Exception as exc:  # noqa: BLE001 - the message IS the product here
    die(
        "the Python SDK could not be imported: "
        f"{type(exc).__name__}: {exc}. "
        "Install it (`pip install -e .` in uvd-x402-sdk-python, with the "
        "[signer] extra) or set PYTHONPATH=<repo>/src. This agent does NOT "
        "skip."
    )


class _FirstUseStore:
    """First-use-wins, per verify case. A shared store would report every case
    after the first as a replay, because the vectors all carry one nonce."""

    def __init__(self) -> None:
        self._seen = set()

    def consume(self, nonce, *, wallet, chain_id, **_):
        key = (nonce, wallet, chain_id)
        if key in self._seen:
            return "replayed"
        self._seen.add(key)
        return "ok"


def describe():
    # The package's OWN conformance runner, reduced to the fields both
    # languages spell the same way. The driver compares these two summaries:
    # the runners read one byte-identical file, so a different `total` means
    # one of them is not checking something the other is — which is exactly how
    # Python ran 67 checks against TypeScript's 62 with nothing going red.
    report = run_conformance()
    return {
        "runtime": "python",
        "wire_contract_version": WIRE_CONTRACT_VERSION,
        # The map the package EXPORTS…
        "conformance_sha256": dict(CONFORMANCE_SHA256),
        # …and the hash of the bytes it actually ships, computed here.
        "computed_sha256": {
            gen: hashlib.sha256(vector_bytes(gen)).hexdigest() for gen in ("f3-1", "f3-3")
        },
        "conformance": {
            "ok": report.ok,
            "passed": report.passed,
            "total": report.total,
            "failed_count": len(report.failed),
            "failed": [json.dumps(f, default=str) for f in report.failed[:5]],
        },
        "presets": {name: preset_as_data(name) for name in POLICY_PRESETS},
        "frozen_address": load_vectors("f3-1")["frozen"]["address"],
    }


def sign(cases):
    # Synthetic public test key from the shipped F3-1 fixture; never inlined.
    frozen = load_vectors("f3-1")["frozen"]
    wallet = EnvKeyAdapter(private_key="0x" + frozen["private_key"])
    results = []
    for case in cases:
        headers = sign_request(
            wallet,
            method=case["method"],
            url=case["url"],
            body=case.get("body"),
            nonce=case["nonce"],
            chain_id=case["chainId"],
            profile=case["profile"],
            now=(lambda value=case["now"]: value),
        )
        results.append({"id": case["id"], "headers": headers})
    return {"runtime": "python", "results": results}


async def _verify_one(case):
    headers = {
        "Signature": case["headers"]["Signature"],
        "Signature-Input": case["headers"]["Signature-Input"],
    }
    if case["headers"].get("Content-Digest"):
        headers["Content-Digest"] = case["headers"]["Content-Digest"]

    raw_body = None
    if case.get("body") is not None:
        raw_body = case["body"].encode("utf-8")
        headers["Content-Length"] = str(len(raw_body))

    policy = policy_from_preset(
        case["policy"],
        authority=case["authority"],
        nonce_store=_FirstUseStore(),
        now=(lambda value=case["now"]: value),
    )
    result = await verify_request(
        VerifiableRequest(
            method=case["method"],
            url=case["url"],
            headers=headers,
            raw_body=raw_body,
        ),
        policy,
    )
    return {
        "id": case["id"],
        "ok": result.ok,
        "code": result.code,
        # 401 or 503 — the authority rule turns on which of the two a
        # misconfiguration gets, so the driver has to be able to see it.
        "status": result.status,
        "wallet": result.wallet,
        "observed_profile": result.observed_profile,
    }


def verify(cases):
    async def run():
        return [await _verify_one(case) for case in cases]

    return {"runtime": "python", "results": asyncio.run(run())}


def main() -> None:
    try:
        request = json.loads(sys.stdin.read())
        op = request.get("op")
        if op == "describe":
            response = describe()
        elif op == "sign":
            response = sign(request["cases"])
        elif op == "verify":
            response = verify(request["cases"])
        else:
            die(f"unknown op: {op!r}")
            return
        sys.stdout.write(json.dumps(response))
        sys.stdout.flush()
    except SystemExit:
        raise
    except Exception as exc:  # noqa: BLE001
        import traceback

        die(f"python agent failed: {type(exc).__name__}: {exc}\n{traceback.format_exc()}")


if __name__ == "__main__":
    main()
