/**
 * PaymentMethodPicker - network selection plus payment, in one component.
 *
 * This is `NetworkPicker` with the paying attached. Sites that already own their
 * payment flow (meshrelay, for one) should use `NetworkPicker` directly and keep
 * their button; sites starting from nothing get the whole thing here.
 *
 * WHY THIS EXISTS
 * Three repos grew their own picker (describe.net `dn-pay.js`, 402milly
 * `ChainSelector`, meshrelay `NetworkSelector`): 3,718 lines solving the same
 * problem three times, none covering the 21 mainnet networks the facilitator
 * settles. Design notes and backlog: `docs/carrusel-de-pago-compartido.md`.
 *
 * THE RULE THAT MATTERS MOST HERE
 * `accepts` is passed through VERBATIM, by reference. Never rebuilt, cloned or
 * reordered. Rebuilding that object field by field is how a valid payment ends
 * up rejected (see the note in describe.net `dn-pay.js:485`). The other rules
 * about chain tables and `wallet_addEthereumChain` live in `NetworkPicker`.
 */

import { useCallback, useMemo, useState } from 'react';

import { useX402, usePayment } from './index';
import { NetworkPicker } from './NetworkPicker';
import type { NetworkType, PaymentInfo, PaymentResult } from '../types';

/** One entry of the `accepts` array of a 402 response. */
export interface PaymentAccept {
  scheme: string;
  network: string;
  networkAliases?: string[];
  extra?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface PaymentMethodPickerProps {
  /** The `accepts` array from the 402 response, untouched. */
  accepts: readonly PaymentAccept[];
  /** Recipients and amount, handed to `pay()` as-is. */
  payment: PaymentInfo;
  onPaid?: (result: PaymentResult) => void;
  onError?: (error: Error) => void;
  /** Restrict to some families. Omit to offer everything the resource accepts. */
  families?: readonly NetworkType[];
  layout?: 'carousel' | 'segmented' | 'list';
  label?: string;
  hint?: string;
  payLabel?: string;
  className?: string;
}

export function PaymentMethodPicker({
  accepts,
  payment,
  onPaid,
  onError,
  families,
  layout = 'carousel',
  label = 'Payment network',
  hint,
  payLabel = 'Pay',
  className,
}: PaymentMethodPickerProps) {
  const { isConnected, connect, switchChain, network } = useX402();
  const { pay, isPaying } = usePayment();
  const [selected, setSelected] = useState<string | null>(null);

  // Ids only. The accept objects themselves are never copied. Rule 1.
  const networks = useMemo(() => accepts.map((a) => a.network), [accepts]);

  const confirm = useCallback(async () => {
    const accept = accepts.find((a) => a.network === selected);
    if (!accept) return;
    try {
      if (!isConnected) await connect(accept.network);
      // Ask to switch. Never wallet_addEthereumChain.
      if (network && network !== accept.network) await switchChain(accept.network);
      // `payment` and `accept` both travel verbatim, by reference.
      const result = await pay({ ...payment, accept } as PaymentInfo);
      onPaid?.(result);
    } catch (error) {
      onError?.(error instanceof Error ? error : new Error(String(error)));
    }
  }, [accepts, selected, isConnected, connect, network, switchChain, pay, payment, onPaid, onError]);

  return (
    <div className={['uvd-x402-pay', className].filter(Boolean).join(' ')}>
      <NetworkPicker
        value={selected}
        onChange={setSelected}
        networks={networks}
        families={families}
        disabled={isPaying}
        label={label}
        hint={hint}
        groupByFamily={networks.length > 6}
        layout={layout}
      />

      <button
        type="button"
        disabled={!selected || isPaying}
        onClick={confirm}
        className="uvd-x402-pay__confirm"
      >
        {isPaying ? 'Paying...' : payLabel}
      </button>
    </div>
  );
}
