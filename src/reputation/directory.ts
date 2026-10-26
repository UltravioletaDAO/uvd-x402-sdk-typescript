/**
 * Which wallet a rating for a viewer goes to, from a list of self-declared
 * (login, wallet) pairs, such as Karma Hello's wallet list.
 *
 * A wallet claimed by more than one login is SHARED and resolves to nobody:
 * N accounts pointing at one wallet is exactly how a single person farms N
 * times the reputation, and the list cannot tell that apart from family
 * members sharing one. Nothing is written to a shared wallet until one of the
 * accounts proves it holds the key. A login listed twice with different
 * wallets resolves to nobody either.
 *
 * Logins and wallets compare case-insensitively (Twitch logins are lowercase;
 * a wallet in two cases is one wallet). An entry whose wallet is not an EVM
 * address is ignored.
 */

import { isAddress } from './values';

export interface WalletEntry {
  login: string;
  wallet: string;
}

export interface WalletDirectory {
  /** The wallet (lowercase) for `login`, or `null` when unknown, ambiguous or shared. */
  lookup(login: string): string | null;
  /** Wallets claimed by more than one login, lowercase. */
  readonly shared: ReadonlySet<string>;
  /** Logins listed with more than one wallet, lowercase. */
  readonly ambiguous: ReadonlySet<string>;
}

export function walletDirectory(entries: Iterable<WalletEntry>): WalletDirectory {
  const walletsByLogin = new Map<string, Set<string>>();
  const loginsByWallet = new Map<string, Set<string>>();
  for (const entry of entries) {
    if (!entry || typeof entry.login !== 'string' || !isAddress(entry.wallet)) continue;
    const login = entry.login.trim().toLowerCase();
    if (login === '') continue;
    const wallet = entry.wallet.toLowerCase();
    if (!walletsByLogin.has(login)) walletsByLogin.set(login, new Set());
    walletsByLogin.get(login)!.add(wallet);
    if (!loginsByWallet.has(wallet)) loginsByWallet.set(wallet, new Set());
    loginsByWallet.get(wallet)!.add(login);
  }
  const shared = new Set([...loginsByWallet].filter(([, logins]) => logins.size > 1).map(([w]) => w));
  const ambiguous = new Set([...walletsByLogin].filter(([, wallets]) => wallets.size > 1).map(([l]) => l));
  return {
    lookup(login: string): string | null {
      if (typeof login !== 'string') return null;
      const key = login.trim().toLowerCase();
      const wallets = walletsByLogin.get(key);
      if (!wallets || wallets.size !== 1) return null;
      const [wallet] = wallets;
      return shared.has(wallet) ? null : wallet;
    },
    shared,
    ambiguous,
  };
}
