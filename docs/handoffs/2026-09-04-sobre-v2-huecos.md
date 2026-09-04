# Los tres huecos del sobre, cerrados — y un cuarto que apareció al cerrarlos

**Fecha:** 2026-09-04 · **Rama:** `0xultravioleta/ts-huecos` · **Versión:** 2.79.0 (sin publicar)
**Encargo:** los dos huecos que el SDK de Python declaró "no son míos, son del repo de TypeScript"
(`uvd-x402-sdk-python`, rama `0xultravioleta/py-sobre-v2`, PR #6,
`docs/handoffs/2026-09-04-sobre-v2-python.md` §5.1 y §5.3), **más el hueco 3 y la
tabla vencida** que c0der agregó a mitad del trabajo desde una medición en
runtime del worker de MeshRelay
**Antecedente en este repo:** `docs/handoffs/2026-09-03-sobre-v2.md`

---

## QUÉ / POR QUÉ / RIESGO

**QUÉ:** (1) el `x402Version` del top level del sobre v1 ahora lo decide la
**forma** del cuerpo, no el marcador que mandó el pagador; (2) el test de
conformidad cruzada TS↔PY tiene una fase 6 que compara el sobre que cada SDK
elige y construye, cuerpo contra cuerpo; (3) `auto` dejó de **lanzar** sobre un
payload v2, que es justo la forma que existe para rutear. Más dos cosas que
salieron midiendo: (4) una red sin forma CAIP-2 se **niega** a viajar en v2 en
vez de emitir en silencio un cuerpo que el facilitador rechaza, y (5) la tabla
medida del comentario de `resolveEnvelopeVersion` estaba vencida y se corrigió
contra el facilitador vivo.

**POR QUÉ:** los dos SDK aprendieron a elegir sobre por separado, con días de
diferencia, y lo único que notó que habían quedado con cuerpos distintos fue una
comparación a mano. El test que existe para eso pasaba con 266 checks sin mirar
un solo sobre. Y el default `auto` —la opción que ese trabajo agregó— era la
única que nadie podía usar.

**RIESGO:** el camino que hoy mueve plata —el 402 con CAIP-2 que ChatGPT paga vía
PayBox— sale byte por byte igual; está fijado por 12 cables comparados contra el
otro SDK. Lo que cambia de verdad: un caso que el facilitador ya entendía y va a
seguir entendiendo (el marcador); uno que hoy es un 400 garantizado y ahora falla
local con el fix adentro (XRPL pineado a v2); y uno que hoy revienta con
`TypeError` y ahora resuelve (payload v2 en `auto`). Escape de los dos últimos:
`x402Version: 1`.

**Recall ping (~10s):** el facilitador ignora el `x402Version` del top level para
decidir cómo leer el cuerpo. Entonces, ¿por qué importa que diga 1 y no 2? Si la
respuesta no menciona el **hint del 400**, vale la pena leer el §2 de abajo.

---

## 1. Lo primero: verifiqué cada reporte antes de tocar nada

Los encargos pedían medir, no creer. Los tres eran ciertos.

| Hueco | Reporte de Python | Verificado acá |
|---|---|---|
| 1 · el test cruzado no cubre el sobre | "cero menciones en sus tres archivos" | ✅ `grep -c -iE "envelope\|paymentRequirements\|buildVerifyRequest\|x402Version"` sobre `agent.mjs`, `agent.py`, `cross-language-conformance.mjs` → **0, 0, 0**. Y corrido: `CROSS-LANGUAGE CONFORMANCE PASSED — 266 checks across 5 phases` |
| 2 · TS declara v2 en un cuerpo con forma v1 | "hereda `paymentHeader.x402Version`" | ✅ `src/backend/index.ts:446` y `:576`, las dos líneas `x402Version: paymentHeader.x402Version` |
| 3 · `auto` lanza con un payload sin `network` | (addendum de c0der, medido por MeshRelay) | ✅ reproducido contra el `dist/` compilado: `TypeError: Cannot read properties of undefined (reading 'includes')` — §5 |

Nada que corregirle a ninguno de los dos reportes. Lo que sí apareció, y que
ninguno sabía, es una cuarta cosa — §4.

