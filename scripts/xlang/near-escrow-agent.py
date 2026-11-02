"""Offline counterpart for near-escrow-conformance.mjs; imports the actual Python SDK."""
import hashlib
import json
import sys
from pathlib import Path

from uvd_x402_sdk import near_escrow as sdk

vectors = json.loads(sys.stdin.read())
results = []
for v in vectors['payment_id']['vectores']:
    network = 'near:mainnet' if v['token'] == sdk.NEAR_ESCROW_TOKENS['near:mainnet'] else 'near:testnet'
    options = sdk.NearEscrowDelegateOptions(
        network=network, signer=sdk.NearEd25519Signer(bytes(range(32))), sender_id=v['payer'],
        escrow_contract='arras.near' if network == 'near:mainnet' else 'arras.testnet',
        nonce='7', max_block_height='100000000')
    calls = [('release', {'payment_id': v['payment_id']}),
             ('release', {'payment_id': v['payment_id'], 'amount': '400000'}),
             ('refund', {'payment_id': v['payment_id']}), ('reclaim', {'payment_id': v['payment_id']}),
             ('withdraw', {}), ('withdraw_for', {'account': v['receiver']})]
    results.append(dict(id=v['id'], msg=sdk.build_escrow_msg(v),
        preimage=sdk.payment_id_preimage(v).hex(), paymentId=sdk.compute_payment_id(v),
        authorization=sdk.sign_escrow_authorization(options, token=v['token'], amount=v['amount'], msg=v),
        lifecycle=[sdk.sign_escrow_lifecycle(options, method, args) for method, args in calls]))
fixture = Path(sys.argv[1]) / 'tests/fixtures/near-escrow.json'
print(json.dumps(dict(results=results, minGas=str(sdk.NEAR_ESCROW_MIN_GAS), maxGas=str(sdk.NEAR_ESCROW_MAX_GAS),
    fixtureHash=hashlib.sha256(fixture.read_bytes()).hexdigest())))
