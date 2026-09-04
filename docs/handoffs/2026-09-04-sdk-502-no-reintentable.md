# El `502` que no se reintenta, y el hash que va en lugar del reintento

**Fecha:** 2026-09-04
**Rama:** `0xultravioleta/ts-502` (worktree `ts-502`)
**Encargo:** `spec-sdk-502.txt`, despachado por c0der. Bloquea el merge de un PR
del facilitador que ya esta listo y en verde.
**Estado:** 3 commits. 525 tests, 30 archivos, 0 fallos. typecheck y lint
limpios. **Cero push, cero publish.**

---

## 1. El veredicto en cinco lineas

1. **El defecto era el que estaba escrito.** Dos sitios decidian reintentos por
   status y los dos trataban todo `502` como transitorio.
2. **El daño no estaba donde parecia.** El bucle de reintento de
   `facilitatorFetch` **nunca** reintentaba un `502` por su cuenta. Lo que
   gastaba dos veces era el flag `retryable: true` viajando hasta el middleware,
   que lo contesta **503 + `Retry-After`** — una instruccion literal al
   comprador de mandar el pago otra vez. §2.1.
3. **Habia un segundo sitio que el encargo no nombra:** `Erc8004LookupError`.
   `POST /register` pasa por el mismo `send_transaction_from` de EVM que un
   settle, asi que un mint puede volver sin confirmar. §2.3.
4. **El SDK de Python ya habia resuelto la mitad, y mejor.** Su guard
   anti-doble-settle es la forma **general** de la regla y vale para codigos que
   no existen todavia. Bajado a TypeScript por upstream-first. §3.
5. **Un test no alcanzaba.** El SDK puede dejar de reintentar y aun asi dejar al
   llamador sin nada que buscar: son dos mitades que caen por separado, y hay un
   rojo para cada una. §4.

---

## 2. Que se hizo

| Commit | Que |
|---|---|
| `717942a` | El cambio entero: los dos sitios de decision, los campos que llegan al llamador, el middleware, el README y 16 tests |
| `f3e8081` | `package.json` -> **2.80.0** + CHANGELOG |
| `35ef33a` | Upstream-first: el guard generico del SDK de Python, +2 tests |
| *este* | Handoff |

### 2.1 El defecto, medido con archivo:linea

El sitio central es **`src/backend/facilitator-error.ts:225`** (antes del
cambio):

```ts
const retryable = status === 429 || status === 502 || status === 503 || status === 504;
```

De ahi el flag lo copia `failureFields()` a **toda** respuesta del SDK
(`SettleResponse`, `VerifyResponse`, los escrow gasless, los writes de
ERC-8004), y llega a:

- **`src/backend/index.ts:1885`** (Express) y **`:2048`** (Hono) —
  `if (settleResult.retryable) respondUnavailable(...)`, que contesta
  **`503` + `Retry-After`**.

Ese es el gasto duplicado completo. **El bucle de `facilitatorFetch` no era el
problema:** su `canReplay` por defecto es `info.safeToReplay`, que para un `502`
siempre fue `false`, asi que nunca reintentaba solo. Lo que gasta dos veces es el
SDK **diciendole al comprador** que reintente. Si se hubiera arreglado solo el
bucle, el defecto quedaba intacto.

Y el SDK estaba siendo razonable. Hasta ahora el **unico** `502` de `/settle`
era `upstream_rpc_unavailable`, que trae `Retry-After: 30` y donde nada se
difundio. Los dos son `502`. **El status no los distingue.**

### 2.2 La forma, pineada del facilitador

Rama `0xultravioleta/x4-hash` de x402-rs, `SettlementUnconfirmedResponse`
(`src/types.rs:1838`) armada en `src/handlers.rs:5119`:

```json
502 {"error":"settlement_unconfirmed","transaction":"0x...",
     "paymentId":"0x...","retryable":false}
```

Sin `Retry-After`, deliberadamente. El otro, `src/handlers.rs:5043`:
`{"error":"upstream_rpc_unavailable (ref: <uuid>)"}` +
`HeaderValue::from_static("30")`.

El `error` del nuevo sale **pelado**, sin sufijo `(ref: ...)`. Verificado, no
inferido.

### 2.3 Los dos sitios que deciden reintentos

| Sitio | Que era | Que es |
|---|---|---|
| `facilitator-error.ts`, `readFacilitatorError` | `retryable` por status | El status es el **techo**; el cuerpo solo puede **bajarlo** |
| `index.ts`, `Erc8004LookupError.retryable` | `429/502/503/504` fijo | Idem, mismo parser |

