# Changelog

## [2.100.0] - 2026-09-26

### Added

- `stackKey` and `stackKeyHosts` (`StackKeyOptions`, exported) on everything that calls the facilitator. Clients: `FacilitatorClient` (so also the Express and Hono middlewares, which pass both to their client), `Erc8004Client`, `BazaarClient`, `EscrowClient` and `AdvancedEscrowClient`. Functions: `anchorEvidence`, `availableBackends`, `streamTrafficEvents` and `getFacilitatorReceipt`. The stack key is the per-service credential of a service run by Ultravioleta DAO, sent as `X-UVD-Stack-Key`. The facilitator exempts a key it recognises from its rate-limit policy (`429`) and changes nothing else; a facilitator that does not know the header ignores it.
- Where it goes: every call to the facilitator. `FacilitatorClient`: `/verify` and `/settle` (automatic retries included), `/accepts`, `/supported`, `/version`, `/health`, `/api/stats`, `/transactions`, `/blacklist`. `Erc8004Client`: every write and every facilitator read, never `resolveAgentUri`, which fetches the agent's own URI. `BazaarClient` and `EscrowClient`: every call. `AdvancedEscrowClient`: `/settle` (authorize, release, refund) and `/escrow/state`, never the RPC. `anchorEvidence` / `availableBackends`: `/dx402/anchor` and `/dx402/stats`. `streamTrafficEvents`: `/events`. `getFacilitatorReceipt`: `/receipts/:id`.
- The key only travels to a house facilitator, checked on the URL of every request: `https://facilitator.ultravioletadao.xyz`, or `https://` to a host in `stackKeyHosts`. That list ADDS to the house facilitator and cannot remove it; entries are hostnames, compared exactly and ignoring case. Plain `http://` is accepted only for `127.0.0.1` or `localhost` listed there (a local facilitator or a test double). A request to any other URL carries no header, whether the key came from the option or from the environment, and the SDK warns once per process with the scheme and host only (never the key, and never the rest of the URL, which can carry credentials). `EscrowClient`'s default base URL, `escrow.ultravioletadao.xyz`, is not the facilitator: it gets the key only if listed.
- The key does not follow redirects. A redirect (any `3xx`, or a browser's opaque redirect) answered to a request that carries it fails with `StackKeyRedirectError` (exported, with `status`), and the key is not sent again, not even by the automatic retries. Where the call reports failures as data it keeps doing so: `verify`/`settle` answer `isValid`/`success: false` with the error's message, `anchorEvidence` skips with `status` and `error`, `availableBackends` resolves to `[]`; the other calls throw it. Without a key, requests are exactly what they were.
- Default: `process.env.UVD_STACK_KEY`, read once when the client (or the function call) is set up. `stackKey: ''` sends none and does not read the environment. Without a key nothing changes: no header is sent, and no warning.
- A key that was read badly never breaks a payment. One leading BOM (U+FEFF), then spaces, tabs, CR and LF at both ends, are removed, and nothing else (the same rule as the Python SDK); a value that then does not match `^uvdsk_[A-Za-z0-9_-]{43,128}$` is not sent, and the SDK warns once per process without the value. A value no header can carry makes `fetch` throw before sending (Node's message includes the value), which would have failed every `/verify` and `/settle` of the client.
- The key is held outside the client object: `console.log`, `util.inspect` and `JSON.stringify` of a client never show it, and it is in no result, error or warning.
- Tests: `src/backend/stack-key.test.ts` (31), `src/backend/stack-key-functions.test.ts` (13) and `src/backend/stack-key-redirect.test.ts` (9), with fetch doubles that record each request exactly as passed and HTTP servers on 127.0.0.1. Nothing leaves the machine, including the calls addressed to the house facilitator. Each of 49 mutations that undoes one rule turns one of them red.

## [2.99.1] - 2026-09-24

### Fixed

- The atomic amount on non-EVM chains no longer goes through a float. The Solana/Fogo, NEAR, Algorand, Stellar and Sui providers computed it as `Math.floor(parseFloat(amount) * 10 ** decimals)`: `2.01 * 1e6` is `2009999.9999999998`, so `"2.01"` was signed as 2,009,999 atoms instead of 2,010,000. Of the 9,999 cent prices from 0.01 to 99.99, 151 came out one atom short at 6 decimals and 636 at Stellar's 7. Off EVM the facilitator compares the amount by equality, so each of those payments was rejected against an exact requirement. The EVM signing path already used `parseUnits` and is unchanged.
- One conversion for all of them, `toAtomicUnits(amount, decimals)` (`src/utils/amount.ts`, internal). The digit arithmetic is ethers' `parseUnits`, the same function the EVM path signs with. On top of it, the helper refuses with `INVALID_AMOUNT`: a sign, exponent notation, whitespace, a non-string, anything that is not a plain decimal, and a nonzero digit past the token's decimals. Such inputs used to be truncated or rounded, or produced `NaN`. Trailing zeros are accepted (`"1.0000000"` is 1,000,000 at 6 decimals). A number or an exponent-notation string passed as `amount` is now refused on these chains, as ethers' `parseUnits` already refuses it on EVM.
- XRPL: the amount went through `xrpToDrops`, and when that threw it fell back to `Math.round(parseFloat(amount) * 1e6)`, so an amount with a nonzero seventh decimal or no numeric value at all was signed rounded instead of refused. It now goes through `toAtomicUnits` like the other chains, which also refuses the exponent-notation and negative amounts `xrpToDrops` accepted.
- Seller side: `buildPaymentRequirements` and `generatePaymentOptions` built the price the same way, on every chain including EVM: `"2.01"` asked for `2009999`, and an 18-decimal token priced at 1000 or more came out in exponent notation (`"1e+21"`). Both now return the exact atomic amount. An amount that is malformed, or that a listed token cannot hold exactly, throws instead of being truncated.
- Tests read the amount back from the bytes each provider builds (the Solana TransferChecked `u64`, the NEAR `ft_transfer` arguments, the Algorand ASA transfer, the Stellar `transfer` `i128`, the Sui `SplitCoins` `u64`, the XRPL `Amount`) for every cent price from 0.01 to 99.99, and the helper alone for every one from 0.01 to 9,999.99. Returning any of these sites to the float conversion fails them. EVM tests and fixtures are untouched.

## [2.99.0] - 2026-09-23

- Escrow on Arc. `ESCROW_CONTRACTS` gains `5042` (Arc) and `5042002` (Arc Testnet) on the x402r canonical escrow: AuthCaptureEscrow `0xBdEA0D1bcC5966192B070Fdf62aB4EF5b4420cff`, token collector (ERC3009PaymentCollector) `0x0E3dF9510de65469C4518D7843919c0b8C7A7757`, ProtocolFeeConfig `0xBe2d24614F339a1eB103A399F93AA2a39Ca815Bc`, RefundRequestFactory `0xe971C674fD5c3462023f3F891dF6289DFbC9CEFC`, USDC read from the chain registry, and operator `0x0258472A1410Ac3Ad720f1BC83f22B3c0af1Fd9D`, the `computeAddress` result of PaymentOperatorFactory v1.0.2 `0xc24153B7ED8DC03e551F29DDEeA5CadFe57e2716`. `USDC_DOMAIN_NAME` gains both networks (`USDC`, from the chain registry).
- Operator generation per chain: `ESCROW_OPERATOR_GENERATION` and `getEscrowOperatorGeneration()` name the operator ABI of every registered chain (`'v1'` `OPERATOR_ABI`, `'v2'` `OPERATOR_ABI_CREATE3`, `'v3'` `OPERATOR_ABI_V3`; `'v1'` for an unlisted chain). They replace the module-private CREATE3 chain set. Arc and Arc Testnet are `'v3'`.
- `OPERATOR_ABI_V3`: `capture`, `void`, `refund`, `FEE_RECEIVER` and the five `*_PRE_ACTION_CONDITION` getters, each selector checked against the factory bytecode recorded on Arc. On a v3 chain, `AdvancedEscrowClient.release` sends `capture(paymentInfo, amount, 0x)`. `refundInEscrow` sends `void(paymentInfo, 0x)`, which takes no amount and returns the whole `capturableAmount`, so the client reads that amount on-chain (`getHash` + `paymentState`) and sends only when the requested amount equals it; otherwise it sends nothing and returns `errorCode` `ESCROW_VOID_AMOUNT_MISMATCH`, or `ESCROW_NOTHING_TO_VOID` when the amount is 0. To return part of an escrow, `release` the part the receiver keeps and `refundInEscrow` the rest. `refundPostEscrow` sends `refund(paymentInfo, amount, tokenCollector, collectorData)`, the same arguments. A v3 call to an operator with no code returns `ESCROW_OPERATOR_NOT_DEPLOYED` and sends nothing; `charge` returns `ESCROW_UNSUPPORTED_ON_GENERATION` without signing or sending.
- `VERIFIED_USDC_DOMAINS` (root export): the USDC EIP-712 domains this SDK checked against the token's own `DOMAIN_SEPARATOR()`, today Arc and Arc Testnet (`USDC` / `2`, read from the chain registry). `buildEscrowPreAuth` refuses with `INVALID_CONFIG`, before signing, a config whose `usdc_domain_name` / `usdc_domain_version` differ from the verified pair for its chain. A chain outside the table is signed exactly as before.
- Arc pre-auth vector in its own file, `src/escrow-preauth.arc-vector.json`: the Python SDK's Arc pre-auth case, key for key. Its nonce is the `AuthCaptureEscrow.getHash` answer read on chain 5042, its USDC domain is the token's own `name()` / `version()`, and the Python SDK builds the same header from the same inputs, signature included. Derived by `scripts/derive-arc-escrow-preauth-vector.mjs`. The shared `src/escrow-preauth.vectors.json` is unchanged, and a test now pins its sha256 so that it stays byte-identical to its mirrored copies.
- Measurements: `src/fixtures/arc-escrow-d.rpc.json`, recorded from the public Arc RPCs by `scripts/record-arc-escrow-d.mjs` (blocks 22439550 on Arc, 63685410 on Arc Testnet): factory bytecode, `computeAddress`, the factory's `ESCROW()` / `PROTOCOL_FEE_CONFIG()`, the collector's `authCaptureEscrow()`, code at every address, USDC `name()` / `version()` / `DOMAIN_SEPARATOR()`, `getHash` and `paymentState`.
- No other network changed. `src/backend/escrow-operator-snapshot.test.ts` pins, as 2.98.0 produced them, the calldata of `release`, `refundInEscrow`, `charge` and `refundPostEscrow` in both signer modes and the `authorize` body on Base and SKALE Base, plus the registry entries, operator ABIs and USDC domain names of every chain.

## [2.98.0] - 2026-09-23

- ERC-8004 on Arc. `arc` and `arc-testnet` are now `Erc8004Network`s, and `ERC8004_CONTRACTS` carries the canonical registries for both: identity, reputation and validation. On `arc` these are `0x8004A169…a432`, `0x8004BAa1…9b63` and `0x8004Cc84…AB58`; on `arc-testnet`, `0x8004A818…BD9e`, `0x8004B663…8713` and `0x8004Cb1B…4272`. These are the addresses the facilitator names in `ARC_MAINNET_CONTRACTS` / `ARC_TESTNET_CONTRACTS`. Each was read on-chain on 2026-09-23: an EIP-1967 proxy with the same implementation as Base / Base Sepolia, and `getVersion()` = 2.0.0.
- `arc` joins `RELAYED_FEEDBACK_NETWORKS`, so `supportsRelayedFeedback('arc')` is `true`. Its v4 `FeedbackDelegate` is `0x955Cc9fB9aB95FC0821ae74197D273dde5dA84f1` (facilitator 2.38.0+), and the rating is recorded under the rater's address. `arc-testnet` stays out: the facilitator serves ERC-8004 reads there, but `POST /feedback/evm/prepare` answers 400 because no delegate is deployed.
- No other network changed. `src/erc8004-arc.test.ts` pins the three exported lists as 2.97.0 built them: the 2.97.0 table entries must stay byte-identical, the only additions to the table are `arc` / `arc-testnet`, the only addition to the relayed rail is `arc`, and the Solana rail is untouched.
- Docs: the README's ERC-8004 network list is 23 (21 EVM + 2 Solana). It had also been missing `scroll`, and it named Base `base-mainnet`, a spelling the facilitator rejects. `docs/networks/arc.md` gains an ERC-8004 section with the measurements.

## [2.97.0] - 2026-09-23

- One purchase binding per payment: every `/verify` and `/settle` call now carries an `Idempotency-Key`, the same one for both calls of a payment and for every retry. `verifyAndSettle` and the Express/Hono middlewares create one per payment; `verify`/`settle`/`verifyAndSettle` accept `{ idempotencyKey }` and report the key they sent. New `createIdempotencyKey()` (random, never derived from the X-PAYMENT).
- Facilitators with durable receipts return an admitted payment's original answer only to the binding that admitted it. The SDK now reads their refusals as data instead of a `500`: `authorization_already_settled` and `receipt_request_conflict` (`/settle` 409, `/verify` `isValid: false`) are not retryable, and `authorization_in_flight` is `retryable` to learn the verdict. New `AUTHORIZATION_ALREADY_SETTLED`, `AUTHORIZATION_IN_FLIGHT`, `RECEIPT_REQUEST_CONFLICT`, `isAuthorizationAlreadyUsed`, `isAuthorizationInFlight`, `buildPaymentConflictResponse`.
- `SettleResponse.replayed` reports `Idempotent-Replayed: true`. A replay reached with a fresh key and no purchase context (older facilitators replay to any resend) is answered as `authorization_already_settled` / `authorization_in_flight`, without the success fields a caller could deliver on. A replay bound by the caller's key or the buyer's `X-UVD-Purchase` is kept. A `2xx` body `error` (e.g. `settlement_in_progress`) is now `errorCode`.
- Express and Hono middlewares: an X-PAYMENT already used is answered `409` (or `503` + `Retry-After` while in flight) and the handler does not run, never `402` or `500`; `PAYMENT-RESPONSE` is added to an existing `Access-Control-Expose-Headers` and `no-store` to an existing `Cache-Control` instead of replacing them (`mergePaymentResponseHeaders`, `mergeHeaderList`); in `'manual'` mode a `settle()` after the handler answered no longer sets headers on the sent response (Express threw `ERR_HTTP_HEADERS_SENT` and `settle()` rejected). The merchant's key is not propagated to the buyer.
- Facilitators and networks without receipts: responses are read exactly as before (tests with facilitator doubles). They receive the new header; the facilitator's own settle cache only matches a retry of the same payment's settle.
- Docs: EURC on Arc mainnet is confirmed with funded payments through the public facilitator (x402 v1 and v2, 2026-09-22, hashes in `docs/networks/arc.md`); Arc testnet funded acceptance stays pending. The README network table listed Arc and Arc Testnet as USDC-only since 2.94.0 added EURC: fixed, and `src/readme-eurc-table.test.ts` now pins the table's EURC column to the registry in both directions. No runtime change.

## [2.96.0] - 2026-09-17

- Add portable signed facilitator receipts for Arc exact USDC/EURC and Hedera USDC, including both mainnet and testnet.
- Bind receipts to purchase and authorization; preserve payment state independently of the merchant HTTP result.
- Persist and resume the original authorization, expose private receipt lookup, and verify Ed25519 provenance with trusted issuer keys.
- Document recovery limits, merchant propagation and the pending live EURC acceptance.


## 2.95.0 — 2026-09-17

Hedera mainnet/testnet payment policy is native USDC only. HBAR and custom token offers are rejected before signing; HBAR remains the sponsor fee currency.

Migration: replace HBAR requirements with the network-specific USDC token and six-decimal atomic amounts. There is no automatic currency conversion. Historical transaction evidence is retained. Arc USDC/EURC support is unchanged.


## 2.94.0 — 2026-09-17

- Register EURC for Arc mainnet/testnet with six-decimal euro units and EIP-712 EURC/2.
- Add signature/domain isolation tests and explicit atomic merchant examples.
- Mark EURC as non-USD; live funded EURC payments remain pending by operator decision.


All notable changes to `uvd-x402-sdk` are documented here, starting at v2.47.0.
For earlier versions see the git history (each release commit carries its
version in the subject, e.g. `feat(stats): ... (v2.46.0)`).

## [2.92.0] - 2026-09-16

- Add Arc mainnet (`arc`, `eip155:5042`) and testnet (`arc-testnet`, `eip155:5042002`) to the enabled chain registry, wallet selection, signing and v1/v2 payment requirements.
- USDC payments use `0x3600000000000000000000000000000000000000`, 6 decimals, and EIP-712 domain `USDC` / `2`. Native USDC gas retains 18 decimals on the same balance.
- Run the Arc payment/signing tests for both networks, including the 18-versus-6 decimal regression. Add [Arc integration examples](docs/networks/arc.md).
- 27 enabled networks, including 17 EVM networks. BSC remains disabled. Arc covers direct USDC `exact` EOA payments.

## [2.91.0] - 2026-09-13

**La autorización EIP-3009 vive 300 s en todas las redes, y ahora se puede
cambiar.** Hasta 2.90.0 la ventana (`validBefore = now + N`) era 300 s en Base y
**60 s en las otras once redes EVM**, escrita dos veces y sin forma de
sobreescribirla. Un vendedor que liquida async (verificar → entregar → liquidar)
tenía que cerrar el `settle` en esos 60 s, menos los 6 s de gracia del
facilitador, o la autorización expiraba sola y el vendedor revocaba un acceso
que sí se pagó. Es el flujo de MeshRelay Turnstile. Issue #2.

### Changed

- **Default de 300 s en todas las redes EVM** (antes 300 en Base, 60 en el
  resto). 300 no es a ojo, y tampoco es algo que el facilitador publique como
  suyo: su `/supported` no trae ningún timeout. Es el timeout que anuncia por
  default el lado **vendedor de este mismo SDK**
  (`DEFAULT_PAYMENT_TIMEOUT_SECONDS`, `src/backend/index.ts:1520`), así que
  comprador y vendedor de `uvd-x402-sdk` coinciden sin configurar nada. Es lo
  que anuncia MeshRelay Turnstile, el vendedor async que destapó el problema
  (`turnstile/payments.js:121` y `:357`, meshrelay `d4015a2`). Y es el fallback
  que el catálogo del facilitador le pone a una entrada que omite el campo
  (`DEFAULT_MAX_TIMEOUT_SECS`, x402-rs `src/discovery_price.rs:143`, `d8a3360`).
  El facilitador solo rechaza ventanas **cortas**: `assert_time` (x402-rs
  `src/chain/evm.rs:1782-1810`) exige `valid_before >= now + 6 s`, en verify y
  en settle, y no pone techo. Por eso ampliar la ventana no hace que un pago que
  antes pasaba ahora falle. Base no cambia.
- **`X402Client.fetch()` firma la ventana que declara el vendedor.** Si el 402
  trae `maxTimeoutSeconds`, la ventana es ese valor acotado a `[1, 3600]`; si no
  lo trae, la del cliente (default 300). Antes el comprador ignoraba el campo, y
  un vendedor que anunciara más de 300 recibía una firma que vencía antes de su
  propio `settle`.
- **Una config inválida se rechaza al construir el cliente**, no en el primer
  pago: `new X402Client({ validitySeconds: -300 })` lanza `INVALID_CONFIG`.

### Added

- **`validitySeconds`** en `PaymentInfo` (por pago) y en `X402ClientConfig`
  (default del cliente). Precedencia: el pago, después el cliente, después 300.
  Un valor que no es un entero positivo se rechaza con `INVALID_CONFIG` **antes**
  de firmar, en vez de caer en silencio al default.
- **Techo de 3600 s (`MAX_VALIDITY_SECONDS`)**, que es el default del SDK Python
  y lo más largo que firma hoy cualquier SDK de la casa. Existe porque
  `PaymentInfo` tiene la forma de un 402 parseado: quien le pase la respuesta del
  vendedor tal cual a `createPayment()` estaría dejando que **el vendedor** elija
  cuánto vive la autorización del pagador. Una ventana de un año es un derecho de
  cobro en pie: el comprador la da por vencida y se liquida meses después.
  El facilitador no pone techo —solo rechaza ventanas cortas—, y por eso lo pone
  el SDK del pagador.
- **`X402PaymentOffer.maxTimeoutSeconds`**: `parse402` mapea el campo del 402 al
  tipo (antes solo quedaba dentro de `raw`). Un valor que no es un número finito
  cuenta como no declarado: la oferta sigue siendo legible y aplica la ventana
  del cliente.
- **Sección «Validity window» en el README**, con los tres lugares de donde sale
  la ventana y la precedencia.
- **`DEFAULT_VALIDITY_SECONDS`**, **`MAX_VALIDITY_SECONDS`**,
  **`resolveValiditySeconds()`** y **`clampValiditySeconds()`** exportados
  (`src/utils/validity.ts`): una sola definición que leen los dos caminos de
  firma, `X402Client.createPayment()` y `EVMProvider.signPayment()`. Un test
  verifica que los dos firman la misma ventana, red por red.

### Notes

- El SDK Python sigue con `valid_duration = 3600`. Los dos SDK ya son
  configurables; el default de TypeScript es el que anuncia el lado vendedor de
  este mismo SDK. El lado **vendedor** de Python anuncia 60 por default, y
  execution-market lo sobreescribe a mano: es una fila aparte para
  `uvd-x402-sdk-python`.

## [2.90.0] - 2026-09-11

**El primer clic en "Pagar" ya abre la billetera.** `usePayment().pay()` era un
`useCallback` cerrado sobre el `isConnected` del render que lo creó: un handler
que hacía `await connect()` y enseguida `pay()` usaba el `pay` de antes de que
existiera la billetera, tiraba "Wallet not connected", y solo el segundo clic,
ya re-renderizado, firmaba. Medido con Rabby en un consumidor real.

### Fixed

- **`usePayment().pay()`** pregunta `client.getState().connected` en el momento
  de pagar. El cliente es la fuente de verdad; el estado del contexto es una
  foto del render anterior.

### Docs

- **`docs/fricciones-al-montar-un-cobro.md`**: doce fricciones medidas al montar
  un cobro completo con este SDK (gateway en Lambda + panel React), con lo que
  cambiaría en cada una y lo que sí funcionó a la primera. Entre ellas: `pay()`
  manda dos headers (`X-PAYMENT` y `PAYMENT-SIGNATURE`) y un preflight sin
  `payment-signature` da "Failed to fetch" sin rastro; un rechazo del
  facilitador no deja log si el consumidor no lo escribe, y fuera de Base la
  firma vence en 60 s; desde 2.88 Solana entra por `import()` dinámico y hay que
  marcar `@solana/web3.js` y `@solana/spl-token` como `external` en esbuild.

## [2.89.0] - 2026-09-10

**La decisión de comprar se toma contra la oferta en la mano, no contra el
catálogo.** Un listado es lo que alguien dijo de su propio precio; el `402` que
vuelve del request es la oferta, y pueden diferir legítimamente. Así que ahora la
decisión se evalúa contra **la oferta concreta**, siempre, antes de firmar. Es el
mismo contrato que el facilitador fijó en Rust (`x402-reqwest`, release 2.25.0),
escrito una sola vez para que un comprador en cualquiera de los dos lenguajes
niegue los mismos pagos por las mismas causas nombradas.

**Nada cambia para quien no escribe una política.** `X402Client` sin `policy`
sostiene `PurchasePolicy.permissive()`, porque este SDK no tenía presupuesto antes
de esta versión y encenderlo en silencio rechazaría pagos que los consumidores
hacen hoy. La asimetría es a propósito: quien se sienta a **escribir** una política
se lleva el default seguro.

### Added

- **`PurchasePolicy`** (`src/policy.ts`) — los cinco campos del contrato:

  | campo | tipo | significado |
  |---|---|---|
  | `perPayment(asset, amount)` | `bigint`, unidades atómicas | máximo de UN pago en ese activo |
  | `cumulative(asset, amount)` | `bigint`, unidades atómicas | máximo total mientras viva la política |
  | `spent(asset)` | `bigint` | lo ya registrado; **solo lo mueve `recordSpend`** |
  | `onlyPay([...])` | direcciones | destinatarios permitidos, canonicalizados **por familia** |
  | `allowUnlistedAssets()` | booleano, **false por defecto** | si se puede pagar un activo sin techo declarado |

  ```ts
  import { X402Client, PurchasePolicy } from 'uvd-x402-sdk';

  const USDC_BASE = { network: 'base', address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' };
  const policy = PurchasePolicy.create()      // create() DENIEGA lo que no presupuestaste
    .perPayment(USDC_BASE, 50_000n)           // 0.05 USDC
    .cumulative(USDC_BASE, 1_000_000n)        // 1 USDC en total
    .onlyPay(['0xe4dc963c56979E0260fc146b87eE24F18220e545']);

  const client = new X402Client({ defaultChain: 'base', policy });

  const res = await client.fetch('https://api.example.com/data', {
    onPaid: (a) => client.policy.recordSpend(a.asset, a.amount),  // evaluar NO gasta
  });
  ```

- **Orden de evaluación fijo, y es parte del contrato**, porque la PRIMERA causa que
  falla es la que se reporta y quien llama ramifica sobre ella:

  `no-readable-offer` → `offer-expired` → `recipient-not-permitted` →
  `asset-not-budgeted` → `per-payment-limit` → `cumulative-limit`

  Los seis son un vocabulario **cerrado** en kebab (`PolicyRefusalCode`), tipado
  como unión literal, para ramificar sin parsear inglés. No hay `other`: una negativa
  que quien llama no puede interpretar es una negativa que va a tapar. Cada una lleva
  los números que la causaron (`requested`, `allowed`, `spent`, `wouldTotal`, `asset`,
  `payTo`, `validUntil`, `now`, `offered[]`).

- **`PolicyRefusedError`** — extiende `X402Error` con código `POLICY_REFUSED`, así
  que un consumidor que ya atrapa `X402Error` sigue atrapándolo; la causa tipada está
  en `err.refusal` y su código estable en `err.refusal.code`.

- **Vigencia de oferta: `offerValidUntil(extensions)`** lee
  `extensions["offer-receipt/1"].info.validUntil` en segundos Unix, y
  **`OFFER_VALIDITY_EXTENSION`** es esa clave, definida una sola vez. La versión va
  EN la clave porque el transporte de offer-and-receipt todavía puede cambiar, y un
  valor leído de una clave sin versión no podría compararse con nada después. Una
  clave que no reconocemos se ignora: eso significa "sin vencimiento declarado", que
  es distinto de "venció".

- **`decideOnChallenge(policy, challenge, offer, { now })`** — los seis pasos, en un
  solo lugar, **sin stack de red**. Toma el desafío COMPLETO a propósito: pasar las
  ofertas solas es exactamente lo que tiró el `validUntil` del vendedor al piso en
  Rust durante un commit entero con todos los tests en verde, y una firma que toma
  las partes invita a repetirlo. Una decisión que solo se puede ejercer manejando un
  cliente HTTP real es una decisión que nadie testea.

- **`X402FetchOptions.advertised`** — lo que decía el catálogo, para que la
  divergencia se reporte en `approval.versusQuote` (`not-compared` | `matches` |
  `amount-differs` | `different-asset`). **Nunca decide nada.**

- **`X402FetchOptions.onPaid`** — se llama cuando el reintento volvió con algo que no
  es otro `402`, o sea cuando el vendedor aceptó el pago. Es el lugar donde quien
  llama hace `recordSpend`. Nada es automático acá: **evaluar no gasta**.

### Changed

- **`accepts` es una LISTA, y una entrada ilegible ya no hunde la lista.** Un vendedor
  que ofrecía algo pagable **al lado de** un esquema que este build no implementa
  quedaba sin ofertas usables, y quien compraba nunca se enteraba de que había una
  oferta perfectamente pagable ahí mismo. Ahora las legibles se conservan y las otras
  se cuentan **por nombre de esquema**, así que la negativa dice qué ofreció el
  vendedor:

  ```
  no offer in this challenge is one this build can pay; offered: ["batch-settlement","agent-pay"]
  ```

  Descubrir el servicio sigue funcionando aunque comprarlo automáticamente no.

- **Tres hechos que antes eran un solo error.** `client.fetch()` ahora distingue "el
  vendedor no mandó ofertas" (sigue siendo `NO_ACCEPTABLE_PAYMENT`, sin cambio) de
  "mandó ofertas que no sabemos leer" (`POLICY_REFUSED` / `no-readable-offer`, con los
  nombres de esquema) y de "mandó ofertas pagables". El primer mensaje era justo el
  que manda a alguien a buscar un bug en su propio código.

- **`maxAmount` queda intacto** y sigue corriendo **antes** de la política: quien puso
  un techo y ninguna política conserva exactamente el comportamiento que tenía.

- **El `scheme` de la oferta ahora decide, y antes no decidía nada.** `parse402` solo
  exigía monto, payee y red, así que una oferta **bien formada** pidiendo
  `batch-settlement` se leía como pagable y después se **firmaba como `exact`**: un
  pago ofrecido al vendedor bajo un esquema que nunca pidió. Ahora hay dos conjuntos,
  y son dos preguntas distintas:

  - **`KNOWN_SCHEMES`** — el vocabulario compartido con los otros dos SDK: `exact`,
    `upto`, `escrow`, `commerce`, `fhe-transfer`. Los mismos cinco del enum cerrado
    `Scheme` de `x402-rs` y de `KNOWN_SCHEMES` en Python. Un esquema fuera de esos
    cinco no lo sabe nombrar ninguna implementación del stack.
  - **`CLIENT_PAYABLE_SCHEMES`** — de esos, los que **este** camino de comprador
    puede firmar: `exact`, y nada más, porque el constructor de payload estampa
    `scheme: 'exact'` en todo lo que produce. `escrow` y `commerce` están del lado
    **vendedor**; `upto` y `fhe-transfer` no están.

  **Reconocer un esquema no es poder pagarlo**, y colapsar los dos conjuntos en uno
  reabre el agujero exacto: con los cinco como pagables, una oferta `escrow` bien
  formada se vuelve a firmar como `exact`. Las dos situaciones terminan igual para
  quien llama — la entrada queda afuera y se cuenta por su nombre de esquema — y
  `no-readable-offer` dice "no offer in this challenge is one this build **can
  pay**", que es el marco de las dos.

- **BREAKING (comprador): un `accepts` sin `scheme` ahora es ilegible, no `exact`.**
  Rust exige el campo, así que allá un desafío sin él no deserializa; un comprador
  que adivinara `exact` firmaría bajo un esquema que el vendedor nunca nombró — el
  mismo agujero que firmar uno nombrado que no podemos presentar, pero sin la
  evidencia. Se cuenta (`unreadableCount`) sin nombre, porque no tiene ninguno que
  reportar.

  Es **asimétrico a propósito** con el lado vendedor de este mismo SDK, donde un
  `scheme` ausente se lee como `exact` (`src/backend/index.ts`: "'exact' is the
  default, not an override"). Un vendedor es indulgente con lo que acepta; un
  comprador es estricto con lo que firma. Todos los fixtures de la suite declaran
  `scheme`, así que nada acá se rompió — pero un vendedor real que lo omita se vuelve
  impagable por este camino, y eso es observable.

- **La política ya no puede aprobar un activo y firmar otro.** `evaluate()` juzga el
  `asset` de la oferta, pero `createPayment()` firma el token al que resuelve
  `tokenType` en esa cadena, y lee el precio con **los decimales de ese** token. Con
  USDC en los dos lados coinciden, que es por lo que nunca se vio. No tienen por qué:
  un vendedor cotizando en otro token daba aprobación sobre el activo A y firma sobre
  el activo B, y quien llamaba creía tener un presupuesto que nunca se aplicó.

  Ahora una oferta que nombra un activo distinto al de `tokenType` se **rechaza**
  (`NO_ACCEPTABLE_PAYMENT`, con los dos addresses en el mensaje), en vez de
  re-apuntarse en silencio: con qué token pagar es decisión de quien llama, y
  adivinarlo del `402` del vendedor es cómo una wallet termina firmando por un token
  que nadie eligió. Corre **después** de la política, así que un activo no
  presupuestado sigue reportándose como `asset-not-budgeted`, que es la causa útil. La
  comparación es canonicalizada, así que un USDC en minúscula frente al registro en
  checksum no es un desalineo.

### Notas — las reglas que no se negocian

1. **Evaluar no gasta.** Firmar puede fallar y una liquidación puede rechazarse; un
   límite que contara intentos dejaría a quien llama sin dinero que nunca gastó.
   `recordSpend` es una llamada aparte, después de que la liquidación resolvió.
2. **La política no se ensancha desde dentro de una evaluación.** No hay método que
   suba un techo: todos los builders devuelven una política NUEVA y dejan la receptora
   igual de estricta. Un test lo fija.
3. **No se pide confirmación humana** si la política ya cubre la operación. Una
   divergencia respecto del listado **no es, por sí sola, una negativa**: si la oferta
   cuesta más que lo que decía el catálogo pero entra en una política que el operador
   ya autorizó, se paga. Parar a preguntar convertiría cada repricing ordinario en un
   alto, y un agente que se detiene ante el comercio normal es un agente que nadie
   puede dejar corriendo. **No hay gancho de confirmación en este camino.**
4. **Un activo distinto no es el mismo precio**: no se comparan números entre activos,
   y el mismo address en otra red es **otro** activo. Un presupuesto en USDC no era
   presupuesto para ningún otro token, y el firmante EVM lo hubiera firmado igual,
   porque toma el dominio EIP-712 del `extra` del propio vendedor y firma para un
   token y una red que nunca vio. Por eso `asset-not-budgeted` corre **antes** de los
   techos: a quien llama hay que decirle "presupuestá ese activo", no "subí un techo
   que no existe".
5. **El nombre de red no decide por su caja.** `'Base'` y `'base'` son una red
   escrita de dos formas, nunca dos redes: la clave del activo pliega la red a
   minúscula. Dejar la caja adentro falla cerrado (`asset-not-budgeted`, así que
   ningún pago sale mal) pero tropieza al operador con una mayúscula, y la negativa
   apuntaría al presupuesto en vez de al typo. La **dirección** conserva su trato por
   familia.
6. **La dirección se canonicaliza por familia, nunca con `toLowerCase()`.** Hex se
   pliega; base58 (Solana, XRPL) se compara **exacto**. Bajar una dirección base58 no
   produce la misma dirección escrita distinto, produce una cadena que no es una
   dirección: una lista blanca escrita con la grafía del vendedor no coincidiría nunca
   y todo pago legítimo a ese payee se rechazaría. Y en la dirección peligrosa, dos
   direcciones base58 distintas pueden plegarse a la misma minúscula, lo que dejaría
   entrar a una que nadie puso en la lista.
7. **`validUntil` ilegible = ausente, NUNCA cero.** "El vendedor dijo algo que no
   pudimos leer" no puede convertirse en "esta oferta venció en 1970". Un string, un
   float, un negativo o algo más grande que `MAX_SAFE_INTEGER`: todos ausentes.
8. **`validUntil === now` todavía vale**: es el último instante en que la oferta está
   en pie.
9. **Una copia gasta de la misma bolsa.** Un cliente se copia por request; si cada
   copia llevara su propio total, un límite acumulado no significaría nada.
10. **Estado corrupto reporta el TECHO, nunca cero.** Si algo dejó la bolsa en un valor
   que no es un bigint sano, `spent()` devuelve el límite acumulado: para el dinero, la
   dirección segura es negarse, nunca permitir.
11. **Aritmética en `bigint`, nunca `number`.** Las unidades atómicas de un token de 18
    decimales pasan `Number.MAX_SAFE_INTEGER` con 0.01 de token, y un techo comparado
    como float es un techo que redondea. Un monto que no se puede leer se compara como
    el valor más grande representable, así que falla todos los techos en vez de pasar
    como cero.

**Lo que esta versión NO trae** (y el facilitador tampoco, a propósito): verificación
de firma de `offer-receipt` — está el transporte y la vigencia, no la firma ni la
autoridad del firmante, que necesita un modelo de identidad del vendedor que todavía
no existe —, vinculación por input, y contabilidad de `upto`.

Requiere facilitador 2.25.0+ para que el vendedor declare vigencia; sin eso, una
oferta sin `validUntil` simplemente no tiene vencimiento declarado y todo lo demás de
la política funciona igual.

## [2.88.0] - 2026-09-07

**La autoría real de una calificación en Solana: el rater firma, el facilitador
paga.** `submitFeedback()` escribe la calificación con la llave del
**facilitador** en la cuenta 0 — que el programa declara
`[signer, writable] client (feedback author)` —, así que la cadena registra al
facilitador como autor, y el facilitador es el único que puede revocarla. En EVM
eso se arregló con EIP-7702 y un `FeedbackDelegate`. En Solana no hace falta
nada de eso: una transacción lleva varias firmas de forma nativa, así que el
rater firma como `client` y el facilitador se queda de fee payer. El riel ya
está desplegado (facilitador v2.16.0, medido hoy en
`GET /api-docs/openapi.json`); lo que faltaba era el cliente.

### Added

- **`prepareSolanaFeedback()` / `submitSolanaFeedback()`** contra
  `POST /feedback/solana/prepare` y `/submit`. `prepare` no escribe nada y no
  cuesta nada: devuelve la transacción **sin firmar** (base64 del bincode) cuya
  cuenta `client` es el rater, más `feePayer`, `blockhash` y
  `lastValidBlockHeight`. El rater la firma con su llave ed25519 y `submit` la
  co-firma como fee payer y la manda.

  ```ts
  const prep = await erc8004.prepareSolanaFeedback({
    x402Version: 1,
    network: 'solana',
    feedback: { agentId: assetPubkey, rater: raterPubkey, value: 87, score: 95 },
  });
  const tx = Transaction.from(Buffer.from(prep.transaction!, 'base64'));
  tx.partialSign(raterKeypair);
  await erc8004.submitSolanaFeedback({
    x402Version: 1, network: 'solana', feedback: { /* lo mismo */ },
    transaction: tx.serialize({ requireAllSignatures: false }).toString('base64'),
  });
  ```

  Los parámetros de `feedback` **no son redundantes** en `submit`: el
  facilitador re-deriva el mensaje a partir de ellos y del blockhash que viaja
  en la transacción, y se niega a co-firmar cualquier cosa que no sea byte por
  byte la que él armó. Firmar blobs arbitrarios convertiría la llave del fee
  payer en un oráculo de firma público — un solo `system_program::transfer`
  vaciaría la wallet con la firma del facilitador encima.

- **`SOLANA_FEEDBACK_NETWORKS` / `supportsSolanaFeedback()`** — `solana` y
  `solana-devnet`, las dos que el facilitador sirve en vivo.

  **Es una lista propia, y `solana` NUNCA entra a `RELAYED_FEEDBACK_NETWORKS`.**
  Esa otra nombra las cadenas donde hay un `FeedbackDelegate` desplegado y
  verificado on-chain, y es la que arma la URL `/feedback/evm/prepare`: meter
  `solana` ahí manda la calificación a la ruta EVM —400— y además afirma un
  delegate que nunca se desplegó y que no falta. Un test nuevo fija que las dos
  listas no se tocan, y el que ya fijaba la lista de delegates
  (`relayed-feedback.test.ts`) sigue verde sin tocarlo.

- **`PrepareSolanaFeedbackRequest`**, **`PrepareSolanaFeedbackResponse`** y
  **`SubmitSolanaFeedbackRequest`** como tipos de wire.

### Notas

- **Poné `score`.** Es opcional en el wire y el ATOM Engine ignora un feedback
  sin score: la transacción sale bien, el registro queda en el agente, y la
  reputación se queda en cero (`had_impact=false`). No es retroactivo — omitilo
  solo si lo que querés es un registro que a propósito no puntúa.
- `prepare` entrega una ventana, no un permiso permanente: pasado
  `lastValidBlockHeight` la red descarta la transacción, no se escribe ni se
  cobra nada, y reenviar exige un `prepare` nuevo porque el blockhash que el
  rater firmó ya venció.
- `rater` es obligatorio y es una pubkey base58; una dirección `0x` se rechaza
  con 400. Es el punto entero del endpoint.

Requiere facilitador v2.16.0+.

## [2.87.0] - 2026-09-06

**El publisher puede firmar la orden de `release` en su propio browser.** La
2.86.0 dejó una sola forma de firmar — `buildLifecycleAuth`, con un adaptador
inyectado que inventa su propio nonce y su propio deadline —, y esa forma no
sirve para un browser: el publisher firma un documento que el backend ya armó y
devuelve una firma, nada más. Esta versión abre esa costura en dos y prueba que
las dos mitades producen **los mismos bytes**.

### Added

- **`lifecycleAuthFromSignature(typedData, signature, signer)` — la otra mitad.**
  Toma el documento que `buildLifecycleTypedData` devolvió, la firma que la
  wallet dio, y arma el bloque `{ signer, deadline, nonce, signature }` que va
  en `payload.lifecycleAuth`.

  `deadline` y `nonce` **no son parámetros**: se leen de `typedData.message`,
  que es el documento que realmente se hasheó. Tomarlos del llamador dejaría
  que el bloque declare un nonce que la firma nunca comprometió — un
  `bad_signature` que nadie ve, porque las dos mitades se ven bien por
  separado.

  La firma **no se recupera acá**. Los payers de este SDK incluyen cuentas
  delegadas ERC-7702 y wallets de contrato que validan por ERC-1271
  (`src/erc7702.ts:8`), cuyas firmas no hacen `ecrecover` a su dirección:
  `ethers.verifyTypedData` rechazaría justo las buenas. La recuperación —y el
  chequeo de rol que la acompaña— es del facilitador, contra la cadena.

  ```ts
  // backend
  const typedData = buildLifecycleTypedData({
    action: 'release', paymentInfo: pi, payer, amount, chainId: 8453,
  });                                  // deadline -> now + 600, nonce -> 32 bytes frescos
  res.json({ typedData });

  // browser (wagmi / viem)
  const signature = await walletClient.signTypedData({ ...typedData });

  // backend, de vuelta
  const lifecycleAuth = lifecycleAuthFromSignature(typedData, signature, payer);
  await client.releaseViaFacilitator(pi, amount, { lifecycleAuth });
  ```

- **`releaseViaFacilitator` / `refundViaFacilitator` aceptan `{ lifecycleAuth }`**
  ya firmado, como alternativa **excluyente** a `{ lifecycleSigner }`. El bloque
  viaja tal cual: nada se vuelve a derivar ni a "normalizar", porque cualquiera
  de las dos cosas cambiaría bytes que el browser ya comprometió.

  Pasar los dos juntos **lanza**. No es una preferencia que se resuelva por
  precedencia: significa que el llamador cree que van a viajar dos órdenes
  distintas, y solo una puede.

- **`LifecycleTypedData`** exportado como tipo. Es un tipo de **wire**: el
  backend lo arma, lo serializa a JSON y lo manda al browser.

### Changed

- **`buildLifecycleTypedData` es la superficie del browser, y ya no exige
  `deadline` ni `nonce`.** Omitidos, toma los mismos defaults que
  `buildLifecycleAuth` (`now + 600` y 32 bytes frescos), resueltos en **un solo
  lugar** para las dos entradas — así un backend no tiene que escribir su propio
  generador de nonces, que es exactamente el paso donde se reusa uno y el
  facilitador contesta `replayed`.

  Pasarlos explícitos sigue haciendo lo de siempre; el vector de paridad con
  Python los pasa y no se movió un byte.

### Notas para quien integre desde un browser

Tres cosas que el frontend tiene que respetar, o la orden no verifica:

1. El `paymentInfo`, el `payer` y el `amount` firmados tienen que ser **los que
   el backend envía**. Si se recalcula cualquiera de los tres antes del
   `/settle`, es `bad_signature`. Hay un test que lo fija
   (`src/backend/lifecycle-wiring.test.ts`, *an order signed for a DIFFERENT
   amount than the one sent does not recover*).
2. La orden vive **600 segundos**. Armar el documento en el momento de firmar,
   no al pintar la página.
3. Un nonce por orden, y `buildLifecycleTypedData` ya lo genera fresco.

`lifecycleDeadline` se ignora al lado de un `lifecycleAuth`: la orden ya trae
el deadline con el que se firmó, y chequear acá un reloj que no es el que firmó
solo agregaría un rechazo local a algo que el facilitador hoy acepta.

## [2.86.0] - 2026-09-06

**`release` and `refundInEscrow` can now be signed**, so moving money that is
already escrowed stops depending on who happens to be calling. This is the
TypeScript half of the parity with the Python SDK's
[0.78.0](https://github.com/UltravioletaDAO/uvd-x402-sdk-python/pull/12);
byte-for-byte, mirrored rather than reinvented.

### Added

- **`buildLifecycleAuth()` — the EIP-712 order the facilitator verifies.**
  Both lifecycle actions move funds that are ALREADY deposited, so neither
  carries an ERC-3009 signature: there is no transfer left to authorize. That
  left the other half of the question unanswered — *who is entitled to ask for
  the move* — and the de-facto answer was "whoever calls". On 2026-08-30 a
  third party probed exactly that: five calls with a fabricated `paymentInfo`,
  two of them mined, gas spent.

  ```ts
  const auth = await buildLifecycleAuth({
    action: 'release',            // or 'refundInEscrow'
    paymentInfo: pi,              // the SAME object that is sent
    payer: payerAddress,          // payload.payer, NOT inside paymentInfo
    amount: '1000000',            // the SAME as payload.amount
    chainId: 8453,
    wallet: signer,               // injected; the SDK reads no keys
  });
  ```

  The signer is **injected**, never fetched: `EnvKeyAdapter` server-side,
  `OWSWalletAdapter`, a KMS, or `wagmiLifecycleSigner(walletClient)` when the
  PAYER signs in their own browser with the same wallet they paid with and the
  marketplace only transports the block.

- **`releaseViaFacilitator` / `refundViaFacilitator` accept a third argument**,
  `{ lifecycleSigner, lifecycleDeadline }`. **Without it the request goes out
  byte-for-byte as before** — pinned whole in
  `src/backend/lifecycle-wiring.test.ts`, because every caller in production
  today passes no signer.

- **`wagmiLifecycleSigner()`** wraps a wagmi/viem wallet client. It exists
  because a lifecycle domain has **no `verifyingContract`**, so this SDK's
  payment `WalletClient` type — which requires one — cannot sign these orders.

- **`buildLifecycleTypedData()`**, `LIFECYCLE_ORDER_TYPES` and the constants,
  for callers that need the raw document.

### Accepted signers (the facilitator's rule, not this SDK's)

| action | who may sign |
|---|---|
| `release` | the payer; the operator owner (`FEE_RECIPIENT()`) |
| `refundInEscrow` | the receiver; the operator owner; the payer, but only once `authorizationExpiry` has passed |

The receiver may never `release` (self-payment is what escrow exists to stop)
and the payer may never refund early (that is the chargeback). Anything else is
`unauthorized_role`.

### The three traps, each a rejection the caller cannot see

1. **`salt` is `bytes32` on the wire and `uint256` in the signature.** The
   facilitator converts it with `U256::from_be_bytes` (`types.rs:288`). A bare
   hex string without `0x` read as decimal is a different digest and a mute
   `bad_signature` whose only symptom is that no order ever verifies.
2. **The signed `amount` is the amount SENT.** Signing `maxAmount` and
   submitting a partial never verifies — and the partial is the normal case of
   a stream, which emits one order and one nonce per delta.
3. **`deadline` has a 900 s ceiling.** The default signs `now + 600`: signing
   the full 900 lets a facilitator clock five seconds behind decide the verdict
   (`deadline_too_far`).

### Verified

- **Byte parity with Python**, pinned by `src/lifecycle-auth.vectors.json` and
  by phase 8 of the cross-language conformance run, where both runtimes sign
  the same four orders live and the signatures are compared byte to byte —
  and to the vector `lifecycle_auth.rs` fixes. `390 checks across 8 phases`.
- **Against the live facilitator** (`escrowLifecycleAuth: log`): an order
  signed by this SDK logged `verdict="ok" role=payer` at
  `2026-09-06T15:47:17.670Z`. No funds and no gas were involved — base-sepolia
  with a deliberately invalid `tokenCollector`, so the gate runs and logs and
  `validate_addresses` then kills the request before a transaction exists.

## [2.85.0] - 2026-09-05

**XRPL charged in XRP what the integrator wrote in dollars**, and the mainnet
travelled under a name the facilitator publishes nowhere. Both defects are the
ones the Python SDK closed in
[0.77.0](https://github.com/UltravioletaDAO/uvd-x402-sdk-python/pull/11); this
is the TypeScript half of that parity, mirrored rather than reinvented.

### Fixed

- **A price written in USD is refused on a chain that does not settle in
  dollars, instead of being billed in the native asset.**
  `buildPaymentRequirements({ amount: '10.00', chainName: 'xrpl' })` returned
  `maxAmountRequired: '10000000'` — measured — which on XRPL is **10 XRP**, not
  ten dollars.

  The bug is **unit, not scale**, which is why `decimals` never rescued it.
  Scaling a price by the token's decimals turns dollars into base units only
  when one whole unit IS one dollar; that holds for all 23 stablecoin networks
  and fails for a chain settling in its own floating asset. XRP genuinely has
  six decimals — and six decimals of XRP are still XRP.

  The contradiction lived inside this repo: `PaymentInfo.amount` was documented
  as USD while the SDK's own XRPL provider read the same field as whole XRP
  (`xrpToDrops`). The type and its only XRPL consumer disagreed about the unit,
  and the consumer won.

  `TokenConfig.usdPegged` (absent = pegged, so every other network is byte-for-
  byte unchanged) now marks native XRP as unpegged, and the SDK **refuses**
  rather than converting at a rate nobody agreed to. The message names the
  asset, states what the old code would have charged, and points at
  `GET /supported` — refusing without saying where to look only moves the dead
  end one layer up.

  `generatePaymentOptions()` **skips** the unpriceable pair instead of throwing:
  it builds the `accepts` of ONE 402 spanning MANY chains, so failing loudly
  there would cost the seller every chain that was fine. The loud path is
  `buildPaymentRequirements`, which names a single chain.

- **The XRPL mainnet is now `xrpl`, the only spelling the facilitator puts on
  the wire.** It was registered as `xrpl-mainnet`, which the facilitator accepts
  in its `FromStr` and nowhere else, under a comment calling that spelling
  *"right for a lookup and wrong for a wire format"*
  (`x402-rs/src/network.rs:189,251,719`). The SDK was emitting the lookup
  spelling.

  `xrpl-mainnet` **keeps working as an input alias** (new `CHAIN_ALIASES`,
  mirroring the Python SDK's `_NETWORK_ALIASES`) without becoming a second
  network: counts and listings stay at 25.

- **`chainToCAIP2()` no longer manufactures an identifier out of an alias.** It
  resolves through the registry first, so an alias answers with the canonical
  chain's id. Without this the new alias fell into the
  `${networkType}:${name}` fallback and produced `xrpl:xrpl-mainnet` — a string
  no facilitator accepts that nonetheless **passes the colon test every v2 guard
  in this SDK uses**. A fabricated id is worse than a missing one: the missing
  one is refused loudly, the fabricated one ships.

### Added

- **Phase 7 of the cross-language conformance run: the price.** Phases 1-6
  compare how the two SDKs *shape* a request and never once asked what either
  would *charge* — which is how both languages billed `$10.00` as 10 XRP with
  every check green. The run is now **367 checks across 7 phases** (was 347/6),
  and it is discriminating: with the guard removed it reports
  `ts=billed 10000000 py=refused`.

### Not changed, on purpose

- **XRPL still carries no CAIP-2 id, so a v2 body for it is refused rather than
  built.** The facilitator does publish `xrpl:0` / `xrpl:1`
  (`x402-rs/src/network.rs:613`), but the Python SDK deliberately withheld those
  ids and the conformance run compares the two SDKs' envelope decisions live —
  adding them here alone was measured as
  `FAIL ... ts=built py=refused`. XRPL travels on v1, where it now carries the
  correct name. Adding the ids is a coordinated, two-SDK change; see
  `docs/handoffs/2026-09-05-xrpl-cobro-y-nombre-de-red.md`.

## [2.84.0] - 2026-09-05

Three defects found by the first real client audit of this SDK before it picked
a rail (a limousine company integrating x402). All three are upstream-first:
the project reported them, the SDK fixes them, and only then does the project
consume the fix.

### Added

- **`buildUnavailableResponse()` — the no-verdict refusal, without a framework.**
  `verify` returns invalid for two different things: a payment that was
  REJECTED, and a facilitator that never reached a verdict (`retryable`).
  Answering `402` in the second case tells the buyer to sign a NEW
  authorization while the first one is still live and still spendable — **the
  buyer pays twice.** The correct answer is `503` + `Retry-After`, which asks
  for the SAME credential again.

  The SDK already got this right, but only inside two private functions, one
  per framework (`respondUnavailable` for Express, `honoUnavailable` for Hono).
  An integrator writing the handler by hand — Lambda, a Next route, Fastify, a
  bare `Response` — could reach neither, so they re-derived the rule, and
  re-derived it wrong. It is now public, framework-agnostic data, and **both
  built-in middlewares build their reply from it**, so the two can no longer
  drift apart.

  ```ts
  const verifyResult = await client.verify(payment, requirements);
  if (!verifyResult.isValid && verifyResult.retryable) {
    const r = buildUnavailableResponse('Payment verification unavailable', verifyResult);
    return { statusCode: r.status, headers: r.headers, body: JSON.stringify(r.body) };
  }
  ```

  Also exported: the `UnavailableResponse` and `UnavailableBody` types.

- **`X402Client.connect()` now routes SVM chains to the Phantom provider.**
  The registry declares Solana and Fogo as `networkType: 'svm'`, but `connect()`
  switched on `case 'solana'` — a value no chain has ever carried. The branch was
  dead, so Solana fell through to `default:` and the caller got
  `"Unknown network type for chain solana"`, not even that branch's own message.
  `NetworkType` lists **both** `'svm'` and `'solana'`, which is why the compiler
  never flagged it. The provider it should have reached, `SVMProvider`, with
  Phantom detection and gasless USDC transfers, was in the SDK the whole time.

  `disconnect()`, `getBalance()` and `createPayment()` route through the adapter
  too, so a connected SVM wallet is not a dead end. `@solana/web3.js` and
  `@solana/spl-token` stay OPTIONAL peer dependencies: the provider is imported
  lazily, only once an SVM chain is actually requested, so EVM-only consumers
  pay nothing.

- **`MAX_PROTOCOL_FEE_BPS`, `DEFAULT_MIN_FEE_BPS`, `DEFAULT_MAX_FEE_BPS`** are
  exported, and `buildPaymentInfo` accepts `minFeeBps` / `maxFeeBps` overrides.

### Fixed

- **The escrow fee bound had two sources that disagreed, and one of them could
  not open a deposit.** `escrow-preauth.ts` declares `OPERATOR_FEE_BPS = 1300`
  and refuses to sign a bound that cannot cover it; `AdvancedEscrowClient`
  hardcoded `maxFeeBps: 800`. That is not a cheaper fee — `PaymentOperator`
  compares `protocolFee + operatorFee` against the signed ceiling and reverts
  with `FeeBoundsIncompatible` **on the way in**, so against an operator
  charging 13% the escrow never opens and nobody is paid.

  There is now one source, and it is **derived rather than typed**:

  ```ts
  DEFAULT_MAX_FEE_BPS = OPERATOR_FEE_BPS + MAX_PROTOCOL_FEE_BPS  // 1300 + 500
  ```

  500 is `ProtocolFeeConfig.MAX_PROTOCOL_FEE_BPS`, the on-chain hard cap on the
  protocol's slice, read live on Base mainnet. Because the contract compares the
  SUM, that sum is the only bound guaranteed never to revert. `buildPaymentInfo`
  now also throws when an override cannot cover the operator fee — where the
  caller can still react, instead of on-chain after the payer signed.

  **This changes a signed value: `AdvancedEscrowClient`'s default `maxFeeBps`
  goes 800 → 1800.** `maxFeeBps` is a ceiling, so this widens what the payer
  accepts. It is the value this SDK already called canonical, and 800 could not
  transact at all against a 13% operator, but it is a money-path change and is
  called out here on purpose.

### Documented

- **The `operator` addresses in `ESCROW_CONTRACTS` are factories, not
  operators.** Measured 2026-09-05 on Base mainnet, Base Sepolia and Arbitrum:
  they answer `ESCROW()` and `operators(bytes32)` and revert on
  `FEE_CALCULATOR()`, `FEE_RECIPIENT()` and `release(...)` — the exact shape of
  `PaymentOperatorFactory`, which x402-rs `docs/X402R_MULTICHAIN_DEPLOYMENT.md`
  labels them as. A factory has no `release`/`charge`, so the direct on-chain
  paths cannot execute against these addresses as written. Resolve the real
  operator from the marketplace's escrow config and pass it via
  `options.contracts`. **Documented, not fixed** — changing how the operator is
  resolved is a money-path redesign, not a defect fix.

- **The protocol fee is 0 bps today.** Base mainnet `ProtocolFeeConfig`
  `calculator()` is the zero address and no change is queued, so
  `getProtocolFeeBps` returns 0. The operator fee remains per-instance and
  unknowable from the SDK: it is an immutable chosen from
  `OperatorConfig.feeCalculator` when the factory deploys an operator.

- **Ethereum L1's 960s escrow timeout is a product constraint**, not just a
  number: 960s against 90s for every L2. A buyer will not wait sixteen minutes
  in a browser, so human-facing checkouts should offer the L2s. Noted at the
  definition of `ESCROW_TIMEOUT_MS`, where the network is chosen.

## [2.83.0] - 2026-09-05

### Added

- **`generatePaymentOptions()` can offer more than one stablecoin per chain.**
  It emitted `chain.usdc` and nothing else, so a chain the registry knows two
  stablecoins for still produced exactly one option — measured against the
  published 2.81.0 build, `generatePaymentOptions([base], '5')` returned 1
  entry while `base.tokens` listed `['usdc', 'eurc']`. tumblrfi calls it from
  `tokens.ts` and `x402.ts` believing it is multi-token; it never was.

  ```ts
  // Dollars only — the default, and byte-for-byte what it did before.
  generatePaymentOptions([base], '5.00');

  // Dollars or euros, both genuinely accepted.
  generatePaymentOptions([base], '5.00', undefined, ['usdc', 'eurc']);
  ```

  **The new `tokens` parameter is opt-in, and that is a money decision.** The
  obvious fix — emit every token the registry knows — is a regression, not a
  fix: this array becomes the `accepts` of a `402`, so every entry is a
  currency the seller has publicly agreed to be paid in, at `amount` units of
  it. A seller who priced in dollars and silently started accepting `5` EURC
  would be selling at a 1:1 EUR/USD rate nobody agreed to. So the caller names
  the tokens it accepts, `amount` is read as units of each named token with no
  conversion between them, and the default stays `['usdc']`.

  Each token is priced in **its own** decimals rather than the chain's USDC
  decimals — the same distinction that matters on BSC, where USDC has 18.
  A named token a chain does not have is skipped rather than invented.

  Verified unchanged for existing callers: over the 25 x402-enabled chains the
  default still returns 25 options, all USDC.

## [2.82.0] - 2026-09-05

### Added

- **`X402Client.fetch()` — the buyer loop.** This client could sign a payment
  and never ask for one. The half that was missing is the one every consumer
  in the stack wrote by hand: probe the URL, read the `402`, pick an offer,
  sign, retry with the header. Python shipped it first (`client.fetch`); this
  is the TypeScript side of that parity.

  ```ts
  await client.connectWithPrivateKey(key, 'base');
  const res = await client.fetch('https://api.example.com/data', {
    maxAmount: '0.05',
  });
  ```

  **`maxAmount` is a hard ceiling, and that is the point.** Each hand-rolled
  copy of this loop invented its own answer to "how much is too much", and the
  cheapest answer to write is *none*. A `402` asking for more than the ceiling
  throws `PAYMENT_EXCEEDS_MAX` and signs nothing — the probe happened, the
  paid retry did not. Omitting `maxAmount` means paying whatever is asked,
  which is only safe for a resource you already trust.

  What the loop handles:

  - **Both `402` dialects.** v1 spells the price `maxAmountRequired` and names
    the chain `base`; v2 spells it `amount` and names it `eip155:8453`. A buyer
    that learned one dialect silently ignores half the offers. The non-spec
    shape, where a lone requirement sits at the top level with no `accepts`
    array, is read too.
  - **The version the resource asked for.** `x402Version: 'auto'` was the
    documented default and detected nothing — every header came out v1. The
    version is now read off the challenge and carried down through
    `PaymentInfo.x402Version`, so a v2 resource gets a v2 envelope. A v2 retry
    carries the payload under **both** `X-PAYMENT` and `PAYMENT-SIGNATURE`
    (identical base64), so the caller never has to guess which name the
    resource implemented.
  - **Decimals per chain when comparing offers.** BSC USDC has 18 decimals and
    everyone else's has 6. Reading every atomic price at 6 makes a BSC offer
    look 10^12 times cheaper than it is, and the "cheapest" offer is chosen
    wrong. Each offer is read at its own token's decimals and compared at a
    common scale with `BigInt`, so the comparison is exact rather than
    floating-point.
  - **Chain switching.** The chosen offer's chain is switched to before signing.
  - **Passthrough.** A non-`402` response — a first-try `200`, a `500`, a `404`
    — is returned untouched and unsigned. This pays only when payment is what
    was asked for.

  New: `X402FetchOptions` (with `select` to override the cheapest-offer
  default, and `fetchImpl` to inject a `fetch`), `X402PaymentOffer` (a
  normalised offer), the `PaymentExceedsMax` / `NoAcceptablePayment` error
  codes, and `PaymentInfo.x402Version`. All additive; no existing call changes
  shape.

## [2.81.0] - 2026-09-05

### Reconstructed

- `9a4c9f8` feat(react): NetworkPicker y PaymentMethodPicker, con entrypoint sin firma (2.81.0)
- `8d0d56a` docs(react): disenar un carrusel de pago compartido para todo el stack

## [2.80.0] - 2026-09-04

### Fixed

- **A `502 settlement_unconfirmed` is no longer retried — retrying it charged
  the buyer twice.** The facilitator now answers, when a settle is broadcast and
  no receipt ever arrives:

      502 {"error":"settlement_unconfirmed","transaction":"0x...",
           "paymentId":"0x...","retryable":false}

  The transaction MAY BE MINED. Retrying signs a **new** authorization with a
  **fresh nonce**, which the chain accepts as a second, perfectly valid payment
  for the same purchase — EIP-3009's `authorizationState` does not stop it,
  because the second authorization is genuinely new.

  The SDK was being reasonable: until now the only `502` on `/settle` was
  `upstream_rpc_unavailable`, which carries `Retry-After: 30` and where nothing
  was ever broadcast. Both are `502`. **The status cannot tell them apart, so
  this SDK now branches on the body.**

  Two places decided retries by status, and both are fixed:

  - `readFacilitatorError` — the source of the `retryable` flag that
    `failureFields` copies onto every response. From there it reached the
    Express and Hono middleware, which answered **503 + `Retry-After`**: a
    literal instruction to the buyer to send the payment again.
  - `Erc8004LookupError.retryable` — `POST /register` goes through the same EVM
    `send_transaction_from` as a settle, so a mint can come back unconfirmed
    too, and re-POSTing one that may already have landed is the sequence that
    minted five duplicate agents.

  An explicit `retryable: false` in a facilitator body now wins over the status.
  It only ever **downgrades**: a body claiming `retryable: true` on a `402` will
  not make this SDK resend a credential the facilitator genuinely refused.

  **The other `502` is untouched** — still retryable, still with its wait
  clamped to 15s, still answered as `503` + `Retry-After` by the middleware.

### Added

- **`transaction`, `paymentId` and `errorCode` on every facilitator failure.**
  An error that says "do not retry" and hands back nothing to look up rebuilds
  the same dead end one layer up. They now travel on `FacilitatorFailureFields`
  — so on `SettleResponse`, `VerifyResponse`, the gasless escrow calls and every
  ERC-8004 write — and as getters on `Erc8004LookupError`. The middleware
  repeats them in its `500`, **without** a `Retry-After`, because "stop" is the
  correct instruction when the transfer may be mining.

  The hash is passed through **verbatim**: Algorand prints base32 and Solana
  base58, and reformatting it makes it unpasteable in an explorer — which is the
  entire remedy on offer. `paymentId` is the same id a successful settle would
  have printed, so a payment later found confirmed reconciles cleanly.

- **Adopted from the Python SDK: any 5xx carrying a transaction hash is not
  retryable.** `uvd-x402-sdk` (PyPI) has had this as its anti-double-settle
  guard in `_is_retryable_settle_error` — *"a 5xx whose body already contains a
  transaction hash is NOT retryable"* — while this SDK had only the status to go
  on. It is the general form of the rule above: a hash in a **failure** body
  means the facilitator got as far as broadcasting, whatever it called the
  error, so it holds for codes that do not exist yet.

  It is kept **alongside** the named code and the explicit flag rather than
  replacing them — a facilitator that answers `retryable: false` with no hash
  must still be obeyed — giving three independent reasons to stop.

  The error path also now reads all five spellings the facilitator uses for a
  hash (`transaction`, `transaction.hash`, `txHash`, `tx_hash`,
  `transaction_hash`), matching what `settle()` already did on the success path.

- **`SETTLEMENT_UNCONFIRMED`, `isSettlementUnconfirmed()` and
  `parseFacilitatorErrorBody()`**, exported from the package root.

  ```typescript
  if (!result.success && isSettlementUnconfirmed(result)) {
    await reconcileOnChain(result.transaction);   // never re-send
  }
  ```

  Shapes pinned from x402-rs `SettlementUnconfirmedResponse` (`src/types.rs`),
  built in the `IntoResponse` of `FacilitatorLocalError` (`src/handlers.rs`).

## [2.79.0] - 2026-09-04

### Fixed

- **The top-level `x402Version` now names the ENVELOPE, not the payer.**
  `buildVerifyRequest` / `buildSettleRequest` copied
  `paymentHeader.x402Version` into the top level of the **v1** envelope, so a
  buyer who declared `2` -- legal, and what this SDK's own 402 invites as soon
  as it advertises CAIP-2 -- produced a body saying `2` around a
  `paymentRequirements`, which is the v1 shape.

  It was served correctly then and still is: the facilitator's envelope enum is
  untagged and matches on shape. But the facilitator already reads that marker
  for one thing -- picking the hint in its `400`:

  > `This body declares \`x402Version: 2\`. x402 v2 is a JSON object with
  > \`paymentPayload\`, \`resource\` and \`accepted\`...`

  So the first time such a body failed for an unrelated reason, the diagnosis
  sent the integrator to fix the wrong shape. Being sent to the fields when the
  wrapper is what is wrong is the inversion that cost two teams a day.

  The payer's own marker is untouched: it stays in `paymentPayload.x402Version`,
  where it describes the payment rather than the envelope carrying it.

  Found by the Python SDK's cross-SDK comparison (0.74.0): it was the **only**
  body difference left between the two SDKs on the same wire.

- **`'auto'` no longer throws on a v2 payload — the very shape it exists to
  route.** `resolveEnvelopeVersion` read only `paymentHeader.network`. A v1
  header carries one at the top level; a **v2 payload carries none at all**
  (`PaymentPayloadV2` has no top-level network — v2 moved the chain id into
  `accepted`). So on a real v2 payload the default threw

      TypeError: Cannot read properties of undefined (reading 'includes')

  before deciding anything. It now reads the network wherever the payload keeps
  it — top level, else `accepted.network` — and treats a missing one as "no
  CAIP-2 evidence" rather than as a crash. The parameter widens to
  `X402Header | PaymentPayloadV2`, which is what it actually receives.

  Measured in runtime against 2.78.0 by MeshRelay, whose turnstile and multibrain
  pin `x402Version` explicitly to work around it: our own default was the one
  option nobody could use.

- **A network with no CAIP-2 form now refuses the v2 envelope instead of
  emitting a body the facilitator rejects.** `toPaymentRequirementsV2` returned
  `network: 'xrpl-mainnet'` inside a v2 body: `chainToCAIP2` answers with the
  name unchanged for a chain it does not know, and XRPL maps to *itself* on
  purpose -- its v1 string IS its network id. A plain name inside a v2 body is a
  measured `400`, and the doc comment three lines above said so. It now throws,
  naming the network and the escape (`x402Version: 1`), which the facilitator's
  `data did not match any variant of untagged enum` does not.

  Only reachable by **pinning** version 2 on such a network; `auto` leaves them
  on v1, where they work. Found by phase 6 of the cross-language conformance
  run, below.

### Changed

- **`resolveEnvelopeVersion`'s measured table was out of date and is corrected.**
  It published three rows as a hard `400` (`unknown variant \`eip155:8453\``),
  measured 2026-09-03, and built the rule's justification on them: "every CAIP-2
  combination is already a 400, so upgrading them cannot regress anyone". The
  facilitator has since taught the v1 envelope to read CAIP-2. Re-measured
  2026-09-04 against production: all five rows are understood.

  The rule is unchanged — still CAIP-2, still ignoring the marker — but the
  comment now carries the three reasons that actually hold it up, and the note
  that with a fabricated signature the HTTP status discriminates nothing
  (`invalid_request_body` vs `contract_call_failed` is what does). No behaviour
  change.

- **`VerifyRequest.x402Version` and `SettleRequest.x402Version` are typed `1`,
  not `X402Version`.** These interfaces *are* the v1 envelope
  (`VerifyRequestV2` is the other one), so a `2` there was always an
  uninhabitable value -- and typing it `1 | 2` is what let the payer's marker be
  copied in. If you were building one of these by hand from a `1 | 2` variable,
  write `1`, or call `buildVerifyRequestForVersion` and let it choose.

### Added

- **Phase 6 of the cross-language conformance run (`npm run test:xlang`): the
  request envelope.** The run that exists to keep the two SDKs from diverging
  passed with 266 checks while never mentioning the envelope in any of its three
  files -- and the envelope is where they actually diverged. Both SDKs now
  choose and build the `/verify` and `/settle` bodies for 12 wires, and the
  driver compares the chosen version and both bodies key for key, plus a shape
  rule of its own so that two SDKs agreeing on a self-contradictory body still
  fails. 266 -> 333 checks.

  Requires the Python SDK at **0.74.0+** (`uvd_x402_sdk.envelope`); an older
  checkout fails with the fix named rather than skipping.

## [2.78.0] - 2026-09-03

### Added

- **`FacilitatorClient` picks the payment envelope instead of always sending
  v1.** The v2 builders have been in this file since v2.44.0
  (`buildVerifyRequestV2` / `buildSettleRequestV2`, shape verified against
  production on 2026-07-29 and re-verified on 2026-09-03 — still exactly what it
  accepts). Nothing could reach them: `verify()` and `settle()`
  called the v1 builder unconditionally, and those two methods are what
  `createPaymentMiddleware`, `createHonoMiddleware`, `verifyAndSettle` and every
  seller integration go through. So the SDK could *describe* v2 and could not
  *speak* it, and each consumer had to hand-port the v2 body. MeshRelay was
  copying it out of its own Turnstile service when this was written; that is the
  signal the defect was ours, not theirs.

  This is not a corner case, because **this SDK advertises v2 on its own**:
  `createHonoMiddleware` calls `resolveAdvertisedVersion`, which returns 2 as
  soon as there are two accepts or any accept carries a CAIP-2 id, and the 402
  then goes out saying `x402Version: 2` with `network: eip155:8453`. A buyer who
  did exactly what that 402 said got a `400` back. The seller's own paywall was
  unpayable and neither side could see why: the facilitator's envelope enum is
  untagged, so the refusal is `data did not match any variant of untagged enum
  VerifyRequestEnvelope`, which names no field.

  The SDK's own suite had this pinned as correct —
  `src/backend/index.test.ts` asserted the verify body carried
  `paymentRequirements.network === 'eip155:1'`. Measured against production on
  2026-09-03, that exact body is a `400`. A stubbed `fetch` never noticed.

- **`resolveEnvelopeVersion`, `buildVerifyRequestForVersion`,
  `buildSettleRequestForVersion`, `toResourceInfoV2`, `toPaymentRequirementsV2`.**
  The conversion from the v1-shaped `PaymentRequirements` every part of this SDK
  already builds into v2's `{resource, accepted}` pair. This is what "the
  consumer writes no code" means in practice: they keep passing the
  `PaymentRequirements` they have.

  Three renames do the damage, and the facilitator reports none of them by name:
  `maxAmountRequired` becomes `amount`; `network` must be CAIP-2; and
  `resource`/`description`/`mimeType` move out into a `resource` OBJECT — all
  three keys required, a bare URL string is a `400`. `extra` is carried through,
  because that is where the EIP-712 domain lives for tokens the facilitator does
  not know by address (EURC, the bridged USDCs); dropping it makes them
  unpayable.

### Changed

- **`FacilitatorClientOptions.x402Version`** — `1`, `2` or `'auto'`
  (default). The version is chosen, never imposed: a pin is honoured even when
  it contradicts the wire.

  **`'auto'` keys off CAIP-2, NOT off `paymentHeader.x402Version`**, and that is
  a measured decision, not a stylistic one. The facilitator matches on SHAPE and
  ignores the version marker. Measured against
  `https://facilitator.ultravioletadao.xyz/verify` on 2026-09-03
  (facilitator 2.10.0), v1 envelope:

  | payload network | requirements network | today |
  |---|---|---|
  | `base` | `base` | **200** |
  | `base`, header marker says `x402Version: 2` | `base` | **200** |
  | `eip155:8453` | `base` | 400 |
  | `base` | `eip155:8453` | 400 |
  | `eip155:8453` | `eip155:8453` | 400 (`unknown variant \`eip155:8453\``) |

  A header that merely *declares* version 2 while carrying plain names is being
  served correctly today, so upgrading it on the strength of the marker would
  change a call that works. Every CAIP-2 combination is already a hard `400`, so
  switching those to v2 cannot regress anyone — it can only turn a failure into
  a payment. That is the whole safety argument for making this a minor rather
  than a major: **no request that succeeds today changes shape.**

  XRPL stays on v1 by the same rule and correctly so — `xrpl-mainnet` has no
  CAIP-2 form, its v1 string is its network id.

- `buildVerifyRequest` / `buildSettleRequest` are untouched and still emit v1
  with their exact existing return types. Widening them to a union would have
  broken every TypeScript consumer for no gain; the version-aware builders are
  additive instead.

## [2.77.0] - 2026-09-01

### Reconstructed

- `5e68152` docs(dx402): el backend que devuelve el facilitador es el medido, no el declarado

## [2.76.0] - 2026-08-31

### Fixed

- **A `503` from the facilitator was reported as a rejected payment, which makes
  the buyer pay twice.** `402` and `503` say opposite things: `402` is "the
  payment was REFUSED, sign a new authorization", `503` is "no verdict was
  reached, resend the SAME credential". Every facilitator edge in this SDK
  flattened both into `success: false` plus an English sentence — so a caller
  could not tell them apart, and the correct-looking reaction to the sentence
  ("ask the buyer to sign again") charges them a second time for money that was
  never refused. The first authorization stays perfectly spendable.

  This is not hypothetical. Between 2026-08-29 and 2026-08-31 the facilitator's
  `min_capacity` went 1 -> 2 and autoscaled to 3, and refusing rather than
  forwarding turned the EVM writer lease into a permanent two-in-three failure
  rate: **582 settle-path and 132 ERC-8004 rejections in a single six-hour
  window**, every one of them a `503` with a valid signature behind it.

  Every response type now carries `status`, `reason`, `retryable`,
  `retryAfterSeconds` and `safeToReplay`: `VerifyResponse`, `SettleResponse`,
  `verifyAndSettle`, `FeedbackResponse`, `RegisterAgentResponse`,
  `AdvancedTransactionResult`. `Erc8004LookupError` exposes the same as getters
  and its `retryable` now covers `429`/`502`/`504` alongside `503`.

- **`refundViaFacilitator` had no non-2xx branch at all.** It called
  `response.json()` straight through, so a `503` body parsed cleanly,
  `result.success` came back `undefined`, and a refund the facilitator never
  attempted was reported as failed — an escrow declared lost while every token
  was still in it. It now reports the refusal and, like `releaseViaFacilitator`,
  names the status when the body carries no reason.

- **The claim that only the payer can recover an expired escrow is false, and it
  is in this repo three times.** `AuthCaptureEscrow.partialVoid` is
  `onlySender(paymentInfo.operator)` — the operator is the **facilitator** — it
  sends the tokens **to the payer**, and it **never reads
  `authorizationExpiry`**. `reclaim` is the payer-only, post-expiry path, which
  is why the facilitator does not expose it — not the only exit. So a release
  that reverted with `AfterAuthorizationExpiry` is recoverable through
  `refundViaFacilitator` with no gas and no payer, and the belief that it was
  not is why stuck escrows were written off. Corrected in `buildPaymentInfo`, in
  `escrow-release-window.test.ts`, and documented in the README with the
  `queryEscrowState` -> `capturableAmount` recipe.

### Added

- **`upload`: bring your own storage for DX402 anchors.** The facilitator has
  accepted two anchor shapes since v0.1 — `sealed` (the ciphertext rides in the
  request and it hosts the blob) and `pointer` (the seller stored it and sends
  only the locator). Both SDKs implemented only the first, so an integrator
  could not use their own storage at all and their body had to fit inside an
  anchor request.

  `upload` is a **callable, not a precomputed pointer**, for the same reason
  `sign` is one: the SDK must seal first — the buyer has to be able to decrypt —
  and only then is there anything to upload.

  ```ts
  await anchorEvidence(body, {
    ...opts,
    upload: async (sealed) => {        // the SEALED bytes, never the plaintext
      await myBucket.put(key, sealed);
      return `s3+https://cdn.example.com/${key}`;
    },
  });
  ```

  The request then carries only the pointer, so the request-size bound does not
  apply to the body. Three properties are load-bearing:

  - **Sealing still happens.** The buyer decrypts with the key they paid with.
  - **The signature covers YOUR pointer.** The facilitator verifies against
    `req.pointer` when present and `""` when absent, so `anchorEvidence` signs
    the pointer it sent. Signing `""` next to a real pointer throws nothing and
    leaves the anchor permanently *provisional* — the state anyone can supersede.
    `sellerDigestFor` takes the pointer as an optional fifth argument.
  - **A failed upload is a skip, never a failed sale.** A throw or an empty
    pointer yields `skipped: 'anchor_failed'` with `stage: 'upload'`.

  `backend` is inferred from the pointer scheme (`ipfs://`, `ar://`, otherwise
  `s3`) and can be set explicitly.

- **Bounded, opt-out automatic retry.** A refusal the facilitator *proved* it did
  not execute is replayed with the identical request — no re-signing, ever.
  `retries` (default 2 extra attempts, `0` disables) on `FacilitatorClient`,
  `Erc8004Client`, `AdvancedEscrowClient` and both middlewares.

  The five writer-lease reasons do **not** share retry semantics, which is the
  whole point of surfacing them:

  | `reason` | did the write run? | replayed? |
  |---|---|---|
  | `holder_unknown` | no | yes |
  | `forwarding_disabled` | no | yes |
  | `forwarded_but_not_writer` | no | yes |
  | `body_unreadable` | no | yes |
  | `forward_failed` | **maybe** | **never** |

  `forward_failed` is emitted *after* the write was handed to the lease holder,
  so it is a timeout wearing a status code. It is never replayed at any setting;
  resolve it by reading state (`getIdentityByOwner`, honouring its 404-vs-503
  distinction, or `getRegisterStatus`). Re-POSTing an ambiguous mint is what once
  created five duplicate agents.

- New exports: `readFacilitatorError`, `facilitatorFetch`,
  `isReplayableLeaseReason`, `isAmbiguousLeaseReason`, `parseRetryAfterSeconds`,
  `WRITER_LEASE_REASONS`, `REPLAYABLE_LEASE_REASONS`,
  `AMBIGUOUS_LEASE_REASONS`, `MAX_RETRY_AFTER_SECONDS`,
  `DEFAULT_RETRY_AFTER_SECONDS`, `DEFAULT_FACILITATOR_RETRIES`, and the types
  `FacilitatorErrorInfo`, `FacilitatorFailureFields`, `FacilitatorFetchOptions`,
  `WriterLeaseReason`.

### Changed — behaviour, not signatures

Nothing public was removed or renamed; every new field and option is optional.
Two behaviours did move, deliberately:

- **The middlewares answer `503` + `Retry-After` where they previously answered
  `402` (verify) or `500` (settle)** — but only when the facilitator reached no
  verdict. A genuine rejection is still `402`, and a genuine settlement failure
  is still `500`. A client that treated the old `402` as "sign again" was being
  told to double-charge.
- **`verify()` and `settle()` may now make up to two extra attempts**, adding
  latency on a facilitator that is refusing. `Retry-After` is honoured only up to
  `MAX_RETRY_AFTER_SECONDS` (15) — a misconfigured `Retry-After: 3600` would
  otherwise hang the caller for an hour inside a function documented as
  returning promptly. Pass `retries: 0` for the old timing.

## [2.75.0] - 2026-08-28

### Reconstructed

- `68542f0` chore: bump version to 2.75.0
- 133 commits reach this tag from `v2.74.0`, which is not its ancestor. Read the range with `git log --oneline v2.74.0..v2.75.0`.

## [2.74.0] - 2026-08-25

### Reconstructed

- `e5805a2` feat(erc8004): rail de respuestas con autoria real (v2.74.0)

## [2.73.0] - 2026-08-25

### Reconstructed

- `83b3949` feat(erc8004): typedData para delegates v4 (v2.73.0)

## [2.72.0] - 2026-08-25

### Added

- **EIP-7702 delegated accounts: `src/erc7702.ts`.** Python has known since
  0.6x which signing dialect a delegated payer needs; TypeScript had nothing.
  That gap stopped being theoretical the moment the facilitator's rater-authored
  feedback rail went live: **an account that rates gets delegated to Execution
  Market's `FeedbackDelegate`**, and from then on it is a smart account for every
  future payment.

  Exports `delegateTarget`, `needsAccountWrap`, `resolveDelegation`,
  `isDelegated`, `rpcDelegationResolver`, `wrapSignature`, `replaySafeTypedData`,
  `SMA_WRAP_TARGETS`.

- **`buildEscrowPreAuth` takes an optional `delegationResolver`.** With one, it
  picks the signing dialect from the delegate TARGET:

  | payer | signature |
  |---|---|
  | plain EOA | ordinary EIP-712 |
  | delegated to an Alchemy SMA | replay-safe hash + account envelope |
  | delegated to `FeedbackDelegate` (or any plain-1271 delegate) | ordinary EIP-712 |
  | delegation UNKNOWN, resolver supplied | **throws** |

  Without a resolver the behaviour is unchanged, so this breaks nobody.

### Why it matters

"Delegated" is not one signature scheme, and both mistakes are silent until the
payment fails on-chain:

- Signing **raw** for an Alchemy SMA reverts `0x151d90fe`. Measured: 14 of 14
  delegated payers failed their escrow lock (2026-07-31).
- **Wrapping** for a delegate that validates plain ECDSA is just as
  unsettleable — and `FeedbackDelegate` is exactly that. Applying the wrap to
  "any delegated account" means *the act of rating breaks the rater's next
  payment*. Found by Karma Kadabra and fixed in the Python SDK 0.67.0; this is
  the TypeScript half.

An UNKNOWN delegation is **not** "not delegated". `resolveDelegation` returns
`null` for an unreadable chain and `buildEscrowPreAuth` refuses rather than
guessing: collapsing the two is how the original bug survived eight days.

Vectors in `erc7702.test.ts` are generated by the Python SDK, not by this port —
a port compared only against itself proves nothing.

## [2.71.0] - 2026-08-25

### Fixed

- **The signing instructions in 2.70.0 were wrong, and no wallet signature could
  ever have worked.**

  `prepareRelayedFeedback()` returns a `digest` that ALREADY carries the EIP-191
  envelope — the facilitator recovers against it as a prehash, adding nothing.
  This README and these docstrings told you to `signMessage(prep.digest)`.
  `signMessage` / `personal_sign` applies the envelope itself, so the value got
  wrapped **twice** and recovered an address that was not the rater.

  The failure is silent by construction: the signature is well-formed, the
  request is well-formed, and the facilitator answers `relay_bad_signature` —
  which reads like the rater signed the wrong content, not like the client
  wrapped it twice. Measured against production on 2026-08-25: signing the
  digest recovered `0x98C5…7c97` for a rater whose address was `0x0B35…DcA5`.

  Found by Karma Kadabra reading the code before emitting anything, and
  confirmed independently on our side. Every wallet surface across three
  projects had the same bug.

### Added

- **`signingPayload` on `PrepareRelayFeedbackResponse`** — the same hash with the
  envelope still off. This is what a wallet signs:

  | how you sign | what you sign |
  |---|---|
  | raw key (prehash) | `digest` |
  | wallet `personal_sign` | `signingPayload` |
  | ✗ `personal_sign(digest)` | recovers a stranger |

  `keccak256('\x19Ethereum Signed Message:\n32' || signingPayload) === digest`,
  so a client can check the two against each other rather than rebuilding the
  preimage from `data`.

  Served by the facilitator from **v1.95.0**. Older facilitators omit it and the
  field is `undefined` — fail loudly rather than falling back to signing
  `digest` through a wallet, which is the broken path.

Requires facilitator v1.95.0+ for `signingPayload`. Raw-key signers were never
affected and need no change.

## [2.70.0] - 2026-08-23

### Added

- **`prepareRelayedFeedback()` + `submitRelayedFeedback()`: ratings the CHAIN
  attributes to the rater, not to the facilitator.**

  The ERC-8004 Reputation Registry records `msg.sender` as the author and the
  deployed implementation has no delegation path -- no
  `giveFeedbackWithSignature`, no ERC-2771 forwarder. So every rating relayed
  through `submitFeedback()` is a rating authored by the FACILITATOR. That is
  not a theoretical concern: 87,2% of the reputation on Base (1.384 of 1.587
  feedbacks) is attributed to one wallet, and the same wallet can revoke any of
  it.

  EIP-7702 closes it without touching the registry: the rater delegates their
  own EOA to a `FeedbackDelegate` and the transaction is sent TO THE RATER'S
  ADDRESS, so the registry sees the rater while the facilitator still pays the
  gas. `prepare` hands back the digest, deadline, single-use nonce and -- when
  the account is not delegated yet -- the account nonce for the EIP-7702
  authorization. `submit` relays it.

  The feedback parameters are repeated on `submit` on purpose: the facilitator
  rebuilds the registry calldata from them and requires the rater's signature to
  cover exactly that. It does not relay calldata it was handed.

- **`RELAYED_FEEDBACK_NETWORKS` + `supportsRelayedFeedback()`** so a caller can
  route without paying a round trip for a 400. Nine networks: the eight mainnets
  Execution Market deployed a delegate on (base, ethereum, polygon, arbitrum,
  optimism, celo, bsc, monad) plus base-sepolia. It is a routing hint -- the
  facilitator re-checks the delegate on-chain on every request.

  `avalanche` is absent and is not waiting to join: its C-Chain rejects the
  transaction type itself (`-32000 transaction type not supported`), so there is
  nothing to deploy against. Anchor the rating on a chain that supports
  EIP-7702; the payment stays where it was made.

### Deprecated

- **`submitFeedback()`** where a delegate exists. It still works and is not
  going away without notice -- it is the only route available where no delegate
  is deployed -- but on those nine networks it writes the facilitator's address
  into somebody else's reputation.

Requires facilitator v1.93.0 or later for the mainnet networks; base-sepolia has
served this rail since v1.74.0.

## [2.69.0] - 2026-08-22

### Reconstructed

- `bd22a5a` fix(escrow): paridad con Python — el ultimo recurso del settle nombra algo (v2.69.0)

## [2.68.0] - 2026-08-21

### Reconstructed

- `9273275` feat(erc8004): scroll, el ValidationRegistry de mainnet, y 'base-mainnet' que el facilitador nunca acepto (v2.68.0)
- `b16f3b7` fix(settle): el veredicto lo da el facilitador, no el codigo HTTP (v2.67.0)

## [2.67.0] - 2026-08-20

### Fixed

- **`settle()` reported success whenever the HTTP call succeeded.** The returned
  object carried the literal `success: true`, so the facilitator's own verdict
  was never read — even though the line above it already consulted
  `result.success` for a warning.

  "The request arrived" is not "the money moved", and the gap is not
  hypothetical: a transfer that mines and then REVERTS is answered with HTTP 200
  and `success: false` (x402-rs `src/chain/evm.rs:1343`, serialised through
  `StatusCode::OK`). Every consumer written as `result.success === true` was
  therefore reading a constant, so a reverted payment was booked as settled and
  the reconciliation paths built to catch exactly that could never fire.

  Now `success: result.success === true`. A response with no `success` field is
  treated as **not** successful: a facilitator that does not say it worked has
  not said it worked.

  Found while adopting DX402 in MeshRelay, where `settle_status: 'settle_failed'`
  turned out to be unreachable in two services.

### Added

- **`errorReason`, `payer` and `proofOfPayment` on `SettleResponse`.** `settle()`
  rebuilt its return value field by field and dropped everything else the
  facilitator sent.

  `proofOfPayment` is the consequential one: `anchorEvidence` documents it as
  *"the only thing that reaches `verified: true`"*, the facilitator returns it
  when the ERC-8004 extension asks for one, and this client threw it away. A
  seller using the SDK end to end could therefore only ever produce
  **provisional** anchors — which a gate-verified anchor can supersede. Read in
  both `camelCase` and `snake_case`.

  `errorReason` is what separates a reverted transfer from a rejected
  authorization without parsing prose. It is distinct from `error`: `error` is
  this client failing to ask, `errorReason` is the facilitator answering no.

## [2.66.0] - 2026-08-20

### Reconstructed

- `320411c` fix(x402): paymentRequirements es la grafia v1 de accepts, y no la reconociamos

## [2.65.0] - 2026-08-20

### Reconstructed

- `b00ffef` feat(x402): paymentChallengeFrom, y detectX402Version deja de mentir con un header

## [2.64.0] - 2026-08-20

### Reconstructed

- `b27006f` docs(dx402): el README no mencionaba DX402 ni una vez
- `b049ba2` feat(dx402): elegir donde se guarda, y preguntar que ofrece el facilitador

## [2.63.0] - 2026-08-19

### Reconstructed

- `94c37ed` fix(escrow): la ventana de release tiene que sobrevivir a la REVISION, no solo al tier

## [2.62.0] - 2026-08-19

### Reconstructed

- `24fb3ba` feat(dx402): poder mandar proofOfPayment, y un header que sobreviva al no-ASCII

## [2.61.0] - 2026-08-19

### Reconstructed

- `a617cde` chore: 2.61.0 -- hex estricto y forma del digest por curva
- `5f34add` fix(dx402): no adivinar la forma del digest -- las testnets firmaban la equivocada
- `69581e3` fix(dx402): hex estricto -- parseInt convertia basura en bytes de clave plausibles

## [2.60.0] - 2026-08-19

### Reconstructed

- `724465e` fix(dx402): cortar por el sobre SELLADO, conservar el diagnostico, y no volar el stack

## [2.59.0] - 2026-08-19

### Reconstructed

- `ae55657` fix(dx402): elegir la forma del digest por la curva del PAYEE — un payee EVM no podia firmar

## [2.58.0] - 2026-08-18

### Reconstructed

- `1d5b6f9` feat(dx402): paridad completa con Python -- v2, Solana y una sola llamada (v2.58.0)

## [2.57.0] - 2026-08-18

### Reconstructed

- `d5fb331` feat(dx402): helper para firmar el anchor y probar que es tuyo (v2.57.0)

## [2.56.0] - 2026-08-17

### Reconstructed

- `d46f8ca` feat(dx402): leer envelopes multi-destinatario (v2.56.0)

## [2.55.0] - 2026-08-17

### Reconstructed

- `2976cf4` feat(dx402): lado VENDEDOR -- sellar desde TypeScript (v2.55.0)
- `0786cb6` feat(dx402): recuperar una respuesta pagada despues de la sesion (v2.54.0)

## [2.53.0] - 2026-08-09

### Added

- **`asyncTransport` on `registerAgent`.** Execution Market migrated to async
  registration, and 2.52.0 made that a breaking change at the call site:
  `registerAgent` returns `RegisterAgentResponse` (with `agentId`),
  `registerAgentAsync` returns `RegisterJobResponse` (without one yet).

  `registerAgent(request, { asyncTransport: true })` changes the transport, not
  the contract: it starts with `Prefer: respond-async`, polls, and returns the
  same `RegisterAgentResponse`. Caller code is unchanged and gains immunity to
  proxy timeouts, because each request is short instead of one held open for the
  whole mint.

- **`RegistrationPendingError`, carrying `jobId` as a field.** What makes the
  above safe rather than merely convenient. A timeout is not a failure — the mint
  may still land — and a caller who cannot reach the job id without parsing a
  string will re-register instead. That is the sequence that once produced five
  duplicate mints. For the same reason the timeout throws rather than resolving
  `success: false`.

## [2.52.1] - 2026-08-09

### Fixed

- **A 409 from `registerAgent` no longer discards the facilitator body.** The
  in-flight lock answers a synchronous register with 409 and a structured
  `RegisterAgentResponse` carrying the agent id and tx of the run ALREADY
  underway, plus a "poll GET /register/status/{jobId}" hint. That was flattened
  into `Facilitator error: 409 - <text>`, leaving the caller with a bare failure
  — precisely the shape that invites a retry, and retrying a mint is how
  duplicate agents get created. The parsed body is returned instead, with
  `success` forced to `false` so a 4xx can never claim otherwise. A 400 now
  surfaces the facilitator's own message; a non-JSON error still degrades to the
  flattened string.

## [2.52.0] - 2026-08-08

### Added

- **Async registration: `registerAgentAsync`, `getRegisterStatus`,
  `waitForRegistration`.** The facilitator has offered this since v1.48.0 and no
  SDK exposed it.

  A synchronous register waits on a mint receipt, which on a congested chain
  outlives client and proxy timeouts. The timed-out call is genuinely ambiguous —
  the mint may well have landed — and retrying it is how five duplicate agents
  once got minted. The async flow hands back a job id instead of a guess.

  `waitForRegistration` rejects on timeout rather than resolving the last
  non-terminal status, so "still pending" is never read as "did not happen", and
  the message says to keep polling rather than re-register.

- **`RegisterJobResponse` / `RegisterJobStatus` / `isRegisterJobTerminal`.**
  `mint_confirmed` already carries an `agentId` but is not terminal.

## [2.51.0] - 2026-08-08

### Added

- **`Erc8004LookupError`, thrown by `getIdentityByOwner` with the status as a
  field.** The facilitator answers 404 for "this address owns no agent" and 503
  for "I could not find out". `notFound` and `retryable` separate them.

  This matters on a registration path: a caller that reads a 503 as absence
  mints a second agent for an owner who already has one, burning gas and leaving
  an orphan. The method used to throw a bare `Error` with the status
  interpolated into the message, so telling the two apart meant parsing a string.

- **Solana support in `getIdentityByOwner`.** Facilitator v1.72.0 answers the
  route for SVM; before that it was EVM-only and returned 400. No SDK shape
  change was needed — verified against the live mainnet response.

## [2.50.0] - 2026-08-07

### Added

- **`score` on `FeedbackParams`.** On Solana the ATOM Engine ignores an unscored
  feedback: it is written to the agent, but contributes nothing to reputation and
  the program reports `had_impact=false`. Not retroactive — reputation stays at
  zero however much unscored feedback accumulates. The facilitator could not send
  it either until v1.70.3, so nobody's Solana reputation was ever being scored.

- **`AtomStats`, exposed on `ReputationResponse.atomStats`.** The facilitator has
  returned this for Solana since v1.70.2; the SDK had no type for it. The engine
  measures quality through EMA scores, so there are no positive/negative tallies:
  the fields are `trustTier`, `qualityScore`, `loyaltyScore`, `confidence`,
  `riskScore`, `diversityRatio`, `min/max/lastScore`, `feedbackCount` and
  `lastFeedbackSlot`.

- **`originalFeedback` on `revokeFeedback`.** Solana revocations need the SEAL
  hash of the feedback being revoked. Pass the original content and the
  facilitator derives it; computing it yourself means reimplementing the
  program's keccak256 layout exactly. `sealHash` still works and wins.

- **`numMinted` and `collection` on `IdentityTotalSupplyResponse`.** On Solana
  the counts come from the Metaplex Core collection, not the registry, which
  keeps no counter: `totalSupply` is the collection's current size (net of
  burns), `numMinted` its all-time count.

- **`immutable` on `IdentityMetadataResponse`.**

### Fixed

- **`IdentityMetadataResponse.valueHex` never existed on the wire.** The
  facilitator sends the hex value as `value`. The field was typed as `valueHex`,
  so it read `undefined` at runtime for every metadata lookup ever made. Renamed
  to `value`.

## [2.49.0] - 2026-08-06

### Added

- **`uvd-x402-sdk/erc8128` — one signer and one verifier for the whole fleet.**
  ERC-8128 signing was copy-pasted across four projects and verification
  existed only as two independent server implementations that had never been
  compared. They had diverged: one rejected the canonical `alg="eip191"`
  parameter every current signer emits, and the two disagreed on how
  `@authority` is derived. This module is the single implementation both
  languages now share, published to npm and PyPI from the same conformance
  vectors.

  - `signRequest` / `verifyRequest`, plus the pure primitives underneath
    (`parseSignatureInput`, `buildSignatureBase`, `canonicalAuthority`).
  - `NonceStore` is pluggable, so a server-issued single-use store and the
    client-chosen first-use model are both expressible.
  - `POLICY_PRESETS` (`meshrelay-strict`, `em-lenient`, `canonical-strict`)
    carry the nonce ordering with them, so adopting a posture cannot silently
    flip it. `canonical-strict` pins the chain — a preset named "strict" that
    accepts any chain is not strict.
  - The verifier never re-serialises `@signature-params`: it takes the
    parameter substring verbatim from the header, so a parameter added to the
    wire tomorrow verifies through the same byte path instead of 401-ing.
  - `@authority` normalisation (lowercase, scheme's default port dropped)
    applies only where the scheme is known. The **configured** policy authority
    is validated but never re-normalised — guessing a scheme for it silently
    breaks `https` on `:80` and `http` on `:443`.
  - Conformance vectors ship **inside** the package and are byte-identical to
    the Python ones; a cross-language test signs in each runtime and verifies in
    the other, and fails loudly rather than skipping when one is absent.

### Fixed

- **A rejected verification no longer reports a `wallet`.** The Python verifier
  returned the address the client wrote into its keyid on the failure path,
  where nothing had checked it against the recovered signer — attacker-supplied
  input in a field named `wallet`, one forgotten `if (!result.ok)` away from
  being treated as an authenticated principal. Both languages now return no
  wallet on any rejection.

## [2.48.0] - 2026-08-03

### Added

- **Token metadata in the EVM payload** (`includeTokenMetadata`): an EIP-3009
  authorization is signed against a token contract, but the encoded payload
  only carried `{signature, authorization}` — a EURC payment and a USDC payment
  on the same chain produced indistinguishable headers, so a resource accepting
  several stablecoins could not rebuild `paymentRequirements` (`asset` +
  the `extra` EIP-712 domain) and the facilitator could not settle. Opt in via
  `EVMProvider.encodePaymentHeader(payload, chain, version, {includeTokenMetadata: true})`
  or `new X402Client({includeTokenMetadata: true})` and the payload carries
  `token: {address, symbol, decimals, eip712:{name, version}}`. Off by default:
  every existing header stays byte-identical. Unknown token addresses throw
  rather than emitting a guess. New `getTokenByAddress` / `buildTokenMetadata`
  resolve an address back to its registry entry.
- **BSC** in the chain registry, `enabled: false` on purpose — Binance-Peg USDC
  does not implement ERC-3009 `transferWithAuthorization`, so the exact scheme
  cannot settle it. The entry exists so its **18 decimals** are on record;
  assuming the usual 6 mis-prices a payment by 12 orders of magnitude.

### Fixed

- **`X402Client.createPayment` always charged USDC**, silently ignoring
  `paymentInfo.tokenType` — it read `chain.usdc` for the EIP-712 domain, the
  decimals and the payload's `token` field, so asking for EURC signed a USDC
  authorization. It now resolves the token through `getTokenConfig`, matching
  what `EVMProvider.signPayment` already did, and throws when the token is not
  supported on the chain.
- **`btoa()` cannot encode the payload of a USDT payment**: the EIP-712 domain
  name of USDT on Optimism, Arbitrum and Monad is `USD₮0` (U+20AE), and
  `btoa()` throws on any code point above 255. Every header the SDK emits now
  goes through a UTF-8 safe encoder (`encodeBase64Json`), and
  `decodeX402Header` reverses it. Byte-identical to the old output for ASCII
  input, so no existing header changes.

## [2.47.0] - 2026-07-31

### Added

- **ERC-8128 signed HTTP requests** (`src/erc8128.ts`): `signRequest`,
  `signRequestWithWallet`, `signRequestWithSigner`, `fetchNonce`, and the
  auto-signing `createSignedFetch` wrapper. Wire format pinned by the F3-1
  golden vectors (`src/erc8128.vectors.json`, byte-equality tests):
  `alg="eip191"` always emitted, keyid always lowercase
  (`erc8128:{chainId}:{address}`), params in the order
  `created;expires;nonce;keyid;alg`, `Content-Digest` sha-256 for bodies.
  `buildSignatureBase` / `buildSignatureParams` are exported so external
  signers can reproduce the exact signed bytes.
- **Escrow pre-auth builder** (`src/escrow-preauth.ts`): `buildEscrowPreAuth`
  signs the sign-on-assignment EIP-3009 `ReceiveWithAuthorization` that locks
  a bounty in the x402r AuthCaptureEscrow and packs it as the raw-JSON
  `X-Payment-Auth` wrapper for the facilitator's `/settle`. The nonce is
  `AuthCaptureEscrow.getHash(paymentInfo)` (payer-zeroed raw keccak — it
  commits to the receiver, exported as `computeEscrowNonce`). Fail-loud
  validation: incomplete network config, unknown tier, bounty above the
  on-chain deposit limit, or `maxFeeBps` below the operator's 1300 bps all
  throw before signing. Byte-parity with the Python SDK
  (`em_plugin_sdk.escrow_signing`) and Execution Market's dashboard/mobile
  suites is pinned by shared golden vectors
  (`src/escrow-preauth.vectors.json`).

### Fixed

- **`FacilitatorClient.settle` discarded the settle transaction hash**: the
  client read `transactionHash` / `transaction_hash`, but the facilitator
  emits the field as `transaction`, so `txHash` came back `undefined` on
  every successful settle. Now all three spellings are read (`transaction`
  first, as the canonical one) and a success response with no hash under any
  spelling logs a warning instead of failing silently.

### CI

- GitHub Actions pinned by commit SHA (`checkout`, `setup-node`) against
  npm supply-chain campaigns. Publishing still uses a long-lived `NPM_TOKEN`
  on purpose — migrating to trusted publishing requires linking the package
  to this repo/workflow from npmjs.com first (documented inline in the
  workflow).