---

## 2. Hueco 2 · el marcador nombra el sobre, no al pagador

`buildVerifyRequest` / `buildSettleRequest` copiaban el `x402Version` del header
del pagador al top level del sobre **v1**. Un comprador que declara `2` —legal, y
lo que invita nuestro propio 402 en cuanto anuncia CAIP-2— producía un cuerpo que
dice `2` con un `paymentRequirements` adentro, que es la forma v1. Contradicción
interna del cuerpo.

Hoy no rompe nada: el enum de sobres del facilitador es *untagged*, matchea por
forma e ignora el marcador. **Pero el facilitador ya lee ese marcador para una
cosa** — elegir el hint de su 400:

> `"hint":"This body declares \`x402Version: 2\`. x402 v2 is a JSON object with
> \`paymentPayload\`, \`resource\` and \`accepted\`…"`

O sea que el día que ese cuerpo falle por cualquier otro motivo, el diagnóstico
manda al integrador a documentar la forma equivocada. Que te manden a los campos
cuando el problema es el envoltorio es la inversión exacta que ya costó un día.

El marcador del pagador **no se toca**: sigue en `paymentPayload.x402Version`,
que es donde el facilitador lo lee y donde describe el pago, no el sobre.

Además `VerifyRequest.x402Version` y `SettleRequest.x402Version` pasan de
`X402Version` a `1`. Esas interfaces **son** el sobre v1 (`VerifyRequestV2` es la
otra), así que un `2` ahí siempre fue un valor inhabitable — y tiparlo `1 | 2` es
lo que permitió que el marcador del pagador se copiara. Ahora la regresión no
compila, no solo falla en runtime. Es cambio de tipos publicados y va en el
README, en el mismo commit.

### La prueba discriminante (salida real)

Con el defecto reintroducido —`x402Version: paymentHeader.x402Version` de vuelta
en los dos builders— y los tests nuevos puestos:

```
 ❯ src/backend/v2-envelope.test.ts (35 tests | 4 failed)
   × the v1 envelope marker is the envelope, not the payer > emits 1 for a payer that declared 2
     → expected 2 to be 1 // Object.is equality
   × the v1 envelope marker is the envelope, not the payer > emits 1 on /settle too
     → expected 2 to be 1 // Object.is equality
   × the v1 envelope marker is the envelope, not the payer > never contradicts itself: the marker and the shape agree, on every wire
     → marker=2 network=base pin=auto: expected 2 to be 1 // Object.is equality
   × the v1 envelope marker is the envelope, not the payer > sends 1 through the client, on the wire that produced the report
     → expected 2 to be 1 // Object.is equality

 Test Files  1 failed (1)
      Tests  4 failed | 31 passed (35)
```

Los cuatro caen con **assert real** (`expected 2 to be 1`), no con "la función no
existe". Y los dos guardas de no-regresión quedan **verdes en los dos estados**,
que es exactamente para lo que existen:

- `leaves the payer's own marker untouched inside paymentPayload` — un arreglo
  que clampeara los dos marcadores sería una regresión, y esto lo impide.
- `does not move the ordinary v1 payer`.

El más útil de los cuatro no es un caso sino un **invariante**:
`never contradicts itself` recorre marcador × red × pin (12 combinaciones) y
exige que un cuerpo marcado 2 lleve `{resource, accepted}` y uno marcado 1 lleve
`paymentRequirements`. Es lo que el facilitador exigiría el día que su enum deje
de ser untagged, y lo que el hint de su 400 ya asume hoy.

Commit `3c68081`.

---

## 3. Hueco 1 · la conformidad cruzada ahora mira el sobre

Las cinco fases eran ERC-8128 de punta a punta: firmas, presets, matriz de
verificación. El sobre es el **otro** contrato de cable que los dos SDK comparten
y es el que de verdad se separó. El propio archivo dice existir para esto —
*"both SDK suites were green while the two implementations diverged"*— y tenía
266 checks en verde sin mirar un sobre.

**Fase 6.** Op `build_envelope` en los dos agentes; el driver manda 12 cables y
compara la versión elegida y los dos cuerpos, clave por clave.

