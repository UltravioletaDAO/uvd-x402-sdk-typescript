#!/usr/bin/env python3
"""Check test/vectors/reputation/*.json with Python's own tools, no SDK.

A third implementation of every value in the shared reputation vectors:
eth_account for the EIP-712 digests, the signatures and the EIP-7702
authorization; hashlib / hmac / json for message refs, commitments and the
canonical document bytes; eth_utils for keccak and EIP-55. The TypeScript
suite checks the module against these files and the emitter
(scripts/derive-reputation-vectors.mjs) derives them with ethers; this script
is what says Python agrees, before the Python SDK has a module to compare.

Usage:  python scripts/xlang/reputation-vectors-check.py [vectors-dir]
Needs:  eth-account >= 0.13 (sign_authorization).
Exit 0 when every vector holds; prints each failure otherwise.
"""
import hashlib
import hmac
import json
import sys
from pathlib import Path

from eth_account import Account
from eth_account.messages import encode_typed_data
from eth_utils import keccak, to_checksum_address

ROOT = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parents[2] / "test" / "vectors" / "reputation"
FAILURES = []


def check(name, got, want):
    if got != want:
        FAILURES.append(f"{name}: got {got!r}, want {want!r}")


def load(name):
    raw = (ROOT / name).read_bytes()
    check(f"{name} is LF only", b"\r" in raw, False)
    return json.loads(raw.decode("utf-8")), hashlib.sha256(raw).hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"))


def typed_digest(full):
    """keccak(0x19 || version || domainSeparator || structHash): the EIP-712 digest."""
    signable = encode_typed_data(full_message=full)
    return "0x" + keccak(b"\x19" + signable.version + signable.header + signable.body).hex()


