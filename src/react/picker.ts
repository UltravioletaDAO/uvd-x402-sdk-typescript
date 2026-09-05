/**
 * uvd-x402-sdk/react/picker - the network selector, without the payment stack.
 *
 * WHY THIS ENTRYPOINT EXISTS
 * `uvd-x402-sdk/react` is built with `splitting: false`, so that bundle is
 * self-contained: importing anything from it pulls `X402Client` and with it
 * `ethers`. Measured on the published artifacts:
 *
 *   dist/react/index.mjs          64.5 kB   imports ethers
 *   dist/react/picker/index.mjs   30.8 kB   imports react and jsx-runtime only
 *
 * A site that only lets someone pick a network should not ship a signing stack.
 * This entrypoint carries `NetworkPicker` and the chain table it reads, nothing
 * else. `src/chains` imports types only, so what lands here is data plus a
 * component.
 *
 * WHAT THIS DOES NOT FIX, SO NOBODY CLAIMS IT LATER
 * It does not shrink a host app that already bundles a wallet stack elsewhere.
 * meshrelay's selector chunk measures 406.93 kB before this change and 406.18
 * after, because that chunk is where its bundler happens to group the payment
 * path; the name on the file is not what fills it. The saving here is real but
 * local: it is what a consumer pays for the picker itself.
 *
 * Use `uvd-x402-sdk/react` instead when you also need `X402Provider`, the hooks,
 * or `PaymentMethodPicker`: those genuinely need the client, and paying for it
 * there is the point.
 */

export {
  NetworkPicker,
  buildNetworkOptions,
  resolveChain,
  describeWhyDisabled,
  SIGNABLE_IN_BROWSER,
  FAMILY_LABEL,
} from './NetworkPicker';

export type { NetworkPickerProps, NetworkOption } from './NetworkPicker';