Sobre la forma del op: los tres campos de salida (`{version, verify, settle}`)
son los que especificó §5.1 del handoff de Python. **La entrada la amplié**: en
vez de un `network` lleva `payloadNetwork` y `requirementsNetwork` por separado,
porque con uno solo no se puede expresar el caso en que el vendedor arma
requirements desde una config v1 mientras el comprador contesta el CAIP-2 que
anunció el 402 — que es un caso que el SDK ya trata como crítico (tiene su propio
test desde 2.78.0). Es un superconjunto de lo pedido.

Dos decisiones que hacen que el test valga:

1. **El driver manda todos los campos** —payload, requirements, las dos redes, el
   marcador, el pin—. Si dejara que cada agente rellenara los suyos, lo comparado
   serían los defaults de cada SDK, y una divergencia real podría esconderse
   detrás de un default que coincide.
2. **El driver tiene regla propia, no importada de ninguno de los dos.** El
   `x402Version` del top level tiene que ser igual a la versión elegida, y el
   cuerpo llevar las claves de esa versión y no las de la otra. Sin eso, los dos
   SDK podrían coincidir byte a byte en un cuerpo que se contradice a sí mismo.

Resultado: **266 → 333 checks**, y **12 de 12 cables byte-idénticos** entre los
dos SDK (Python venía de 5 de 6; el que faltaba era el marcador, cerrado en §2).

```
CROSS-LANGUAGE CONFORMANCE PASSED — 333 checks across 6 phases.
  26 signatures produced live by TypeScript and verified live by Python,
  26 produced live by Python and verified live by TypeScript,
  72 matrix verdicts compared verifier to verifier,
  12 wires whose envelope both SDKs chose and built, compared body to body.
```

### Probado en rojo por los DOS lados

Un test de no-divergencia que solo se cae cuando se mueve un lado no sirve. Los
dos, con la salida real:

**a) TypeScript mueve el sobre solo** (vuelve a heredar el marcador) → 3 rojos:

```
FAIL identical /verify body for marker-2/plain (base / base marker=2 pin=auto)
     ts={"x402Version":2,…,"paymentRequirements":{…}}
     py={"x402Version":1,…,"paymentRequirements":{…}}
FAIL identical /settle body for marker-2/plain (base / base marker=2 pin=auto)
FAIL typescript's body for marker-2/plain (base / base marker=2 pin=auto) says what it is
     — marker 2 on a v1 envelope
CROSS-LANGUAGE CONFORMANCE FAILED — 3 check(s)
```

El tercero es el que más importa: es la regla propia del driver, y atrapa el
defecto **sin comparar contra Python**. O sea que si los dos SDK cometieran el
mismo error a la vez —byte-idénticos y los dos mal— igual se pone rojo.

**b) Python mueve el sobre solo** (le saco la copia interna del v2 a
`envelope_v2.py`) → **14 rojos**, todos los cables v2, verify y settle:

```
FAIL identical /verify body for caip2/caip2       FAIL identical /settle body for caip2/caip2
FAIL identical /verify body for caip2/plain       FAIL identical /settle body for caip2/plain
FAIL identical /verify body for plain/caip2       FAIL identical /settle body for plain/caip2
FAIL identical /verify body for caip2-avalanche   FAIL identical /settle body for caip2-avalanche
FAIL identical /verify body for marker-2/caip2    FAIL identical /settle body for marker-2/caip2
FAIL identical /verify body for pin-2-over-plain  FAIL identical /settle body for pin-2-over-plain
FAIL identical /verify body for eurc-extra        FAIL identical /settle body for eurc-extra
CROSS-LANGUAGE CONFORMANCE FAILED — 14 check(s)
```

**c) Un checkout de Python sin `uvd_x402_sdk.envelope`** → exit **1** nombrando el
fix, no un skip. Respeta la promesa del arnés:

```
╳ CROSS-LANGUAGE CONFORMANCE COULD NOT RUN
the python agent refused to run:
the Python SDK has no envelope selection: ModuleNotFoundError: No module named
'uvd_x402_sdk.envelope'. `uvd_x402_sdk.envelope` ships from 0.74.0 — update the
checkout at UVD_X402_PY_ROOT. This agent does NOT skip: without it the two SDKs'
envelopes are unchecked against each other, which is the whole point of this phase.
```

