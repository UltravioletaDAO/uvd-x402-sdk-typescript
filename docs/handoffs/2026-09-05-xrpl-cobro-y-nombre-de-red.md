# XRPL: cobraba en XRP lo que el integrador escribió en dólares, y el nombre de red no era el del facilitador

**Estado: arreglado en 2.85.0, rama local sin pushear, sin PR, sin tag.**

| | |
|---|---|
| Origen | El SDK de Python cerró los dos mismos defectos en [0.77.0](https://github.com/UltravioletaDAO/uvd-x402-sdk-python/pull/11) y su handoff midió que TypeScript los tenía iguales. Este es el gemelo, espejado — no reinventado |
| Rama | `0xultravioleta/ts-xrpl`, base `e3aea7a` (= `origin/main`, 2.84.0) |
| Versión | `package.json` 2.84.0 → **2.85.0** (MINOR: cambia el comportamiento del cobro) |
| Fecha | 2026-09-05 |

**Declaración de límites.** Cero paquetes instalados, cero firmas, cero deploys, cero transacciones, cero secretos leídos o impresos. Las únicas escrituras fueron a este worktree. **Sin push, sin PR, sin tag** — la corrida fue desatendida y esas acciones quedaron esperando OK. El checkout principal (`Z:/ultravioleta/dao/uvd-x402-sdk-typescript`, en `main` con archivos sucios) no se tocó; todo se midió contra `origin/main` desde este worktree. El SDK de Python se leyó en solo lectura vía `git archive origin/main` a un directorio temporal, sin tocar su repo.

---

## 1. El cobro — un `amount` en dólares se cobraba en XRP

Medido en `origin/main` (2.84.0), corriendo el código de verdad:

```
xrpl-mainnet  $10.00 -> 10000000  asset XRP  = 10 XRP
base          $10.00 -> 10000000  asset 0x8335...2913
chainToCAIP2("xrpl-mainnet") -> xrpl-mainnet
chainToCAIP2("xrpl")         -> xrpl
getChainByName("xrpl")       -> undefined
generatePaymentOptions XRP entries ->
  [{"network":"xrpl-mainnet","asset":"XRP","amount":"5000000",...},
   {"network":"xrpl-testnet","asset":"XRP","amount":"5000000",...}]
```

Un integrador que escribía `"10.00"` cobraba **10 XRP**.

**El defecto es de UNIDAD, no de ESCALA**, y por eso `decimals` nunca lo rescató. Escalar un precio por los decimales del token convierte dólares en unidades base **solo cuando una unidad entera ES un dólar**: cierto para las 23 redes de stablecoin del registro, falso para una cadena que liquida en su propio activo flotante. XRP tiene seis decimales de verdad — y seis decimales de XRP siguen siendo XRP.

**La contradicción vivía dentro de este repo.** `PaymentInfo.amount` estaba documentado como *Amount in USD* mientras el propio provider XRPL del SDK leía ese mismo campo como XRP entero (`xrpToDrops`, comentado *"whole XRP"*). El tipo y su único consumidor XRPL no se ponían de acuerdo sobre la unidad, y ganaba el consumidor.

### El arreglo

- `TokenConfig.usdPegged` / `USDCConfig.usdPegged` (`src/types/index.ts`), **ausente = anclado**, así que las 23 redes restantes quedan byte a byte iguales.
- XRPL mainnet y testnet lo llevan en `false` (`src/chains/index.ts:962,989`).
- `isUsdPegged()` y `usdConversionError()` (`src/chains/index.ts:1239,1256`) — el mensaje compartido, misma sustancia que `NetworkConfig.usd_conversion_error()` de Python.
- `buildPaymentRequirements()` **se niega** (`src/backend/index.ts:433`).
- `generatePaymentOptions()` **salta** el par impagable (`src/utils/x402.ts:322`).

**Por qué uno se niega y el otro salta, y no es inconsistencia.** `buildPaymentRequirements` nombra UNA cadena: el que llama pidió exactamente eso y merece el error. `generatePaymentOptions` arma el `accepts` de UN 402 que abarca MUCHAS cadenas — la llamada habitual le pasa todas las habilitadas — así que reventar ahí le costaría al vendedor todas las cadenas que sí estaban bien. Es exactamente lo que el handoff de Python dejó anotado como pendiente para su lado (`create_402_response_v2` todavía revienta la respuesta entera); en TypeScript ya quedó resuelto.

### El mensaje

Negarse sin decir dónde mirar solo mueve el callejón sin salida una capa arriba, así que nombra el activo, dice qué habría cobrado el código viejo, y apunta al único lugar que lista las alternativas:

> `xrpl settles in XRP, which is not pegged to the dollar, so an amount written in USD cannot be converted with its 6 decimals: $1.00 would be charged as 1 XRP. Name a dollar-pegged token this network's facilitator settles (GET /supported lists them; on XRPL that is the Circle USDC issued by rGm7WCVp9gb4jZHWTEtGUr4dd74z2XuWhE) and register it under the chain's `tokens`, or price the call in XRP units yourself.`

El emisor es el que el facilitador tiene verificado como de Circle (`x402-rs/src/network.rs:1227-1242`).

### La segunda multiplicación: existe, se movió

El encargo pedía medir si `src/utils/x402.ts` seguía teniendo la multiplicación que el handoff de Python citó en `:272-274`, porque `grep usdc.decimals` en ese archivo no daba nada.

**Existe.** Está en `src/utils/x402.ts:326` y usa `token.decimals`, no `chain.usdc.decimals` — por eso el grep no la encontraba. El refactor multi-token (PR #11, 2.84.0) cambió la forma de la función, no la aritmética. Resuelta con el `continue` de `:322`.

---

## 2. El nombre de red — `xrpl`, no `xrpl-mainnet`

La fuente de verdad, leída en el código del facilitador:

| | `x402-rs/src/network.rs` |
|---|---|
| Lo que imprime (v1, wire) | `:189` → `xrpl` |
| Lo que imprime (v2, CAIP-2) | `:613,615` → `xrpl:0`, `xrpl:1` |
| Lo que acepta en `FromStr` | `:251` → `"xrpl" \| "xrpl-mainnet"` |
| Qué dice de esa distinción | `:719` — *"right for a lookup and **wrong for a wire format**"* |

**`xrpl-mainnet` es una grafía de lookup, y el SDK la estaba poniendo en el cable.**

### El arreglo

- El registro pasa a llamarse `xrpl` (`src/chains/index.ts:939`).
- `CHAIN_ALIASES` (`src/chains/index.ts:1010`) resuelve `xrpl-mainnet` → `xrpl`, espejo de `_NETWORK_ALIASES` de Python. **No se vuelve una red aparte**: los conteos y listados siguen en 25.
- `getChainByName()` lo resuelve (`:1032`), y `isChainSupported()` pasa a delegar en él, así que las dos superficies no pueden divergir.
- `src/facilitator.ts`, `src/providers/xrpl/index.ts` (las dos ocurrencias, incluida la del header firmado) y los comentarios que afirmaban lo contrario.

---

## 3. Hallazgo nuevo, que el encargo no traía: el alias fabricaba un CAIP-2

Al demotar `xrpl-mainnet` a alias, `chainToCAIP2('xrpl-mainnet')` dejó de encontrar entrada en `CAIP2_IDENTIFIERS`, cayó al fallback `${networkType}:${chainName}` y devolvió **`xrpl:xrpl-mainnet`**.

Eso es peor que el defecto original: es una cadena que ningún facilitador acepta y que **pasa el test del dos puntos que usan todos los guards de v2 de este SDK**. El `toPaymentRequirementsV2` que existía justamente para rechazar esto empezó a construir el cuerpo. Un identificador fabricado es peor que uno ausente — el ausente se rechaza ruidoso, el fabricado se envía.

Arreglado en `src/utils/x402.ts:96`: `chainToCAIP2` resuelve por el registro primero y usa el nombre canónico, nunca la grafía que le pasaron. Test en `src/backend/index.test.ts` (*"never manufactures a CAIP-2 id out of an alias"*) y en `src/backend/xrpl-pricing.test.ts`.

---

## 4. Medición, antes y después

| | `origin/main` (e3aea7a, 2.84.0) | rama (2.85.0) |
|---|---|---|
| `vitest run` | **563 passed** (35 files) | **575 passed** (36 files), 0 perdidos |
| Conformidad cruzada TS↔PY | 347 checks, 6 fases | **367 checks, 7 fases** |
| `tsc --noEmit` | limpio | limpio |
| `eslint src` | limpio | limpio |
| `vectors:check` | up to date | up to date |
| `$10.00` en XRPL | `10000000` (= 10 XRP) | **se niega, nombrando el activo** |
| `getChainByName('xrpl')` | `undefined` | la mainnet |
| `getChainByName('xrpl-mainnet')` | la mainnet | la mainnet (alias) |

Conformidad cruzada corrida contra el `origin/main` de Python **0.78.0** (que subió de 0.77.0 mientras esto se escribía; el cambio es de escrow y no toca XRPL).

### Los tests, probados en rojo

`src/backend/xrpl-pricing.test.ts` (9 tests) es el archivo nuevo. Para probar que discrimina se exportó `origin/main` a un directorio aparte y se corrió contra él:

```
× RED #1: buildPaymentRequirements refuses a USD price on XRPL
  → expected [Function] to throw an error
× RED #2: the mainnet is registered as `xrpl`
  → expected undefined to be 'xrpl'
× RED #3: generatePaymentOptions emits no XRP option for a dollar price
  → expected [ …(2) ] to have a length of +0 but got 2
```

Los tres pasan en la rama. Los controles (que las redes ancladas sigan convirtiendo igual, que el flag sea opt-out) pasaban desde el principio, que es para lo que están.

### El pin de `'1.50' -> '1500000'` drops: **sigue siendo correcto, y sobrevive intacto**

`src/providers/xrpl/index.test.ts` pinea que 1.50 se convierte en 1.500.000 drops. Bajo el contrato nuevo eso **no cambia**, y esa es la señal de que el arreglo es el correcto, no un hueco en él.

Ese campo en el camino del pagador siempre se leyó como XRP entero. Lo que estaba mal era que el **tipo** lo documentaba como USD, así que el lado del comerciante escalaba un precio en dólares hacia el mismo campo y las dos lecturas se encontraban en el cable. El SDK ahora **se niega a construir ese precio en dólares**, lo que deja esta lectura como la única — así que 1.50 XRP → 1.500.000 drops pasó de ser la mitad de una contradicción a ser toda la verdad. La razón quedó escrita en el propio test.

---

## 5. La conformidad cruzada — con una corrección al encargo

**El encargo repetía, del handoff de Python, que `scripts/xlang/cross-language-conformance.mjs` "no menciona XRPL ni una vez". Eso quedó viejo.** Medido hoy: `grep -ci xrpl` da **5**, no 0. La suite ya traía dos casos XRPL de selección de sobre (`:632-642`, `xrpl-auto` y `xrpl-pin-2`) que comparan TS contra Python **en vivo**.

Eso importa mucho más que como corrección de trivia, y es lo que decidió el alcance de este PR — ver la sección siguiente.

Lo que sí seguía siendo cierto: **la suite nunca preguntaba qué COBRA cada SDK.** Las seis fases comparaban cómo los dos *dan forma* a una petición — firmas, presets, veredictos, sobres — y ninguna preguntó jamás cuánto facturaba ninguno. Así fue como los dos lenguajes cobraron `$10.00` como 10 XRP con todo en verde.

**Agregada la fase 7 — el precio** (op `price_network` en los dos agentes, que viven los dos en este repo, así que no hubo que tocar el SDK de Python). Cuatro casos: XRPL por el nombre canónico y por el alias (los dos deben negarse, nombrando el activo), más `base` (6 decimales) y `stellar` (7) como controles que deben seguir convirtiendo al mismo entero en los dos lenguajes.

**Verificada discriminante**: con el guard desactivado a propósito, la suite reporta

```
FAIL both SDKs either price or refuse xrpl/usd-price ($10.00 on xrpl)
     — ts=billed 10000000 py=refused
```

Restaurado el guard: **367 checks PASSED**.

---

## Para c0der

### Qué cambió y qué versión

**2.85.0** (bump MINOR en `package.json`; entrada de CHANGELOG cuya primera línea dice que XRPL cobraba mal). Tres arreglos: el SDK se niega a convertir un precio en USD cuando el activo de liquidación no tiene paridad al dólar, la mainnet pasa a llamarse `xrpl` con `xrpl-mainnet` como alias de entrada, y `chainToCAIP2` deja de fabricar identificadores a partir de un alias. Más la fase 7 de la conformidad cruzada.

**Sin push, sin PR, sin tag** — la corrida fue desatendida y las tres quedaron esperando tu OK.

### La decisión que te toca a vos: el CAIP-2 de XRPL

El encargo pedía que el cuerpo v2 emitiera `xrpl:0`. **Lo medí y no se puede hacer en TypeScript solo sin romper CI.** Te dejo el número, no la opinión:

| | resultado medido |
|---|---|
| **Sin** `xrpl:0` (lo que shippea esta rama) | **367 checks PASSED**, CI verde |
| **Con** `xrpl:0` / `xrpl:1` | `FAIL both SDKs either build or refuse xrpl-pin-2 — ts=built py=refused` → **CONFORMANCE FAILED**, CI rojo |

La razón: Python dejó XRPL fuera de `_NETWORK_TO_CAIP2` **a propósito** en 0.77.0 (sigue afuera en 0.78.0, verificado) y su handoff te escaló esa decisión **por nombre**, porque mete XRPL en el `accepts` v2 de todo consumidor que la tenga en `supported_networks`. Y la suite de conformidad exige que los dos SDK rechacen los mismos cables — uno construyendo lo que el otro llama imposible es exactamente la divergencia que esa suite existe para atrapar.

O sea que tus criterios de cierre 2 (emitir `xrpl:0`) y 5 (CI verde) no se pueden cumplir los dos desde acá. Te consulté por `orca orchestration ask` y expiró a los 15 minutos sin respuesta (madrugada), así que tomé la conservadora y te la dejo documentada y reversible.

**Lo que esta rama sí arregla del nombre**, que es donde XRPL viaja de verdad: el cable **v1** ahora dice `xrpl`, que es el que el facilitador publica. `auto` deja XRPL en v1, así que ese es el camino vivo. Un pin explícito a 2 se **niega ruidoso**, igual que Python, en vez de emitir `xrpl-mainnet` dentro de un cuerpo v2.

**El delta si decidís que sí**: dos líneas en `src/types/index.ts:597` (`xrpl: 'xrpl:0'`, `'xrpl-testnet': 'xrpl:1'`), y tiene que viajar junto con el cambio equivalente en Python, en el mismo par de PRs.

### Qué consumidor del stack emite `network` para XRPL hoy

**Ninguno.** Grep en `Z:/ultravioleta/dao/*` (solo lectura, excluyendo `node_modules`, `.git`, venvs, `dist`, `build`, worktrees):

- **execution-market: 0 archivos** mencionan XRPL fuera del SDK vendorizado. Mismo resultado en **meshrelay, describe-net, million, faro, enclaveops**.
- Sin `X402_RECIPIENT_XRPL` configurado en ningún lado con valor: solo la definición del propio SDK. Sin destinatario no hay a quién cobrarle. **El defecto era latente, no estaba sangrando.**

**Confirmación independiente de que el nombre nuevo es el bueno**: `karmakadabra/tests/sdk/test_traza_endpoint.py:35` ya lista `"xrpl"` — el canónico — en su set de mainnets del facilitador. Karmakadabra ya estaba alineado con el facilitador; **el SDK era el desalineado.** Ese test se pone rojo cuando el facilitador agrega una red, así que no es una opinión.

### Quién tiene que mover el pin

| Consumidor | Pin hoy | ¿Necesita moverlo? |
|---|---|---|
| `execution-market/*` (6 paquetes) | `^2.77.0` | **No urgente.** El caret ya toma 2.85.0 en el próximo install. No usa XRPL |
| `meshrelay/turnstile`, `meshrelay/multibrain` | `2.78.0` exacto | **Sí, cuando quieras** — pin exacto, no se mueve solo. No usa XRPL, así que no corre |
| `meshrelay/web` | `2.81.0` exacto | Igual que arriba |

Ninguno está bloqueado: nadie cobra por XRPL. Mover los pines de meshrelay es higiene, no incidente.

### Deriva que encontré de paso, y NO toqué

1. **Tres copias vendorizadas del SDK de Python** siguen diciendo `xrpl-mainnet` y no reciben ningún arreglo hasta que alguien las re-vendorice:
   - `million/402milly/backend/lambdas/purchase_pixels/uvd_x402_sdk/` (lambda de producción)
   - `describe-net/.build/uvd_x402_sdk/`
   - `em-refactor-venv/Lib/site-packages/uvd_x402_sdk/`

   No es urgente (ninguna configura XRPL), pero son copias del SDK envejeciendo solas.

2. **`x402-rs` usa `xrpl-mainnet` como clave en dos sitios propios**: `lambda/balances/handler.py:399` y `terraform/environments/production/alerts.tf:141`. Son etiquetas de monitoreo y de umbral de alerta, **no** el cable — el Rust imprime `xrpl` correctamente. No hay bug; lo anoto para que no confunda a nadie que grepee.

3. **`package-lock.json` de este repo dice `2.48.0`** mientras `package.json` va en 2.85.0. Deriva preexistente, ajena a este encargo; no la toqué (anti-scope-creep). Vale una fila de backlog.

### Fila de backlog que abro

- **El CAIP-2 de XRPL, coordinado entre los dos SDK.** Encargo chico y bien delimitado, con el delta ya medido arriba. Es tuyo decidir cuándo: toca los defaults de los consumidores que cobran.
- **`package-lock.json` desincronizado** (2.48.0 vs 2.85.0).
