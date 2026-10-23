# SDKTS-BATCH-SETTLEMENT: lado comprador de `batch-settlement` (port del SDK Python)

QUÉ: subruta nueva `uvd-x402-sdk/batch-settlement` (`src/batch-settlement.ts`): el comprador del esquema x402
`batch-settlement` en EVM. Un depósito ERC-3009 (`ReceiveWithAuthorization` al colector canónico + primer
voucher) abre el canal; cada pedido siguiente firma sólo el voucher acumulado. Versión 2.105.0.

POR QUÉ: paridad entre SDKs. El módulo ya existe y está verificado en Python
(`uvd_x402_sdk.batch_settlement`, cruzado byte a byte contra la referencia `x402` 2.25.0); este es el mismo
módulo en TypeScript, con la misma API, las mismas reglas de plata y los mismos vectores de oro.

RIESGO: firma plata. Si el id de canal, el nonce ERC-3009 o el dominio EIP-712 divergen, el vendedor no
abre el canal o rechaza el voucher; si `confirm` copiara el `channelState` del vendedor, un vendedor podría
inflar el acumulado del comprador. Ambos casos tienen test.

## Estado

- Hecho: módulo, tests, registro de la subruta (`package.json` `exports` + `typesVersions`, entrada de
  `tsup.config.ts`), versión 2.105.0 en `package.json` y en las dos entradas de `package-lock.json`,
  CHANGELOG y README (viñeta en Features + sección "Batch Settlement (buyer)").
- Falta: push, PR, refutación y publicación (no son de este worker).

## Qué se verificó

- `src/batch-settlement.test.ts`: 10/10. Los 9 casos del test Python con sus vectores de oro, y los cuatro
  coinciden byte a byte: id de canal, firma del voucher, nonce ERC-3009 del depósito y firma de la
  autorización del depósito (llave derivada en ejecución de `sha256("karmakadabra-batch-settlement-golden")`,
  nunca escrita ni impresa). El décimo fija los bytes del header con un nombre de token no ASCII.
- Suite completa (`npx vitest run`): 75 archivos, 2230 tests pasan, 75 omitidos, 0 fallan.
- `npm run typecheck`, `npm run lint`, `npm run build`: limpios. `tsc -p tsconfig.eslint.json` (incluye
  tests) da 31 errores, todos en tests ajenos; ninguno en los archivos nuevos.
- Artefacto construido: `uvd-x402-sdk/batch-settlement` resuelve por el mapa de `exports` en CJS y ESM; el
  `dist` CJS da el id de canal de oro y `FileChannelStorage` escribe y relee el archivo desde CJS (donde
  `import('node:fs/promises')` se transforma en `require`), sin dejar temporales.

## Decisiones

- Sólo por subruta, no desde la raíz: `FileChannelStorage` usa `node:fs` y la raíz la empaquetan
  navegadores; un bundler web puede negarse a resolver `node:fs` aun en un import dinámico (no se probó
  con un bundler aquí, por eso no se arriesgó la raíz). Además `paymentPayload`, `paymentHeader`,
  `ChannelConfig` y `ZERO_ADDRESS` chocarían con nombres de la raíz.
- `node:fs` se carga en el primer uso de `FileChannelStorage`: la subruta importa en un navegador con
  `MemoryChannelStorage`.
- `ChannelStorage.get/set` pueden devolver promesas (un store en S3 o en base de datos); el cliente las
  espera. Por eso `createPayment` y `confirm` son `async` (la firma ya lo era).
- `paymentHeader` da los bytes de Python: JSON compacto con todo carácter por encima de `~` escrito como
  escape JSON (`json.dumps` con `ensure_ascii`). El resto del SDK TS usa `encodeBase64Json` (UTF-8 crudo);
  aquí manda la paridad con Python. El JSON decodificado es el mismo en ambos casos.
- Montos en `bigint`; un `number` sólo se acepta si es entero seguro (nunca se redondea).
- Una dirección o un `bytes32` inválidos lanzan `BatchSettlementError` (en Python, un `ValueError` de
  `eth_utils`; `BatchSettlementError` hereda de `ValueError` allí, así que un solo `except` atrapa ambos).
  Como `to_checksum_address`, se acepta cualquier mayúscula sin exigir checksum válido.
- Si el firmante no devuelve firma, se lanza `BatchSettlementError` en vez de emitir `"0x"`/`"0xundefined"`.
- `ChannelConfig` es una clase congelada con constructor de objeto (`new ChannelConfig({ payer, ... })`)
  en vez de argumentos posicionales; `toDict()` es el `to_dict()` de Python.

## Diferencias Python (y este port) frente a la referencia TS de coinbase

Se siguió Python en todas; se anotan para quien compare con `coinbase/x402`:

- Tope de depósito: Python siempre topa (`maxDeposit`, default 1_000_000); coinbase sólo cuando el
  llamador pasa un tope de gasto por pago.
- `withdrawDelay` fuera de 900..2592000: Python lo rechaza; el cliente de coinbase no lo valida.
- `chargedAmount` inválido en `confirm`: Python devuelve `false`; coinbase lanza.
- No escribir estado vacío: Python mira el acumulado previo (`previous == 0`); coinbase mira si existe el
  registro.
- `maxTimeoutSeconds` ausente: Python usa 3600; coinbase lo exige.
- `minDeposit`: Python acepta entero, decimal o hex; coinbase sólo cadena decimal positiva.
- coinbase valida `depositMultiplier >= 3` y reconstruye el canal desde la cadena en arranque en frío
  (`readContract`); Python no hace ninguna de las dos.

## Qué NO está (igual que en Python)

- Depósito por Permit2 (`assetTransferMethod: "permit2"` lanza `BatchSettlementError`).
- Reembolso cooperativo.
- Re-sincronización por 402 correctivo.
- Recuperación del canal desde la cadena.
- `PurchasePolicy`: el módulo no la consulta; quien la use la aplica antes de `createPayment`.