Ese es el estado de `main` de Python **hoy** — ver la nota de orden de merge en
*Para c0der*.

Commit `da7c00e`.

---

## 4. El cuarto: lo que la fase 6 destapó apenas la corrí

No estaba en ningún encargo. Salió en la primera corrida de la fase 6:

```
FAIL both SDKs either build or refuse xrpl-pin-2 (xrpl-mainnet / xrpl-mainnet marker=1 pin=2)
     ts=built
     py=refused: Network 'xrpl-mainnet' has no CAIP-2 form, so it cannot travel in
                 the x402 v2 envelope. Use x402_version=1 for this network.
```

Medido, lo que TypeScript construía:

```json
{ "x402Version": 2,
  "accepted": { "scheme": "exact", "network": "xrpl-mainnet", "asset": "XRP", … } }
```

Un **nombre plano de red adentro de un cuerpo v2**. Que es el 400 que el propio
handoff de Python midió (su P8), y que el comentario que está tres líneas arriba
de la función ya decía: *"a plain name inside a v2 body is a 400"*. El SDK sabía
la regla y mandaba el cuerpo igual.

La causa: `chainToCAIP2` contesta con el nombre tal cual cuando no conoce la
cadena, y `xrpl-mainnet` está mapeado **a sí mismo** a propósito — su string v1
*es* su identificador de red. No lo toqué (lo usan otros cuatro sitios): el
arreglo va en `toPaymentRequirementsV2`, que es donde una red sin forma CAIP-2 es
un error.

Acá el que había resuelto mejor era Python, así que TypeScript adopta: ahora
lanza nombrando la red y la salida, que es lo que el 400 del facilitador **no**
dice (contesta `data did not match any variant of untagged enum
VerifyRequestEnvelope`, sin nombrar un campo).

Solo se llega pineando 2 en una red así; `auto` las deja en v1, donde funcionan.
Eso queda fijado con guardas verdes en los dos estados para que este arreglo no
se convierta en una forma nueva de romper XRPL, que es camino vivo.

**Prueba discriminante** (sin la guarda):

```
 ❯ src/backend/v2-envelope.test.ts (39 tests | 2 failed)
   × a network with no CAIP-2 form refuses v2 rather than emitting a 400 > throws, naming the network and the escape
     → expected [Function] to throw an error
   × a network with no CAIP-2 form refuses v2 rather than emitting a 400 > throws through the builders, on both endpoints
     → expected [Function] to throw an error
```

Y los dos guardas verdes en ambos estados: `never fires on auto — XRPL stays on
v1` y `leaves every network that HAS a CAIP-2 form alone` (base, avalanche,
solana, stellar — para que el throw sea sobre la forma que falta y no sobre las
cadenas no-EVM).

Commit `50304d2`.

---

## 5. Hueco 3 · `auto` se caía justo con la forma v2 (addendum de c0der)

Llegó a mitad del trabajo, desde una medición en runtime del worker de MeshRelay.
Lo primero que hice fue reproducirlo acá, contra el `dist/` compilado:

```
v1 (network presente) -> 2
v2 (sin network) LANZA: TypeError: Cannot read properties of undefined (reading 'includes')
```

Idéntico al reporte. Y la causa explica por qué es peor de lo que parece: **un
payload v2 no tiene `network` de primer nivel en absoluto**. Mirá
`PaymentPayloadV2` en este mismo archivo — es
`{x402Version, resource, accepted, payload}`; v2 movió el chain id adentro de
`accepted`. `resolveEnvelopeVersion` leía solo `paymentHeader.network`, así que
la función que existe para elegir entre v1 y v2 se caía con v2, antes de decidir
nada.

Y no era teórico: turnstile y multibrain de MeshRelay pinnean `x402Version` 1 o 2
explícito para esquivarlo. El default de nuestro propio SDK era la única opción
que nadie podía usar — o sea que el trabajo de 2.78.0 (que el cliente ELIJA el
sobre) estaba entregado a medias sin que la suite dijera nada.

