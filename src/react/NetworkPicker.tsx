/**
 * NetworkPicker - the shared network selector for the whole stack.
 *
 * WHY IT IS SEPARATE FROM PaymentMethodPicker
 * The first version of this work bundled "pick a network" and "pay" into one
 * component. Dogfooding it into meshrelay broke that idea in the first minute:
 * its selector is a controlled input (`value` / `onChange`) sitting next to a
 * pay button that owns the payment. Sites that already have a payment flow need
 * the selector alone. So: this component selects, `PaymentMethodPicker` wraps it
 * and adds the paying.
 *
 * The props are deliberately shaped like meshrelay's `NetworkSelector`, which is
 * the one that got the interaction right, so adopting it is an import swap
 * rather than a rewrite.
 *
 * TWO RULES, EACH PAID FOR IN A PRODUCTION BUG
 *
 * 1. No chain table lives here. Networks come from `getEnabledChains()`, the
 *    single source, which already carries all 21 mainnet networks the
 *    facilitator settles. describe.net deleted its own 14-network table for
 *    this reason.
 * 2. A network with no local config does NOT break the list. It renders with its
 *    raw id. With 21 networks and counting, that is a requirement, not manners.
 *
 * WHY IT IMPORTS `../chains` AND NOT `useChains()`
 * Going through the `./index` barrel pulls `X402Client` and with it `ethers`.
 * `getEnabledChains()` is a data table with no crypto in it, so the picker keeps
 * the same single source without the weight, and `react/picker` can exist as an
 * entrypoint that ships 30.8 kB instead of 64.5 kB. A picker must not make a
 * page pay for a signing stack it may never use.
 *
 * Accessibility follows meshrelay: `role="radiogroup"`, live `aria-checked`, and
 * arrow keys that move and select, per the WAI-ARIA radiogroup pattern.
 */

import { useCallback, useMemo, useRef, type KeyboardEvent, type ReactNode } from 'react';

import { getEnabledChains } from '../chains';
import type { ChainConfig, NetworkType } from '../types';

/**
 * Wallet families a browser can sign for today. The rest are listed but
 * disabled: the facilitator settles them, the browser bridge is not there yet.
 * Backlog items 1 and 2 in `docs/carrusel-de-pago-compartido.md`.
 */
export const SIGNABLE_IN_BROWSER: readonly NetworkType[] = ['evm', 'svm', 'solana'];

export const FAMILY_LABEL: Record<string, string> = {
  evm: 'EVM',
  svm: 'Solana VM',
  solana: 'Solana VM',
  stellar: 'Stellar',
  near: 'NEAR',
  algorand: 'Algorand',
  sui: 'Sui',
  xrpl: 'XRP Ledger',
};

export interface NetworkOption {
  /** Network id, as the caller and the facilitator name it. */
  id: string;
  /** Local config, or null when this build does not know the network. */
  chain: ChainConfig | null;
  /** What to show. Falls back to the raw id. */
  label: string;
  family: string;
  selectable: boolean;
  /** Why it cannot be picked. Shown to the user, never swallowed. */
  disabledReason?: string;
}

export interface NetworkPickerProps {
  /** Currently selected network. Controlled component. */
  value: string | null;
  /** Called when the user picks a different network. */
  onChange: (next: string) => void;
  /**
   * Networks to offer. Omit to offer every x402-enabled chain the SDK knows.
   * Pass the ids from a 402 `accepts` array to mirror what the resource takes.
   */
  networks?: readonly string[];
  /** Narrow by wallet family. */
  families?: readonly NetworkType[];
  /** When true, all options are non-interactive (e.g. mid-payment). */
  disabled?: boolean;
  /** Heading above the selector. */
  label?: string;
  /** Hint below the selector. */
  hint?: string;
  /** Hide the heading entirely. */
  hideLabel?: boolean;
  /** Group options under a family heading. Useful past a handful of networks. */
  groupByFamily?: boolean;
  layout?: 'carousel' | 'segmented' | 'list';
  className?: string;
  /**
   * Per-option decoration. Exists so adopting this component is not a visual
   * regression: meshrelay carries a logo, a short label and a tagline per
   * network that `ChainConfig` does not have, and it should not have to give
   * them up to stop maintaining its own selector. Everything returned is
   * optional and falls back to what the SDK knows.
   */
  decorate?: (option: NetworkOption) => {
    icon?: ReactNode;
    label?: ReactNode;
    shortLabel?: ReactNode;
    title?: string;
  };
  /**
   * Your class names, merged onto the built-in ones. A component that ships in
   * an SDK has no business imposing a look: meshrelay already has a CSS module
   * for this selector and adopting the shared logic should not cost it the
   * styling. Built-in `uvd-x402-picker__*` classes stay on, so a site can also
   * target those instead.
   */
  classNames?: Partial<
    Record<
      | 'root'
      | 'label'
      | 'group'
      | 'family'
      | 'familyLabel'
      | 'option'
      | 'optionSelected'
      | 'optionDisabled'
      | 'icon'
      | 'name'
      | 'nameShort'
      | 'reason'
      | 'hint',
      string
    >
  >;
}

/** Join the built-in class with the caller's, dropping empties. */
function cx(...parts: Array<string | false | undefined | null>): string {
  return parts.filter(Boolean).join(' ');
}