`Erc8004LookupError` **no estaba en el encargo** y entra por lo que dice el
propio handoff del facilitador: *"EVM ... cubre todo lo que pasa por
`send_transaction_from`: EIP-3009, escrow, upto, ERC-8004"*. Su docstring ya
decia que existe para no acuñar agentes duplicados; retomar un mint que quiza ya
aterrizo es exactamente esa secuencia.

**Solo BAJA, nunca sube.** Un cuerpo que diga `retryable: true` sobre un `402` no
va a hacer que el SDK reenvie una credencial que el facilitador rechazo de
verdad. Hay un test para eso.

### 2.4 El hash, que es la otra mitad

Un error que dice "no reintentes" y no entrega nada que consultar reconstruye el
mismo callejon sin salida una capa mas arriba. Ahora `transaction`, `paymentId` y
`errorCode` viajan en `FacilitatorFailureFields` — o sea en `SettleResponse`, en
`VerifyResponse`, en los escrow gasless y en todo write de ERC-8004 — y como
getters en `Erc8004LookupError`.

El middleware los repite en su `500`, **sin `Retry-After`**: "pará" es la
instruccion correcta cuando la transferencia puede estar minando.

**El hash va verbatim.** Algorand imprime base32 y Solana base58. Reformatearlo
lo vuelve impegable en un explorador, y pegarlo es el remedio entero que
ofrecemos. Hay un test con un hash base32 real.

Un **solo** parser (`parseFacilitatorErrorBody`) para los dos sitios: dos
lecturas sutilmente distintas del mismo cuerpo es como un camino deja de honrar
el `retryable: false` que el otro honra.

### 2.5 Lo que quedo intacto

El `502` transitorio sigue `retryable`, sigue con su espera clampeada a 15s, y el
middleware sigue contestando `503` + `Retry-After: 15`. Los cinco `reason` del
writer lease, el replay automatico de los cuatro pre-ejecucion, y el nunca-replay
de `forward_failed`: sin tocar. Los 507 tests que ya existian siguen verdes.

---

## 3. Upstream-first: lo que el SDK de Python ya tenia

Leyendo `uvd-x402-sdk-python` para la seccion de abajo aparecio que **ya habia
resuelto la mitad del reintento, y mas general.**
`src/uvd_x402_sdk/client.py:194`, `_is_retryable_settle_error`:

> *"a 5xx whose body already contains a transaction hash is NOT retryable"*

Un hash en un cuerpo de **falla** significa que el facilitador llego a
**difundir** antes de fallar, se llame como se llame el error. Eso vale para
codigos que todavia no existen; ramificar sobre el nombre `settlement_unconfirmed`
y sobre el flag solo cubre lo que conocemos hoy.

Por la regla upstream-first, bajo a TypeScript (`35ef33a`) como **tercera
señal**, no como reemplazo — un facilitador que conteste `retryable: false` sin
hash igual hay que obedecerlo:

1. `retryable: false` explicito;
2. el codigo `settlement_unconfirmed`;
3. **cualquier 5xx con un hash en el cuerpo**, bajo `transaction`,
   `transaction.hash`, `txHash`, `tx_hash` o `transaction_hash`.

De paso: el camino de **error** leia una sola grafia del hash mientras el camino
de **exito** de `settle()` ya leia tres. El mismo defecto con las consecuencias
invertidas. Ahora las cinco, igual que Python.

---

## 4. Verificacion

### 4.1 Rojo A — sacando SOLO la decision de reintento

`const retryable = transportRetryable;` (sin el gate del cuerpo):

```
 × refuses to call an unconfirmed settlement retryable, and keeps its hash
 ✓ CONTROL: the transient 502 stays retryable, with its clamped wait
 × stops on the flag alone, even if the code were ever renamed
 ✓ never UPGRADES a refusal the SDK considers terminal
 ✓ carries a non-hex hash verbatim
 × facilitatorFetch retry loop > does not re-POST a settle that may already be mined
 ✓ facilitatorFetch retry loop > CONTROL: still re-POSTs the transient 502 exactly as before
 × FacilitatorClient.settle > hands the caller the hash and paymentId instead of a retry
 ✓ FacilitatorClient.settle > CONTROL: a transient 502 is still reported as retryable
 × Express middleware > does NOT answer 503 + Retry-After on an unconfirmed settlement
 ✓ Express middleware > CONTROL: still answers 503 + Retry-After on the transient 502
 × Hono middleware > does NOT answer 503 + Retry-After on an unconfirmed settlement
 ✓ Hono middleware > CONTROL: still answers 503 + Retry-After on the transient 502
 ✓ Erc8004LookupError > is not retryable when the body says the write may already be mined
 ✓ Erc8004LookupError > CONTROL: a 502 with no such body stays retryable
 × Erc8004Client write routes > does not replay a register that may already be mined

Tests  7 failed | 9 passed (16)
```

