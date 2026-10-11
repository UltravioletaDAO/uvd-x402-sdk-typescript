# SDKTS-DISC — opcion vendedor `discoverable` (`extra.discoverable`)

## Estado

- Hecho: `withDiscoverable(accept, discoverable = true)` (exportado desde la raiz y
  desde `uvd-x402-sdk/backend`) y la opcion `discoverable?: boolean` de
  `HonoMiddlewareOptions` (y por alias de `FetchPaywallOptions`). Tests en
  `src/backend/discoverable.test.ts`, README y CHANGELOG (Unreleased, sin bump de
  version). Con Node 20 y red cerrada: typecheck, suite completa, lint, build,
  `npm pack --dry-run`, `derive-erc8128-f3-3 --check` y conformidad cruzada TS <-> PY
  en verde. Mutaciones M1..M15 en rojo y revertidas (M12 sobrevivia: se agrego el
  caso `accepts: []` con flag invalido, que la mata).
- Ronda 1 (REF-SDKTS-52): Hedera nativo queda como viene con la opcion; tests de
  lista mixta y de `HEDERA:MAINNET` / `Hedera:Testnet` en `withDiscoverable`.
- Ronda 2 (VER-SDKTS-52): corregida la nota sobre `false` (Python #70 ahora tambien
  escribe `discoverable: false`; omitir no escribe nada) en README y handoff; la lista
  mixta suma una accept Solana y una Stellar que salen marcadas (mata H7: Hedera leido
  como "todo lo que no es EVM").
- Falta: CI del PR y la revision de c0der. Sin merge, deploy ni publish.
- Proximo paso: mirar el CI del PR.

## Medido antes de cambiar (origin/main `6a7a279`)

- Confirmado: `options.extensions` existe y viaja (no se toca). `PaymentAcceptance.extra`
  es `unknown` y era la unica via para `discoverable`: ni una opcion ni un helper.
- Lector del facilitador (`x402-rs` `src/handlers.rs`, settle): lee
  `payment_requirements.extra.discoverable` con `as_bool()` y `unwrap_or(false)`; solo
  el booleano JSON `true` registra el recurso. Un `"true"` string no cuenta, por eso el
  SDK rechaza todo lo que no sea booleano.
- Rojo de base del test nuevo, con solo el archivo de test sobre la base:
  `60 failed | 14 passed (74)` (los 14 verdes son los casos de omision y de inputs
  sin la opcion, que deben comportarse igual que antes).
- Linea base de la suite: 69 archivos, 1707 tests, 0 fallos. Rojos de base: ninguno.

## Que cambia

| Archivo | Cambio |
|---------|--------|
| `src/backend/index.ts` | `withDiscoverable`, `discoverable?: boolean` en `HonoMiddlewareOptions`; `createAcceptsPaymentGate` (comun a Hono y Fetch) copia las accepts con el flag antes de construir nada. |
| `src/index.ts` | re-exporta `withDiscoverable`. |
| `src/backend/discoverable.test.ts` | tests (facilitador doble en 127.0.0.1, `fetch` que rechaza todo host que no sea loopback). |
| `README.md`, `CHANGELOG.md` | documentacion. |

## Decisiones

- Omitido: las accepts salen tal cual, sin validar ni agregar nada (compatibilidad).
- `true`/`false` explicitos pisan un `extra.discoverable` previo.
- Hedera nativo (ronda 1, REF-SDKTS-52 P2-1, paridad con uvd-x402-sdk-python#70): la
  opcion del paywall deja esas accepts como vienen y marca las demas; `withDiscoverable`
  sobre una accept Hedera sigue lanzando. El facilitador solo admite `feePayer` en su
  `extra`, asi que un settle de Hedera no se lista.
- `false` escribe `discoverable: false`, igual que `False` en Python desde
  uvd-x402-sdk-python#70 `94abfee`; omitir la opcion (`None` en Python) no escribe nada.
  Para el facilitador, `false` y la ausencia significan no listar.
- `extra` que no es objeto plano (array, string, null, instancia de clase) se rechaza
  al crear el paywall, antes de cualquier I/O.
