# Los tres defectos que destapó el primer cliente real con dinero

**Fecha:** 2026-09-05 · **Rama:** `0xultravioleta/ts-tres-defectos` (desde `main`) · **PR:** [#12](https://github.com/UltravioletaDAO/uvd-x402-sdk-typescript/pull/12)
**Encargo:** una auditoría del SDK hecha por un proyecto real antes de elegir su riel de pago
**Versión propuesta:** **2.84.0** (minor) — sin tag, se decide al mergear

---

## QUÉ / POR QUÉ / RIESGO

**QUÉ:** el tope de fee del escrow pasa a tener una sola fuente derivada; la
respuesta "sin veredicto" (503 + `Retry-After`) deja de ser privada de Express y
se vuelve pública y agnóstica de framework; y `X402Client.connect()` empieza a
rutear Solana de verdad.

**POR QUÉ:** los tres los encontró un integrador leyendo el SDK, no nosotros
corriendo tests. Uno de ellos hace que un comprador **pague dos veces**, y otro
hace que un escrow **no abra nunca**.

**RIESGO:** uno solo, y va marcado en el PR — el default de `maxFeeBps` de
`AdvancedEscrowClient` va **800 → 1800**. Es un valor firmado y es un techo, así
que ensancha lo que el pagador acepta. Los otros dos cambios no tocan nada que
ya funcionara: los 17 tests de `writer-lease-503` pasan sin tocarlos.

**Recall ping (~10s):** el defecto del 503 y el del fee tienen la misma forma de
raíz. ¿Cuál es? *(Pista: no es "un bug de escritura". Es qué pasa cuando la misma
decisión está escrita en más de un lugar.)*

---

## Los tres, y qué se hizo con cada uno

### 1. El fee tenía dos fuentes, y una no podía abrir un depósito

`escrow-preauth.ts` decía `OPERATOR_FEE_BPS = 1300` y se negaba a firmar un bound
que no lo cubriera. `AdvancedEscrowClient` firmaba `maxFeeBps: 800`.

Lo importante, y que corrige el encuadre con el que llegó el reporte: **el revert
no es en el release, es en el `authorize`.** `PaymentOperator` compara
`protocolFee + operatorFee` contra el techo firmado y revierte con
`FeeBoundsIncompatible` a la entrada (`PaymentOperator.sol:197-199`, mismo guard
en `charge` en `:246-248`). O sea que con 800 contra un operador al 13% el escrow
**no abre**: no es que se cobre de menos, es que no pasa nada y nadie cobra.

Ahora es una sola constante y está **derivada**, no tipeada:

```ts
DEFAULT_MAX_FEE_BPS = OPERATOR_FEE_BPS + MAX_PROTOCOL_FEE_BPS   // 1300 + 500
```

Los 500 son `ProtocolFeeConfig.MAX_PROTOCOL_FEE_BPS`, el tope duro on-chain.
Como el contrato compara la suma, esa suma es el único bound que no puede
revertir — el 1800 que ya estaba ahí era exactamente eso, y nadie lo había
escrito.

### 2. El 503 existía, pero solo para Express

`verify` devuelve inválido para un pago rechazado **y** para un facilitador que
no llegó a ningún veredicto. Responder 402 en el segundo caso le dice al
comprador que firme otra autorización mientras la primera sigue viva: paga dos
veces.

El SDK ya lo resolvía, pero en **dos** funciones privadas duplicadas
(`respondUnavailable` para Express, `honoUnavailable` para Hono). Quien escribe
su handler a mano no alcanzaba ninguna. Ahora existe
`buildUnavailableResponse()`, pública y agnóstica, y **las dos middlewares
construyen su respuesta con ella**.

### 3. `connect()` tenía un `case` muerto

El registro dice `networkType: 'svm'`; el switch preguntaba por `case 'solana'`.
Ninguna cadena tuvo nunca ese valor, así que la rama nunca corrió y Solana caía
en `default:` con `"Unknown network type for chain solana"`. `NetworkType` admite
las dos grafías, por eso TypeScript no lo marcó.

`SVMProvider` con detección de Phantom ya estaba. Ahora `connect`, `disconnect`,
`getBalance` y `createPayment` rutean por el adapter, con import diferido para
que `@solana/web3.js` siga siendo peer opcional.

---

## Lo que medí y NO arreglé

**Los `operator` de `ESCROW_CONTRACTS` son factories, no operadores.**

```bash
cast call 0x3D0837fF8Ea36F417261577b9BA568400A840260 \
  "ESCROW()(address)" --rpc-url https://mainnet.base.org
# 0xb9488351E48b23D798f24e8174514F28B741Eb4f     <- inmutable de la factory
cast call 0x3D0837fF8Ea36F417261577b9BA568400A840260 \
  "FEE_CALCULATOR()(address)" --rpc-url https://mainnet.base.org
# execution reverted                              <- getter que solo tiene el operador
```

Responden `ESCROW()` y `operators(bytes32)`, revierten en `FEE_CALCULATOR()`,
`FEE_RECIPIENT()` y `release(...)`. Confirmado en **Base mainnet, Base Sepolia y
Arbitrum**, y `x402-rs/docs/X402R_MULTICHAIN_DEPLOYMENT.md` etiqueta esas mismas
direcciones como `PaymentOperatorFactory`.

Una factory no tiene `release`/`charge`, así que los caminos on-chain directos de
`AdvancedEscrowClient` no pueden ejecutar contra esas direcciones como están
escritas. **Lo dejé documentado en el código y no lo toqué**: resolver el
operador de otra forma es un rediseño del camino del dinero, y esa decisión es
tuya, no mía.

Corolario que vale la pena guardar: la pregunta "¿cuál de los dos números es el
real, 1300 u 800?" **no tiene respuesta medible desde el SDK**. El fee del
operador es un inmutable de cada instancia, elegido en
`OperatorConfig.feeCalculator` cuando la factory la despliega. El fee de
*protocolo* sí lo medí: hoy es **0 bps** en Base (`calculator()` es la dirección
cero, sin cambio en cola).

---

## Verificación

| | |
|---|---|
| Suite | **563 pasan** (35 archivos). Base: 546 / 32 |
| Typecheck / Lint | limpios |
| Conformidad cruzada TS/PY | **266 checks OK**, fases 1–5, cero fallos |

Los tres arreglos se corrieron en rojo primero:

- `escrow-fee-bounds.test.ts` → `expected 800 to be greater than or equal to 1300`
- `unavailable-response.test.ts` → 6 rojos, la función pública no existía
- `solana-routing.test.ts` → `promise rejected "Unknown network type for chain solana"`

**Lo que no corrió:** la **fase 6** del arnés cruzado (el sobre). El checkout de
Python en disco está en **0.72.0** y la fase exige `uvd_x402_sdk.envelope`
— que según `docs/handoffs/2026-09-04-xlang-cable-v2.md` pide **0.75.0+**. Es un
hueco de entorno preexistente: nada de este diff toca Python ni el formato del
sobre. Para correrla hay que actualizar el checkout hermano y volver a lanzar
`UVD_X402_PY_ROOT=... npm run test:xlang`.

---

## Para c0der

### Qué entró

| # | Qué | Dónde | Tipo |
|---|---|---|---|
| 1 | Fee del escrow con una sola fuente **derivada** (`OPERATOR_FEE_BPS + MAX_PROTOCOL_FEE_BPS`), con override y guard | `src/escrow-preauth.ts`, `src/backend/index.ts` | fix + API nueva |
| 2 | `buildUnavailableResponse()` pública y agnóstica; Express y Hono la consumen | `src/backend/index.ts` | **API pública nueva** |
| 3 | `connect()` rutea `svm` al `SVMProvider`; `disconnect`/`getBalance`/`createPayment` también | `src/client/X402Client.ts` | fix |
| — | Las factories, el fee de protocolo en 0, y el timeout de 960s de L1 | comentarios en el código | documentación |

### Qué versión propongo

**2.84.0 — minor.** El punto 2 agrega API pública (`buildUnavailableResponse`,
`UnavailableResponse`, `UnavailableBody`), más `MAX_PROTOCOL_FEE_BPS`,
`DEFAULT_MIN_FEE_BPS`, `DEFAULT_MAX_FEE_BPS` y los overrides de
`buildPaymentInfo`. Nada se rompe a nivel de firma.

**El tag no lo puse.** CHANGELOG escrito, `package.json` en 2.84.0, PR abierto y
sin mergear. Tagear y publicar lo decidís vos.

### Lo único que hay que mirar antes de mergear

El default de `maxFeeBps` de `AdvancedEscrowClient` va **800 → 1800**. Es un
valor firmado y es un techo, así que ensancha lo que el pagador acepta. Mi
argumento para hacerlo igual: 800 no podía transaccionar contra el operador que
el propio SDK llama canónico, y 1800 es el único bound que el contrato garantiza
que nunca revierte. Pero es camino del dinero y la decisión final es tuya.

### Qué proyecto del stack tiene que mover su pin después

En este orden:

1. **El cliente de limusinas (miamovent).** Es quien reportó los tres y quien
   está bloqueado por dos de ellos. Su fase 1 exige una versión mayor a 2.76.0
   con el gate agnóstico publicado; con 2.84.0 queda desbloqueada, y su gateway
   nuevo debe usar `buildUnavailableResponse()` en vez de escribir el 503 a
   mano. Su decisión de dejar Solana afuera de la v1 se puede revisar: el
   defecto 3 era la razón, y ya no está.
2. **describe-net.** Consume el SDK y sirve rutas pagas; el punto 2 le aplica
   directo si algún handler suyo no es Express.
3. **execution-market.** Es el consumidor real de `AdvancedEscrowClient`. Le
   aplica el punto 1 **y** es quien tiene que contestar lo de las factories:
   sabe qué operador desplegó y con qué `feeCalculator`. Si ese operador cobra
   0, el bound de 1800 no le cambia nada; si cobra 13%, hoy no podía abrir
   depósitos por el 800.

### Lo que queda abierto

- **Las factories.** Documentado, no arreglado. Necesita una decisión de diseño:
  o `ESCROW_CONTRACTS` guarda operadores reales por cadena, o
  `AdvancedEscrowClient` los resuelve del config del marketplace como ya hace
  `buildEscrowPreAuth`. Yo me inclino por lo segundo — es el patrón que el SDK
  ya tiene y que ya funciona — pero mueve dinero y no es mi llamada.
- **Fase 6 del arnés cruzado.** Actualizar el checkout de Python a 0.75.0+ y
  volver a correrla.