def main():
    refs, sha_refs = load("message-ref.json")
    for case in refs["cases"]:
        text = "|".join([case["namespace"], *[str(p) for p in case["parts"]]])
        check(f"message-ref {case['parts']}", hashlib.sha256(text.encode("utf-8")).hexdigest(), case["ref"])

    relayed, sha_relayed = load("relayed-feedback.json")
    key = "0x" + hashlib.sha256(relayed["signer"]["seed"].encode("utf-8")).hexdigest()
    account = Account.from_key(key)
    check("signer address", account.address, relayed["signer"]["address"])
    domain_types = [
        {"name": "name", "type": "string"},
        {"name": "version", "type": "string"},
        {"name": "chainId", "type": "uint256"},
        {"name": "verifyingContract", "type": "address"},
    ]
    dc = relayed["deployedContract"]
    fields = relayed["cases"][0]["prepare"]["typedData"]["types"]["RelayedGiveFeedback"]
    deployed = {
        "types": {"EIP712Domain": domain_types, "RelayedGiveFeedback": fields},
        "primaryType": "RelayedGiveFeedback",
        "domain": {"name": "FeedbackDelegate", "version": "1", "chainId": dc["chainId"], "verifyingContract": dc["verifyingContract"]},
        "message": dc["message"],
    }
    check("deployed contract domain separator", "0x" + encode_typed_data(full_message=deployed).header.hex(), dc["domainSeparator"])
    check("deployed contract digest", typed_digest(deployed), dc["digest"])
    for case in relayed["cases"]:
        td = case["prepare"]["typedData"]
        digest = typed_digest(td)
        check(f"{case['name']}: digest", digest, case["expected"]["digest"])
        check(f"{case['name']}: prepare digest", case["prepare"]["digest"], case["expected"]["digest"])
        signed = Account.unsafe_sign_hash(bytes.fromhex(digest[2:]), key)
        # bytes(...).hex(): HexBytes.hex() adds a 0x in some versions and not in others.
        check(f"{case['name']}: signature", "0x" + bytes(signed.signature).hex(), case["expected"]["signature"])
        auth = case["expected"]["authorization"]
        if auth is not None:
            sa = account.sign_authorization({"chainId": auth["chainId"], "address": auth["address"], "nonce": auth["nonce"]})
            check(f"{case['name']}: authorization r", "0x" + format(sa.r, "064x"), auth["r"])
            check(f"{case['name']}: authorization s", "0x" + format(sa.s, "064x"), auth["s"])
            check(f"{case['name']}: authorization yParity", sa.y_parity, auth["yParity"])
            check(f"{case['name']}: authorization digest", "0x" + bytes(sa.authorization_hash).hex(), case["expected"]["authorizationDigest"])

    payments, sha_payments = load("payment-hash.json")
    for case in payments["cases"]:
        preimage = (
            bytes.fromhex(case["transactionHash"][2:])
            + int(case["blockNumber"]).to_bytes(8, "big")
            + to_checksum_address(case["payer"]).encode("utf-8")
            + to_checksum_address(case["payee"]).encode("utf-8")
            + int(case["amount"]).to_bytes(32, "big")
        )
        check(f"paymentHash block {case['blockNumber']}", "0x" + keccak(preimage).hex(), case["paymentHash"])

    evidence, sha_evidence = load("evidence.json")
    salt = hashlib.sha256(evidence["salt"]["seed"].encode("utf-8")).digest()
    for case in evidence["canonical"]:
        check(f"canonical {case['json'][:30]}", canonical(case["value"]), case["json"])
    for case in evidence["commitments"]:
        mac = hmac.new(salt, f"{case['name']}|{case['value']}".encode("utf-8"), hashlib.sha256).hexdigest()
        check(f"commitment {case['name']}", "0x" + mac, case["commitment"])
    for case in evidence["documents"]:
        i = case["input"]
        doc = {
            "schema": "uvd-x402.reputation.evidence/v1",
            "agentRegistry": "eip155:8453:0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
            "agentId": str(i["agentId"]),
            "clientAddress": to_checksum_address(i["rater"]),
            "subject": {
                "type": i["subject"].get("type", "participant"),
                "wallet": to_checksum_address(i["subject"]["wallet"]),
                "walletBinding": i["subject"]["walletBinding"],
            },
            "createdAt": i["createdAt"],
            "value": int(i["value"]),
            "valueDecimals": int(i.get("valueDecimals", 0)),
            "tag1": i.get("tag1", ""),
            "tag2": i.get("tag2", ""),
            "endpoint": i.get("endpoint", ""),
            "issuer": i.get("issuer", {}),
            "context": i.get("context", {}),
        }
        if i.get("commitments"):
            doc["commitments"] = {
                "scheme": 'hmac-sha256(salt, name "|" value)/v1',
                "values": {
                    k: "0x" + hmac.new(salt, f"{k}|{v}".encode("utf-8"), hashlib.sha256).hexdigest()
                    for k, v in i["commitments"].items()
                },
            }
        if i.get("proof"):
            p = i["proof"]
            doc["proofOfPayment"] = {
                "transactionHash": p["transactionHash"].lower(),
                "blockNumber": p["blockNumber"],
                "network": p["network"],
                "payer": to_checksum_address(p["payer"]),
                "payee": to_checksum_address(p["payee"]),
                "amount": str(int(p["amount"])),
                "token": to_checksum_address(p["token"]),
                "timestamp": p["timestamp"],
                "paymentHash": p["paymentHash"].lower(),
            }
        text = canonical(doc)
        check(f"{case['name']}: json", text, case["json"])
        check(f"{case['name']}: contentHash", "0x" + keccak(text.encode("utf-8")).hex(), case["contentHash"])

    for name, sha in (
        ("message-ref.json", sha_refs),
        ("relayed-feedback.json", sha_relayed),
        ("payment-hash.json", sha_payments),
        ("evidence.json", sha_evidence),
    ):
        print(f"{name}  sha256 {sha}")
    if FAILURES:
        print("\n".join(FAILURES))
        sys.exit(1)
    print("all reputation vectors hold in Python")


if __name__ == "__main__":
    main()