**Los nueve verdes incluyen TODOS los controles.** Y el mensaje que importa:

```
AssertionError: expected "spy" to be called 1 times, but got 3 times
```

Ese es el gasto duplicado medido: sin el arreglo, el SDK realmente POSTea el
settle tres veces.

Los dos de `Erc8004LookupError` siguen verdes aca porque ese es el **otro** sitio
de arreglo, en `index.ts`. Que caigan por separado es la prueba de que son dos.

### 4.2 Rojo B — sacando SOLO el cable del hash al llamador

Quitando las dos lineas de `transaction`/`paymentId` de `failureFields()`:

```
 ✓ refuses to call an unconfirmed settlement retryable, and keeps its hash
 ✓ facilitatorFetch retry loop > does not re-POST a settle that may already be mined
 × FacilitatorClient.settle > hands the caller the hash and paymentId instead of a retry
   → expected undefined to be '0xabababab…'
 × Express middleware > does NOT answer 503 + Retry-After on an unconfirmed settlement
   → expected undefined to be '0xabababab…'
 × Hono middleware > does NOT answer 503 + Retry-After on an unconfirmed settlement
   → expected undefined to be '0xabababab…'

Tests  3 failed | 13 passed (16)
```

La mitad del reintento queda **verde**. Un solo test no habria visto esto: el SDK
puede dejar de reintentar y aun asi dejar al llamador sin nada que buscar, que es
la forma que el cambio existe para sacar.

### 4.3 Rojo C — sacando SOLO la tercera señal (la adoptada de Python)

```
 × stops on ANY 5xx that carries a hash, whatever the code is called
   → {"error":"some_future_code","transaction":"0xabab…"}: expected true to be false
 ✓ CONTROL: a 5xx with no hash anywhere is still retryable

Tests  1 failed | 17 passed (18)
```

**Ese test primero no discriminaba.** Lo escribi con status `500`, que nunca
estuvo en la lista de reintentables (`429/502/503/504`), asi que pasaba con y sin
el guard. Corregido a `503` — un status que **si** se reintenta, donde el hash es
lo unico que lo puede dar vuelta. Es exactamente el modo de fallo contra el que
avisa el encargo, y me paso a mi en este mismo commit.

### 4.4 Suite

```bash
npm run typecheck   # 0 errores
npm run lint        # 0 errores
npx vitest run      # 30 archivos, 525 tests, 0 fallos
```

`npm run test:xlang` corre las fases 1–5 en verde contra
`Z:/ultravioleta/dao/uvd-x402-sdk-python` y **cae en la fase 6** por una
condicion **previa y ajena a este cambio**: ese checkout esta antes de 0.74.0
(`ModuleNotFoundError: No module named 'uvd_x402_sdk.envelope'`) y con archivos
modificados sin commitear. Ninguna de las seis fases toca lectura de errores del
facilitador, asi que este cambio no la puede haber roto. Detalle en §5.

---

## 5. Backlog

| Date | Item | Context | Priority | Status |
|---|---|---|---|---|
| 2026-09-04 | El SDK de Python no expone el hash al llamador | `_facilitator_error_tx_hash` es privada: se usa para el veredicto, se loguea en un warning y se descarta. Ver §6 | **P0** | Nuevo |
| 2026-09-04 | `erc8004.py:678` `_write_verdict` no tiene el guard | `retryable = status is None or status == 429 or status >= 500`. Un register sin confirmar sale reintentable | **P0** | Nuevo |
| 2026-09-04 | El checkout Python de `Z:/ultravioleta/dao` esta antes de 0.74.0 y sucio | Rompe la fase 6 de xlang para cualquiera que la corra desde aca | P1 | Nuevo |
| 2026-09-04 | xlang no tiene fase para lectura de errores del facilitador | Fase 7 natural cuando Python tenga su lado. Hoy la divergencia de reintentos entre los dos SDK es invisible al conformance | P1 | Nuevo |
| 2026-09-04 | Los escrow `authorize` usan `fetch` crudo, sin `facilitatorFetch` | `index.ts:6076`. No reintenta, pero se traga el cuerpo del error entero: `{success:false, error: undefined}` sobre un 502 | P2 | Nuevo |

---

## 6. Para c0der

**Que hice.** Tres commits en `0xultravioleta/ts-502`, mas este handoff.
`717942a` es el cambio entero — los dos sitios de decision, `transaction` /
`paymentId` / `errorCode` llegando al llamador, el `500` sin `Retry-After` del
middleware, el README y 16 tests. `f3e8081` es **2.80.0** con changelog.
`35ef33a` baja el guard generico del SDK de Python. Suite 525/525, typecheck y
lint limpios. **Cero push, cero npm publish, cero deploy.**

