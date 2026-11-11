"""Offline counterpart for near-escrow-conformance.mjs; imports the actual Python SDK."""
import hashlib
import json
import sys
from pathlib import Path

from uvd_x402_sdk import near_escrow as sdk


class SpySigner:
    """Counts signature requests, so a refusal is proven to happen before signing."""

    def __init__(self, inner):
        self.inner, self.calls = inner, 0

    @property
    def public_key(self):
        return self.inner.public_key

    def sign(self, digest):
        self.calls += 1
        return self.inner.sign(digest)


def refused(case):
    spy = SpySigner(sdk.NearEd25519Signer(bytes(range(32))))
    options = sdk.NearEscrowDelegateOptions(
        network=case['network'], signer=spy, sender_id=case['senderId'], escrow_contract=case['escrowContract'],
        nonce=case['nonce'], max_block_height=case['maxBlockHeight'])
    try:
        if case['method'] == 'authorize':
            sdk.sign_escrow_authorization(options, token=case['token'], amount=case['amount'], msg=case['msg'])
        else:
            sdk.sign_escrow_lifecycle(options, case['method'], case['args'])
    except ValueError:
        return spy.calls == 0
    return False


request = json.loads(sys.stdin.read())
# Delegates are signed only for registered contracts; see near-escrow-conformance.mjs.
network = 'near:testnet'
escrow_contract = sdk.NEAR_ESCROW_CONTRACTS[network][0]
results = []
for v in request['vectors']['payment_id']['vectores']:
    options = sdk.NearEscrowDelegateOptions(
        network=network, signer=sdk.NearEd25519Signer(bytes(range(32))), sender_id=v['payer'],
        escrow_contract=escrow_contract, nonce='7', max_block_height='100000000')
    calls = [('release', {'payment_id': v['payment_id']}),
             ('release', {'payment_id': v['payment_id'], 'amount': '400000'}),
             ('refund', {'payment_id': v['payment_id']}), ('reclaim', {'payment_id': v['payment_id']}),
             ('withdraw', {}), ('withdraw_for', {'account': v['receiver']})]
    results.append(dict(id=v['id'], msg=sdk.build_escrow_msg(v),
        preimage=sdk.payment_id_preimage(v).hex(), paymentId=sdk.compute_payment_id(v),
        authorization=sdk.sign_escrow_authorization(
            options, token=sdk.NEAR_ESCROW_TOKENS[network], amount=v['amount'], msg=v),
        lifecycle=[sdk.sign_escrow_lifecycle(options, method, args) for method, args in calls]))

# Arras v2: the same tickets, canonical v2 msgs and v2 authorization as near-escrow-conformance.mjs.
ticket_vectors = request['vectors']['v2']['operator_ticket']
ticket_key = ticket_vectors['llave_de_prueba']
operator = sdk.NearEd25519Signer(bytes.fromhex(ticket_key['semilla_hex']))
tickets = []
for t in ticket_vectors['vectores']:
    ticket = sdk.sign_operator_ticket(operator, contract=t['contract'], subject=t['subject'], expiry=t['expiry'], now_ns=0)

    def check(now_ns, t=t, ticket=ticket):
        return sdk.check_operator_ticket(ticket_key['ticket_pubkey'], contract=t['contract'], subject=t['subject'],
                                         ticket=ticket, now_ns=now_ns)
    tickets.append(dict(id=t['id'], message=sdk.operator_ticket_message(t['contract'], t['subject'], t['expiry']).hex(),
        ticket=ticket, live=check(int(t['expiry']) - 1), expired=check(int(t['expiry']))))
t1 = ticket_vectors['vectores'][0]
v1, _, v3 = request['vectors']['payment_id']['vectores']
t1_ticket = {'expiry': t1['expiry'], 'sig': t1['sig']}
v2_msgs = [sdk.build_escrow_msg(v1), sdk.build_escrow_msg({**v1, 'dispute_deadline': v1['release_deadline']}),
           sdk.build_escrow_msg({**v1, 'dispute_deadline': v1['release_deadline'], 'operator_ticket': t1_ticket})]
v2_options = sdk.NearEscrowDelegateOptions(
    network='near:mainnet', signer=sdk.NearEd25519Signer(bytes(range(32))), sender_id=v3['payer'],
    escrow_contract=sdk.NEAR_ESCROW_V2_CONTRACTS['near:mainnet'][0], nonce='7', max_block_height='100000000')
v2_authorization = sdk.sign_escrow_authorization(
    v2_options, token=sdk.NEAR_ESCROW_TOKENS['near:mainnet'], amount=v3['amount'],
    msg={**v3, 'dispute_deadline': v3['release_deadline'], 'operator_ticket': t1_ticket})

fixture = Path(sys.argv[1]) / 'tests/fixtures/near-escrow.json'
print(json.dumps(dict(results=results, minGas=str(sdk.NEAR_ESCROW_MIN_GAS), maxGas=str(sdk.NEAR_ESCROW_MAX_GAS),
    contracts={net: list(rows) for net, rows in sdk.NEAR_ESCROW_CONTRACTS.items()},
    v2Contracts={net: list(rows) for net, rows in sdk.NEAR_ESCROW_V2_CONTRACTS.items()},
    tickets=tickets, v2Msgs=v2_msgs, v2Authorization=v2_authorization,
    refusals=[refused(case) for case in request['cases']],
    fixtureHash=hashlib.sha256(fixture.read_bytes()).hexdigest())))
