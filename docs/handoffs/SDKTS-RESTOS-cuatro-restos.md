# SDKTS-RESTOS — restos de SDKTS-ESC-02/03 (2.104.1)

## Estado

- Hecho: los cinco arreglos (checksum de Monad, alias `skale` / `skale-testnet`,
  guarda de `payment_info_typehash`, congelado profundo de `VERIFIED_USDC_DOMAINS`
  y `ESCROW_TIER_WINDOWS`, guarda `min_fee_bps <= 1300`), sus tests, version
  2.104.1 y CHANGELOG. Con Node 20: typecheck, 1707 tests, lint, build,
  `npm pack --dry-run` y la conformidad cruzada TS <-> PY en verde. Mutaciones
  M1..M15 en rojo y revertidas. Merge con origin/main: ya estaba al dia (158fdfa).
- Falta: que el CI del PR quede verde y la revision de c0der. Sin merge ni publish.
- Proximo paso: mirar el CI del PR.

## Que cambia

| # | Archivo | Cambio |
|---|---------|--------|
| 1 | `src/escrow-contracts.ts`, `src/fixtures/escrow-operator-snapshot.json` | `ESCROW_CONTRACTS[143].usdc` = `0x754704Bc059F8C67012fEd69BC8A327a5aafb603` (grafia EIP-55 del registro de Execution Market). `tableAddress` ya no pasa a minusculas antes de `getAddress`. |
| 2 | `src/chains/index.ts`, `src/escrow-preauth.ts` | `CHAIN_ALIASES` con `skale` y `skale-testnet`; se borra `ESCROW_NETWORK_ALIASES`, que ya no hace falta. |
| 3 | `src/escrow-preauth.ts`, `src/index.ts` | `ESCROW_PAYMENT_INFO_TYPEHASH` (exportado desde la raiz) y `checkPaymentInfoTypehash`, que corre antes de buscar delegaciones o firmar. |
| 4 | `src/escrow-preauth.ts` | `Object.freeze` en la raiz y en cada fila de las dos tablas. |
| 5 | `src/escrow-preauth.ts` | `minFeeBps > OPERATOR_FEE_BPS` se rechaza (`INVALID_CONFIG`). |

Sin cambios: la regla de la decision 224 (`escrowRows`) y los techos de ESC-03
(`ESCROW_MAX_FEE_BPS`, `ESCROW_TIER_WINDOW_MAX`, `ESCROW_MAX_AUTHORIZATION_SEC`).

## Refutaciones del encargo

- Punto 5 («Python lo tiene»): en `uvd-x402-sdk-python` origin/main (8337849, 0.96.0)
  `build_escrow_pre_auth` NO controla `min_fee_bps`. La guarda
  (`0 <= min_fee_bps <= OPERATOR_FEE_BPS`) esta en la rama
  `0xultravioleta/c0-sdkpy-esc03` (120bdea, 0.97.0), sin mergear. Se porto ese limite.
- El encabezado de CHANGELOG `[2.104.0] - unreleased` no coincide con npm, que ya
  publica 2.104.0. No se toco.

## Mutaciones (todas en rojo, revertidas con `git checkout -- <archivo>`)

| M | Mutacion | Tests en rojo |
|---|----------|---------------|
| M1 | Monad `usdc` con la grafia vieja | 14 (checksum EIP-55 de las tablas, filas de Monad) |
| M2 | snapshot con la grafia vieja | 1 (`escrow-operator-snapshot.test.ts`) |
| M3 | sin alias `skale` | 8 |
| M4 | sin alias `skale-testnet` | 4 |
| M5 | guarda de typehash eliminada | 19 |
| M6 | typehash sin `trim` / minusculas | 3 |
| M7 | nonce con el typehash crudo de la config | 2 |
| M8 | typehash chequeado despues de la delegacion | 8 |
| M9 | `ESCROW_TIER_WINDOWS` raiz sin freeze | 1 |
| M10 | fila `micro` sin freeze | 1 |
| M11 | `VERIFIED_USDC_DOMAINS` raiz sin freeze | 1 |
| M12 | filas de `VERIFIED_USDC_DOMAINS` sin freeze | 1 |
| M13 | guarda `min_fee_bps` eliminada | 16 |
| M14 | `>=` en vez de `>` | 13 |
| M15 | techo 1800 en vez de 1300 | 14 |

Los tests nuevos sobre el `src` de main: 52 en rojo de 416 (cada uno de los cinco arreglos).
