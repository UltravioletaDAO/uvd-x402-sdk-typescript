"""Import the actual Python golden-flow helpers; no reimplementation or network."""
import json
import sys
from uvd_x402_sdk.near_escrow import NearEd25519Signer
from uvd_x402_sdk.near_exact import NearExactDelegateOptions, sign_exact_near_delegate
from uvd_x402_sdk.near_nep413 import nep413_preimage, sign_nep413
from uvd_x402_sdk.near_events import parse_arras_events
from uvd_x402_sdk.near_storage import build_arras_storage_deposit, build_usdc_storage_deposit

v = json.loads(sys.stdin.buffer.read().decode('utf-8'))
signer = NearEd25519Signer(bytes(range(32)))
messages, preimages, exact = [], [], []
for item in v['nep413']:
    args = dict(message=item['message'], nonce=bytes(range(32)), recipient=item['recipient'], callback_url=item['callbackUrl'])
    messages.append(sign_nep413(signer, account_id='payer-demo.testnet', **args))
    preimages.append(nep413_preimage(**args).hex())
for item in v['exact']:
    options = NearExactDelegateOptions(network=item['network'], signer=signer, sender_id=item['senderId'], nonce='7', max_block_height='100000000')
    exact.append(sign_exact_near_delegate(options, token=item['token'], pay_to=item['payTo'], amount=item['amount']))
options = dict(network='near:testnet', payer_id='payer-demo.testnet')
storage = [build_arras_storage_deposit(**options, escrow_contract='arras-v1b-1101.testnet'),
           build_usdc_storage_deposit(**options),
           build_arras_storage_deposit(**options, escrow_contract='arras-v1b-1101.testnet', account_id='worker.testnet', deposit='60000000000000000000000')]
print(json.dumps(dict(messages=messages, preimages=preimages, exact=exact, storage=storage,
                     events=parse_arras_events(['foreign log', *v['arrasEvents']]))))