**El arreglo:** la red se lee donde el payload la tenga —top level si está, si no
`accepted.network`— y un `undefined` es una respuesta legítima ("este payload no
aporta evidencia CAIP-2"), no una excepción adentro de la selección de versión.
El parámetro se amplía a `X402Header | PaymentPayloadV2`, que es lo que de verdad
recibe.

Verifiqué el camino completo, no solo la resolución:

```
resolve(v2 sin network)                  -> 2
cuerpo: {"x402Version":2,"tieneAccepted":true,"payloadInterno":{"signature":"0xdead"}}
resolve(v2 accepted CAIP-2 / reqs plano) -> 2
cliente end-to-end -> x402Version: 2 | accepted: true
```

La segunda línea importa: los requirements dicen `base` ahí, así que el 2 solo
pudo salir de `accepted.network`. Es lo que separa "arreglé la lectura" de
"me tragué el undefined".

### La prueba discriminante (salida real)

Con el defecto reintroducido —leer solo el top level, sin tolerar `undefined`—:

```
 ❯ src/backend/v2-envelope.test.ts (45 tests | 5 failed)
   × auto survives a v2 payload… > resolves instead of throwing
     → expected [Function] to not throw an error but 'TypeError: Cannot read properties of …' was thrown
   × auto survives a v2 payload… > reads the chain id out of `accepted`, where v2 keeps it
     → Cannot read properties of undefined (reading 'includes')
   × auto survives a v2 payload… > still refuses to upgrade on the marker alone
     → Cannot read properties of undefined (reading 'includes')
   × auto survives a v2 payload… > does not throw when the requirements have no network either
     → expected [Function] to not throw an error but 'TypeError: Cannot read properties of …' was thrown
   × auto survives a v2 payload… > builds the v2 body end-to-end through the client
     → Cannot read properties of undefined (reading 'includes')

      Tests  5 failed | 40 passed (45)
```

Guarda verde en los dos estados: `leaves a v1 header reading its own top-level
network` — el arreglo no puede empezar a preferir `accepted` sobre un `network`
de primer nivel que sí está. Y `still refuses to upgrade on the marker alone`
comprueba que tolerar el undefined no relajó la regla medida.

Commit `6efeb26`.

---

## 6. La tabla vencida, corregida contra el facilitador vivo

El comentario de `resolveEnvelopeVersion` publicaba una tabla del 2026-09-03 con
tres filas en 400 duro, y sobre ellas construía el argumento de la regla: *"toda
combinación CAIP-2 ya es un 400, así que subirlas a v2 no puede regresionar a
nadie: solo convierte una falla en un pago"*. Vencida.

La medí yo contra `https://facilitator.ultravioletadao.xyz/verify` en vez de
citar la medición de Python, y **la medición me corrigió el método**: con una
firma fabricada **todo** contesta 400, así que el status no discrimina nada. Lo
que discrimina es el código — `invalid_request_body` = no pudo deserializar;
`contract_call_failed` = leyó el cuerpo, resolvió la cadena y llegó a la llamada
on-chain, o sea que el sobre estaba bien. (El handoff de Python reportó 200 en
estas filas; su firma fabricada llegaba a un veredicto en vez de reventar la
llamada. La conclusión es la misma: entendido.)

Sobre v1, las cinco filas — las tres que el comentario daba por 400 incluidas:

```
contract_call_failed   payload base         / reqs base
contract_call_failed   payload base marker2 / reqs base
contract_call_failed   payload eip155:8453  / reqs base
contract_call_failed   payload base         / reqs eip155:8453
contract_call_failed   payload eip155:8453  / reqs eip155:8453
```

Y el control negativo, sin el cual "entendido" no prueba nada — mismas corridas,
cuerpos rotos a propósito:

```
contract_call_failed   v2 CAIP-2 bien formado      <- control positivo
invalid_request_body   v2 con nombre plano de red
invalid_request_body   v2 con resource como string suelto
invalid_request_body   v2 sin accepted
```

La **regla no cambia** —sigue subiendo por CAIP-2, sigue ignorando el marcador—;
lo que cambia es por qué, y ahora el comentario lo dice: las tres razones que
quedan en pie (el 402 que produjo ese id anunciaba v2; v2-con-CAIP-2 es la única
forma que aceptan las dos generaciones del facilitador; paridad con Python,
fijada por la fase 6). Cero cambios de comportamiento.

El mismo dato vencido estaba replicado en **cuatro comentarios** del archivo de
tests, incluidos los labels de la tabla `it.each` que decían `(400 today)`.
Corregidos también: es el mismo hecho y se lee igual de mal. No toqué los dos
`Measured 400` que siguen siendo ciertos (resource parcial y `accepted` sin
`maxTimeoutSeconds`, los dos del sobre v2) — el control negativo de arriba los
respalda.

Commit `568d941`.

---

## 7. Versión

**2.79.0**, MINOR sobre 2.78.0. **No publicado** — el tag y el `npm publish` son
de c0der.

No es patch: el cuerpo del sobre v1 cambia en un caso, dos tipos publicados se
estrechan, una función pública ahora lanza donde antes devolvía, y otra deja de
lanzar donde antes lo hacía. No es MAJOR: ninguna firma cambia, el camino v1
normal sale byte por byte igual, el estrechamiento solo rompe a quien escribía un
valor que nunca fue válido, y el throw solo se alcanza en un cable que hoy es un
400 garantizado — cambia un fallo remoto mudo por uno local con el fix adentro.

El bump (`7a52470`) quedó **en medio** de la serie porque el addendum llegó
después. 2.79.0 no está publicada ni tageada, así que sigue siendo la versión en
preparación: no inventé una 2.80.0, completé su changelog al final (`f8b9f83`).

Changelog en `CHANGELOG.md`.

---

## 8. Estado de cierre

| Criterio | Estado |
|---|---|
| Hueco 1 (el test cruzado no cubre el sobre) | ✅ fase 6, 266 → 333 checks, §3 |
| Hueco 2 (v2 declarado en cuerpo v1) | ✅ §2 |
| Hueco 3 (`auto` lanza con payload v2) | ✅ §5, reproducido en runtime antes de tocar |
| Tabla vencida de `resolveEnvelopeVersion` | ✅ §6, re-medida contra producción con control negativo |
| Cada arreglo con test discriminante, rojo pegado | ✅ §2, §4, §5 — tres rojos medidos, más el rojo de la fase 6 por los dos lados (§3) |
| Suite en verde | ✅ **507/507**, 29 archivos. Typecheck y lint limpios |
| Conformidad cruzada en verde | ✅ **333 checks / 6 fases**, 12 de 12 cables byte-idénticos |
| Contratos publicados actualizados en el mismo commit | ✅ README (§ del sobre) con el código; CHANGELOG con el bump |
| `git status` limpio, cero push, cero publish | ✅ 7 commits locales |

**Cómo correr la conformidad cruzada acá:**
`UVD_X402_PY_ROOT=<checkout de python 0.74.0+> npm run test:xlang` (necesita
`npm run build` antes: los agentes leen `dist/`, no `src/`).

**Nota de operación:** para correrla usé un checkout efímero de la rama
`0xultravioleta/py-sobre-v2` extraído con `git archive` a mi scratchpad. El repo
de Python **no se tocó**: sigue en su rama con su working tree como estaba.

---

## Para c0der

Los tres huecos están cerrados, y cerrar el primero destapó un cuarto que no
estaba en ningún encargo.

**Hueco 2** (el marcador heredado): arreglado y, además de fijado por tests,
ahora la regresión **no compila** — `VerifyRequest.x402Version` pasó de
`X402Version` a `1`, porque esas interfaces *son* el sobre v1 y un `2` ahí nunca
fue un valor habitable. El marcador del pagador no se toca.

**Hueco 1** (el test que no miraba el sobre): confirmado tal cual lo reportó
Python (0, 0, 0 menciones; 266 checks) y cerrado con la fase 6, 266 → 333 checks,
12 de 12 cables byte-idénticos entre los dos SDK. Lo probé rojo **por los dos
lados** —moviendo TS y moviendo Python— y con un checkout de Python viejo, donde
sale exit 1 con el fix nombrado en vez de saltar. La fase también tiene regla
propia, así que atrapa un cuerpo que se contradice aunque los dos SDK se pongan
de acuerdo en él.

**Hueco 3** (tu addendum): reproducido en runtime acá antes de tocar nada, con el
`TypeError` idéntico. La causa es peor que "no chequea undefined": un payload v2
**no tiene `network` de primer nivel en absoluto** —v2 lo movió adentro de
`accepted`—, así que la función que existe para elegir entre v1 y v2 se caía con
v2. Ahora lee la red donde el payload la tenga y resuelve. Confirmado
end-to-end: payload v2 por `FacilitatorClient.verify()` **sin pin** produce cuerpo
v2. **MeshRelay puede sacar los pines de turnstile y multibrain cuando esta
versión esté publicada** — antes no, el arreglo es de 2.79.0.

**La tabla vencida:** la medí yo contra el `/verify` vivo en vez de citar la
medición de Python, y eso corrigió el método además del dato: con firma fabricada
**todo** da 400, así que el status no discrimina nada — discrimina el código
(`invalid_request_body` vs `contract_call_failed`). Las cinco filas del sobre v1
están entendidas hoy, las tres que decían 400 incluidas. Cerré por el lado
negativo con tres cuerpos rotos a propósito. La regla no cambió, cambió el
argumento que la sostiene, y el comentario ahora lo dice.

**El cuarto, que es el hallazgo:** con pin a v2 sobre XRPL, TypeScript construía
en silencio un cuerpo v2 con nombre plano de red — un 400 medido — con el
comentario que dice que eso es un 400 tres líneas más arriba. Python ya se negaba
con el fix en el mensaje. Upstream-first al revés: acá el que había resuelto
mejor era Python y TypeScript adoptó.

**Lo que hay que saber para mergear — orden de merge.** La fase 6 necesita el
SDK de Python **0.74.0+** (`uvd_x402_sdk.envelope`), que hoy vive en el PR #6 de
`uvd-x402-sdk-python` y **no está en `main`**. Si este PR entra primero, el job
"Cross-language conformance (TS ↔ PY)" del CI va a fallar —ruidoso, con el fix
nombrado, que es como el arnés está diseñado— hasta que el PR #6 esté mergeado.
**Mergeá el PR #6 de Python antes que este**, o esperá el verde recién cuando los
dos estén adentro. No es un problema del test: es el test haciendo lo que promete
en vez de saltar.

**Un cable que dejé listo y NO agregué, a propósito.** El hueco 3 pide un cable
de la fase 6: payload v2 sin `network` de primer nivel, `pin: 'auto'`. Con
TypeScript arreglado y Python todavía no, ese cable pone la fase 6 en rojo — y
vos dijiste que el lado Python lo abrís aparte. Así que no lo metí para no
entregarte rojo. **Cuando el arreglo de Python esté, agregalo**: es una línea en
`ENVELOPE_CASES` de `scripts/xlang/cross-language-conformance.mjs`, con
`payloadShape: 'v2'` (el agente arma el payload sin top-level network, con la red
en `accepted`) — y ahí queda fijado en los dos SDK a la vez, que es donde tiene
que vivir. Es la misma deuda que Python me dejó a mí en su §5.1.

**Lo que no hice:** ni push, ni publish, ni tag, ni deploy. 7 commits locales en
`0xultravioleta/ts-huecos`, worktree limpio. 2.79.0 queda con changelog, listo
para que le pongas el tag.

**Una cosa para tu criterio, no la toqué:** el sobre de **escrow**
(`index.ts:5955`, `:6164`, `:6308`, `escrow-preauth.ts:492`) arma cuerpos con
`x402Version: 2` y una clave `paymentRequirements` al lado. No es el sobre de
`/verify` y `/settle` —es el cuerpo de escrow, que el facilitador parsea aparte
(su error nombra `paymentInfo`)— así que queda fuera del alcance de este encargo
y no lo moví. Pero si el facilitador algún día unifica esos parsers, es la
siguiente piedra de la misma clase.