/** Match a network id to local chain config, tolerating aliases. */
export function resolveChain(
  id: string,
  chains: readonly ChainConfig[],
  aliases: readonly string[] = []
): ChainConfig | null {
  const names = [id, ...aliases].map((n) => String(n).toLowerCase());
  return (
    chains.find((c) => names.includes(c.name.toLowerCase())) ??
    chains.find((c) => names.some((n) => n === `eip155:${c.chainId}`)) ??
    null
  );
}

export function describeWhyDisabled(
  chain: ChainConfig | null,
  family: string,
  signable: boolean
): string | undefined {
  if (!chain) return 'Not configured in this build';
  if (chain.x402.enabled === false) return 'Disabled for x402';
  if (!signable) return `No browser wallet bridge for ${FAMILY_LABEL[family] ?? family} yet`;
  return undefined;
}

/** Build the option list. Exported so PaymentMethodPicker reuses the same rules. */
export function buildNetworkOptions(
  ids: readonly string[],
  chains: readonly ChainConfig[],
  families?: readonly NetworkType[]
): NetworkOption[] {
  const all = ids.map((id): NetworkOption => {
    const chain = resolveChain(id, chains);
    const family = chain?.networkType ?? 'unknown';
    const signable = SIGNABLE_IN_BROWSER.includes(family as NetworkType);
    return {
      id,
      chain,
      label: chain?.displayName ?? id,
      family,
      selectable: signable && chain !== null && chain.x402.enabled !== false,
      disabledReason: describeWhyDisabled(chain, family, signable),
    };
  });
  return families ? all.filter((o) => families.includes(o.family as NetworkType)) : all;
}

export function NetworkPicker({
  value,
  onChange,
  networks,
  families,
  disabled = false,
  label = 'Payment network',
  hint,
  hideLabel = false,
  groupByFamily = false,
  layout = 'carousel',
  className,
  decorate,
  classNames: cls = {},
}: NetworkPickerProps) {
  const chains = useMemo(() => getEnabledChains(), []);
  const buttonRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  const options = useMemo(() => {
    const ids =
      networks ?? chains.filter((c) => c.x402.enabled !== false).map((c) => c.name);
    return buildNetworkOptions(ids, chains, families);
  }, [networks, chains, families]);

  const selectable = useMemo(
    () => (disabled ? [] : options.filter((o) => o.selectable)),
    [options, disabled]
  );

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>, id: string) => {
      const keys = ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp'];
      if (!keys.includes(event.key) || selectable.length === 0) return;
      event.preventDefault();
      const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : -1;
      const at = selectable.findIndex((o) => o.id === id);
      const next = selectable[(at + step + selectable.length) % selectable.length];
      if (!next) return;
      onChange(next.id);
      buttonRefs.current[next.id]?.focus();
    },
    [selectable, onChange]
  );

  const renderOption = (option: NetworkOption) => {
    const isSelected = value === option.id;
    const usable = option.selectable && !disabled;
    const isFirstFallback = value === null && selectable[0]?.id === option.id;
    const extra = decorate?.(option);
    return (
      <button
        key={option.id}
        ref={(el) => {
          buttonRefs.current[option.id] = el;
        }}
        type="button"
        role="radio"
        aria-checked={isSelected}
        aria-disabled={!usable}
        disabled={!usable}
        title={extra?.title ?? option.disabledReason}
        tabIndex={isSelected || isFirstFallback ? 0 : -1}
        onClick={() => usable && onChange(option.id)}
        onKeyDown={(event) => onKeyDown(event, option.id)}
        className={cx(
          'uvd-x402-picker__option',
          cls.option,
          isSelected && 'is-selected',
          isSelected && cls.optionSelected,
          !usable && cls.optionDisabled
        )}
      >
        {extra?.icon}
        <span className={cx('uvd-x402-picker__name', cls.name)}>
          {extra?.label ?? option.label}
        </span>
        {extra?.shortLabel && (
          <span className={cx('uvd-x402-picker__name-short', cls.nameShort)}>
            {extra.shortLabel}
          </span>
        )}
        {option.disabledReason && (
          <span className={cx('uvd-x402-picker__reason', cls.reason)}>
            {option.disabledReason}
          </span>
        )}
      </button>
    );
  };

  const grouped = useMemo(() => {
    if (!groupByFamily) return null;
    const map = new Map<string, NetworkOption[]>();
    for (const option of options) {
      const list = map.get(option.family) ?? [];
      list.push(option);
      map.set(option.family, list);
    }
    return [...map.entries()];
  }, [options, groupByFamily]);

  return (
    <div
      className={cx(
        'uvd-x402-picker',
        `uvd-x402-picker--${layout}`,
        cls.root,
        className
      )}
    >
      {!hideLabel && (
        <h3 className={cx('uvd-x402-picker__label', cls.label)}>{label}</h3>
      )}

      <div
        role="radiogroup"
        aria-label={label}
        className={cx('uvd-x402-picker__group', cls.group)}
      >
        {grouped
          ? grouped.map(([family, entries]) => (
              <section key={family} className={cx('uvd-x402-picker__family', cls.family)}>
                <h4 className={cx('uvd-x402-picker__family-label', cls.familyLabel)}>
                  {FAMILY_LABEL[family] ?? family}
                </h4>
                {entries.map(renderOption)}
              </section>
            ))
          : options.map(renderOption)}
      </div>

      {hint && <p className={cx('uvd-x402-picker__hint', cls.hint)}>{hint}</p>}
    </div>
  );
}
