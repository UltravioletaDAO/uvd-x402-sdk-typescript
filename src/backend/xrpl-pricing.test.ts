import { describe, expect, it } from 'vitest';

import { buildPaymentRequirements, toPaymentRequirementsV2 } from './index';
import {
  getChainByName,
  getTokenConfig,
  isUsdPegged,
  usdConversionError,
} from '../chains';
import { chainToCAIP2, generatePaymentOptions } from '../utils';

const XRPL_PAYTO_V2 = 'rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe';

/**
 * XRPL charged in XRP what the integrator wrote in dollars, and the mainnet
 * travelled under a name the facilitator publishes nowhere.
 *
 * Both defects are `main`'s, both are the ones the Python SDK closed in 0.77.0
 * (`docs/reports/2026-09-05-xrpl-cobro-y-nombre-de-red.md`), and this file is
 * the TypeScript half of that parity.
 *
 * **The pricing defect is a UNIT bug, not a SCALE bug**, which is why
 * `decimals` never rescued it. `buildPaymentRequirements` scaled `amount` by
 * `chain.usdc.decimals`, and that turns dollars into base units only when one
 * whole unit IS one dollar. XRPL registers native XRP under the key `usdc`
 * (`src/chains/index.ts`, and the comment there admits it), so `"10.00"` --
 * documented as USD on `PaymentInfo.amount` -- billed 10 XRP. XRP genuinely has
 * six decimals; six decimals of XRP are still XRP.
 *
 * The contradiction lived inside this repo: the type said USD and the SDK's own
 * XRPL provider read the same field as whole XRP (`xrpToDrops`). The type and
 * its only XRPL consumer disagreed about the unit, and the consumer won.
 */
describe('XRPL: a price written in dollars is refused, not converted', () => {
  const XRPL_PAYTO = 'rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe';
  const reqs = (chainName: string) => ({
    amount: '10.00',
    recipient: chainName.startsWith('xrpl') ? XRPL_PAYTO : '0x1234567890123456789012345678901234567890',
    resource: 'https://api.example.com/premium',
    chainName,
  });

  it('refuses to price the XRPL mainnet in USD', () => {
    // RED before 2.85.0: returned maxAmountRequired '10000000' -- 10 XRP for a
    // caller who wrote ten dollars.
    expect(() => buildPaymentRequirements(reqs('xrpl'))).toThrow(
      /not pegged to the dollar/
    );
  });

  it('refuses through the alias too, so the old spelling is not a way around it', () => {
    expect(() => buildPaymentRequirements(reqs('xrpl-mainnet'))).toThrow(
      /not pegged to the dollar/
    );
    expect(() => buildPaymentRequirements(reqs('xrpl-testnet'))).toThrow(
      /not pegged to the dollar/
    );
  });

  /**
   * Refusing without saying where to look only moves the dead end one layer up,
   * so the message has to carry the asset, the damage and the way out.
   */
  it('names the asset, what the old code would have charged, and the escape', () => {
    const message = usdConversionError('xrpl', getChainByName('xrpl')!.usdc);

    expect(message).toContain('XRP');
    expect(message).toContain('$1.00 would be charged as 1 XRP');
    expect(message).toContain('GET /supported');
    // The real dollar-pegged asset on XRPL, verified in the facilitator's own
    // registry as Circle's (`x402-rs/src/network.rs:1227-1242`).
    expect(message).toContain('rGm7WCVp9gb4jZHWTEtGUr4dd74z2XuWhE');
  });

  it('leaves every dollar-pegged network converting exactly as before', () => {
    // The control. `usdPegged` defaults to absent, so nothing else moved.
    expect(buildPaymentRequirements(reqs('base')).maxAmountRequired).toBe('10000000');
    expect(buildPaymentRequirements(reqs('stellar')).maxAmountRequired).toBe('100000000');
    expect(isUsdPegged(getTokenConfig('base', 'usdc'))).toBe(true);
    expect(isUsdPegged(getTokenConfig('xrpl', 'usdc'))).toBe(false);
  });

  it('treats the flag as opt-out, so an unmarked token is a dollar', () => {
    expect(isUsdPegged(undefined)).toBe(true);
    expect(isUsdPegged({ address: '0x0', decimals: 6, name: 'X', version: '1' })).toBe(true);
  });
});

/**
 * The mainnet is `xrpl`. The facilitator prints that and only that
 * (`x402-rs/src/network.rs:189`); it accepts `xrpl-mainnet` in its `FromStr`
 * and nowhere else, under a comment calling that spelling "right for a lookup
 * and wrong for a wire format" (`:719`). The SDK was putting the lookup
 * spelling on the wire.
 */
describe('XRPL: the network name the facilitator actually publishes', () => {
  it('registers the mainnet as `xrpl`', () => {
    // RED before 2.85.0: the registry entry WAS `xrpl-mainnet`.
    expect(getChainByName('xrpl')?.name).toBe('xrpl');
  });

  it('keeps `xrpl-mainnet` working as an input alias', () => {
    expect(getChainByName('xrpl-mainnet')?.name).toBe('xrpl');
    expect(getChainByName('XRPL-MAINNET')?.name).toBe('xrpl');
  });

  it('never emits the alias, in either envelope', () => {
    expect(chainToCAIP2('xrpl-mainnet')).not.toContain('mainnet');
    expect(chainToCAIP2('xrpl')).not.toContain('mainnet');
    expect(generatePaymentOptions([getChainByName('xrpl-mainnet')!], '5')).toHaveLength(0);
  });

  /**
   * The registry still carries NO CAIP-2 id for XRPL, so a v2 body for it is
   * refused rather than built. That refusal is deliberate and it is the
   * conservative half of this change: the facilitator does publish `xrpl:0` and
   * `xrpl:1`, but the Python SDK deliberately withheld those ids in 0.77.0, and
   * the cross-language conformance run compares the two SDKs' envelope
   * decisions live -- one of them building what the other calls impossible is
   * exactly the divergence that suite exists to catch. Adding the ids is a
   * coordinated, two-SDK change; see the handoff.
   *
   * What DID have to change here: with `xrpl-mainnet` demoted to an alias,
   * `chainToCAIP2` fell into its `${networkType}:${name}` fallback and answered
   * `xrpl:xrpl-mainnet` -- a fabricated id that passes the colon test this
   * guard uses, so the refusal below silently became an emission.
   */
  it('still refuses a v2 body for XRPL, and refuses it for the alias too', () => {
    const requirements = {
      scheme: 'exact' as const,
      network: 'xrpl',
      maxAmountRequired: '100000',
      resource: 'https://api.example.com/premium',
      description: 'x',
      mimeType: 'application/json',
      payTo: XRPL_PAYTO_V2,
      maxTimeoutSeconds: 300,
      asset: 'XRP',
    };

    expect(() => toPaymentRequirementsV2(requirements)).toThrow(/no CAIP-2 form/);
    // RED after the rename, before `chainToCAIP2` was taught to normalise:
    // this one BUILT, carrying network 'xrpl:xrpl-mainnet'.
    expect(() =>
      toPaymentRequirementsV2({ ...requirements, network: 'xrpl-mainnet' })
    ).toThrow(/no CAIP-2 form/);
  });
});