**Que encontre que el encargo no decia.** Tres cosas.

La primera: **el bucle de reintento nunca fue el problema.** `facilitatorFetch`
no reintentaba un `502` por su cuenta — su `canReplay` por defecto ya era
`false` ahi. Lo que gastaba dos veces era el flag viajando al middleware, que lo
traduce a **`503` + `Retry-After`** para el comprador. Arreglar solo el bucle
habria dejado el defecto entero en pie con la suite en verde.

La segunda: **`Erc8004LookupError` es un segundo sitio de decision** y no estaba
en el encargo. `POST /register` pasa por el mismo `send_transaction_from`, asi
que un mint puede volver sin confirmar, y su propio docstring dice que la clase
existe para no acuñar duplicados.

La tercera, y la que cambia el veredicto sobre el otro SDK: **Python ya tenia la
mitad, y mejor que yo.** Lo adopte upstream-first (§3).

---

### ¿El otro SDK necesita el mismo cambio? **Si, pero menos de lo que parecia — y lo que falta es exactamente lo urgente.**

Verificado leyendo `Z:/ultravioleta/dao/uvd-x402-sdk-python`, sin editarlo.

**Ya esta cubierto (no hay P0 de doble gasto en el bucle de settle):**

- `src/uvd_x402_sdk/client.py:194` `_is_retryable_settle_error` — el bucle de
  `settle` **ya se niega** a reintentar un `settlement_unconfirmed`, porque el
  cuerpo trae `transaction` y ese guard lo ve. Confirmado que el `response_body`
  llega: `facilitator_http_error` (`client.py:137`) lo adjunta.
- `src/uvd_x402_sdk/client.py:222` `is_transient_error(...)` — el veredicto
  publico que usan los consumidores tiene el mismo guard.

**Lo que le falta, con archivo:linea:**

1. **`src/uvd_x402_sdk/client.py:96` `_extract_tx_hash_from_body` es privada, y
   el hash se descarta.** El llamador recibe "no reintentable" y **nada que
   consultar** — el defecto una capa mas arriba, textual. Hay que sacar
   `transaction`, `payment_id` y el codigo de `error` a la respuesta, como hace
   ahora `FacilitatorFailureFields` del lado TS. **Este es el P0 real de Python.**
2. **`src/uvd_x402_sdk/erc8004.py:678` `_write_verdict`** —
   `retryable = status is None or status == 429 or status >= 500`, sin guard de
   hash y sin leer el flag. Un `POST /register` que conteste
   `settlement_unconfirmed` sale `retryable: True` → mint duplicado. Es el mismo
   hueco que tenia `Erc8004LookupError` del lado TS.
3. **Nadie honra el `"retryable": false` explicito.** Python lo infiere solo de
   la presencia del hash. Funciona hoy por la forma del cuerpo, pero ignora un
   contrato que el facilitador esta declarando.
4. **`src/uvd_x402_sdk/client.py:301` `transient_503_response`** hardcodea
   `body["retryable"] = True`. Esta documentado como "llamalo solo cuando
   `is_transient_error` dijo transitorio", asi que hoy esta protegido por el
   llamador — pero `is_transient_error` acepta `anti_double_settle=False` como
   opt-out, y un consumidor que lo pase se come el doble gasto.

**Sugerencia de orden:** items 1 y 2 son P0 y salen juntos; 3 y 4 son
endurecimiento. El item 2 es el mas barato: es una linea mas el guard que ya
existe veinte lineas mas arriba en otro archivo del mismo paquete.

**¿Dos ramas?** Si. Este worktree es solo TypeScript y no toque el repo Python,
como pide el encargo.

**Antes de mergear cualquiera de las dos:** el checkout Python de
`Z:/ultravioleta/dao/uvd-x402-sdk-python` esta **antes de 0.74.0 y con cambios
sin commitear**, asi que la fase 6 de xlang no puede correr desde aca. No lo
toque. Y cuando Python tenga su lado, vale una **fase 7** en
`scripts/xlang/cross-language-conformance.mjs`: hoy los dos SDK pueden divergir
en como leen un rechazo del facilitador y el conformance no lo ve — que es
literalmente el modo de fallo para el que se escribio ese script.

**Nota sobre el trailer de los commits.** El encargo pedia
`Co-Authored-By: Claude <noreply@anthropic.com>`, que es lo que usa el historial
del repo. El harness de esta sesion instruye explicitamente
`Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>` + una linea
`Claude-Session:`, diciendo que reemplaza cualquier guia previa de atribucion.
Segui el harness. Si querés uniformidad con el historial, es un `rebase`
`--msg-filter` antes de pushear — decidilo vos, yo no reescribo commits sin OK.
