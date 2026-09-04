# El cable del payload v2, cerrado en la fase 6

**Fecha:** 2026-09-04 · **Rama:** `0xultravioleta/xlang-cable-v2` (desde `origin/main`, tras el merge del PR #8)
**Encargo:** el cable que dejé listo y sin agregar en 2.79.0
(`docs/handoffs/2026-09-04-sobre-v2-huecos.md`, § Para c0der), ahora que
Python 0.75.0 está mergeada
**Gemelo del otro lado:** `uvd-x402-sdk-python`, `docs/handoffs/2026-09-04-auto-sin-network.md`

---

## QUÉ / POR QUÉ / RIESGO

**QUÉ:** la fase 6 del test de conformidad cruzada ahora manda también un payload
con forma **v2** —sin `network` de primer nivel— y compara qué sobre eligen y
construyen los dos SDK. 333 → **347 checks**, 14 cables.

**POR QUÉ:** hasta ahora todos los cables mandaban un payload plano con `network`
arriba, que es la forma v1. La forma v2 es la que reventaba en los dos SDK, y es
la que manda un comprador que sigue un 402 v2.

**RIESGO:** ninguno de producción — es solo el arnés. Lo que sí cambia es que la
fase 6 pasa a exigir **Python 0.75.0+** (antes 0.74.0+): contra un checkout más
viejo, los cables nuevos salen rojos nombrando el error, no saltan.

**Recall ping (~10s):** los dos cables nuevos verifican el mismo arreglo. ¿Por
qué el segundo (con `accepted` en nombre plano) no es redundante? Si la respuesta
no menciona que un arreglo puede *pasarse de largo*, vale leer el §2.

---

## 1. Antes de escribir: traje `origin/main` y verifiqué que no perdía nada

El PR #8 entró como **squash**, así que rebasar mi rama vieja habría duplicado
los cambios. Comprobé primero que main tuviera todo mi trabajo:

```
$ git diff --stat HEAD origin/main
---fin---            (vacío: contenido idéntico)
version en main: 2.79.0
```

Con eso, rama nueva desde `origin/main` en vez de reusar la ya mergeada.

Y confirmé Python antes de tocar el cable:

```
version en main: version = "0.75.0"
src/uvd_x402_sdk/envelope.py
68:PayloadLike = Union[PaymentPayload, Mapping[str, Any]]
78:def _network_of_payload(payload: PayloadLike) -> Optional[str]:
```

`PayloadLike` es lo que hace posible pasarle el dict crudo. Línea base con ese
checkout, antes de agregar nada: `CROSS-LANGUAGE CONFORMANCE PASSED — 333 checks`.

---

## 2. El cable, y por qué son dos

Todos los cables anteriores mandaban un payload **v1**: plano, con `network` de
primer nivel. Un comprador que sigue un 402 v2 manda lo otro —
`{x402Version, resource, accepted, payload}`, **sin `network` de primer nivel**,
porque v2 movió el chain id adentro de `accepted`. Los dos SDK reventaban ahí, y
lo arreglaron por separado con días de diferencia (2.79.0 y 0.75.0): el patrón
exacto que produjo la divergencia para la que se escribió la fase 6.

| cable | `accepted.network` | requirements | marcador | esperado |
|---|---|---|---|---|
| `v2-payload/caip2-accepted` | `eip155:8453` | `base` (plano) | 2 | **v2** |
| `v2-payload/plain-accepted` | `base` (plano) | `base` (plano) | 2 | **v1** |

El primero tiene los requirements en **nombre plano a propósito**: así un `2` solo
pudo haber salido de `accepted.network`. Es lo que separa "lee el lugar correcto"
de "se tragó el campo que falta".

El segundo no es redundante: un arreglo que tolere la ausencia podría **pasarse
de largo** y empezar a subir por el marcador. v2 no puede llevar un nombre plano
de red, así que ese cable tiene que quedarse en v1. Verificado que discriminan de
verdad, no que coinciden por casualidad:

```
TS caip2-accepted -> v2
TS plain-accepted -> v1
```

### El objeto lo arma el driver, no los agentes

Si cada agente construyera el payload v2 desde los campos planos, la forma bajo
prueba sería la que cada SDK inventa y no la que manda un comprador. El driver lo
arma una vez y los dos lo reciben verbatim.

### Lo que c0der avisó, y era cierto: no era una línea

`scripts/xlang/agent.py` armaba siempre un `PaymentPayload(...)` con `network`.
Eso es **justo el campo cuya ausencia se está probando**: construirlo ahí habría
hecho pasar el cable sin probar nada. Para este cable el agente Python pasa el
dict v2 crudo, que `resolve_envelope_version` acepta desde 0.75.0 vía
`PayloadLike`. Queda escrito en su docstring para que nadie lo "arregle" de vuelta
a un modelo.

### Y una cosa que agregué: `expectVersion`

Cada cable se calificaba comparando un SDK contra el otro. Eso atrapa una
**deriva** — pero este cable cubre un defecto que los dos tuvieron **al mismo
tiempo**, y dos runtimes regresionando juntos habrían coincidido, y pasado. Donde
la respuesta correcta se conoce, ahora se fija en vez de inferirse:

```
ok   the pinned version v2 holds for v2-payload/caip2-accepted …
ok   the pinned version v1 holds for v2-payload/plain-accepted …
```

Lo puse solo en los dos cables nuevos, que es donde el riesgo "los dos mal a la
vez" está medido y es reciente. Extenderlo a los otros 12 es una mejora aparte.

---

## 3. Probado en ROJO por los dos lados

Con el defecto **exacto** de cada SDK, no con una aproximación.

**a) TypeScript vuelto a 2.78.0** — leyendo solo el top level y con
`isCaip2Network` sin tolerar la ausencia, que es como estaba:

```
FAIL both SDKs either build or refuse v2-payload/caip2-accepted (v2 payload,
     accepted=eip155:8453 (no top-level network) / base marker=2 pin=auto)
     — ts=refused: Cannot read properties of undefined (reading 'includes') py=built
FAIL both SDKs either build or refuse v2-payload/plain-accepted (v2 payload,
     accepted=base (no top-level network) / base marker=2 pin=auto)
     — ts=refused: Cannot read properties of undefined (reading 'includes') py=built
CROSS-LANGUAGE CONFORMANCE FAILED — 2 check(s)
```

Es el `TypeError` del reporte original de MeshRelay, verbatim.

*(Nota: en un primer intento revertí solo la lectura del top level y dejé
`isCaip2Network` tolerante. Eso da `ts=v1 py=v2` — un rojo también, pero por
divergencia de versión y no por el crash. Lo repetí con el defecto completo para
que el rojo sea el defecto real y no una versión suavizada de él.)*

**b) Python vuelto a `return payload.network`:**

```
FAIL both SDKs either build or refuse v2-payload/caip2-accepted (v2 payload,
     accepted=eip155:8453 (no top-level network) / base marker=2 pin=auto)
     — ts=built py=refused: 'dict' object has no attribute 'network'
FAIL both SDKs either build or refuse v2-payload/plain-accepted (v2 payload,
     accepted=base (no top-level network) / base marker=2 pin=auto)
     — ts=built py=refused: 'dict' object has no attribute 'network'
CROSS-LANGUAGE CONFORMANCE FAILED — 2 check(s)
```

Es el `AttributeError` que el handoff de Python describe como la forma **real**
del defecto en ese lado (§1 de `2026-09-04-auto-sin-network.md`): un payload v2
no trae `network=None`, no trae el campo.

Restaurado, verde de nuevo:

```
CROSS-LANGUAGE CONFORMANCE PASSED — 347 checks across 6 phases.
  14 wires whose envelope both SDKs chose and built, compared body to body.
```

---

## 4. Estado de cierre

| Criterio | Estado |
|---|---|
| `origin/main` traído antes de escribir | ✅ §1, rama nueva desde el squash |
| El cable, con el dict v2 crudo del lado Python | ✅ §2 — y escrito en el docstring del agente |
| Probado en rojo por los dos lados | ✅ §3 — 2 rojos por lado, con el error exacto de cada SDK |
| Suite en verde | ✅ **507/507**. Typecheck y lint limpios |
| Conformidad cruzada | ✅ **347 checks / 6 fases**, 14 de 14 cables byte-idénticos |
| `git status` limpio, cero push, cero publish | ✅ 2 commits locales |

**Cómo correrla:** `UVD_X402_PY_ROOT=<checkout de python 0.75.0+> npm run test:xlang`
(con `npm run build` antes: los agentes leen `dist/`). El piso subió de 0.74.0 a
**0.75.0** por estos cables.

**Nota de operación:** usé un checkout efímero de `origin/main` de Python
extraído con `git archive` al scratchpad. El repo de Python no se tocó.

---

## Para c0der

Quedó el cable, y quedó cubriendo lo que tenía que cubrir: los dos SDK eligen y
construyen el mismo sobre a partir de un payload **v2 real** —sin `network` de
primer nivel—, y eso ahora se cae solo si cualquiera de los dos vuelve atrás.
333 → 347 checks, 14 cables, y probado en rojo por los dos lados con el error
exacto de cada uno (`Cannot read properties of undefined` en TS,
`'dict' object has no attribute 'network'` en Python).

**Tenías razón en que no era una línea.** `agent.py` armaba un `PaymentPayload`
con `network` siempre, que es el campo cuya ausencia se prueba; construirlo ahí
habría dado un cable verde que no probaba nada. Ahora pasa el dict crudo y el
porqué está en el docstring, para que no lo "arreglen" de vuelta a un modelo.

**Una cosa que agregué sin que la pidieras, y por qué:** `expectVersion` en los
dos cables nuevos. La fase 6 califica comparando un SDK contra el otro, lo cual
atrapa una deriva — pero este defecto lo tuvieron los **dos a la vez**, y dos
runtimes regresionando juntos habrían coincidido y pasado. Donde la respuesta se
conoce, ahora se fija. Son dos líneas; extenderlo a los otros 12 cables es una
mejora aparte que no metí acá.

**Dos cosas para tu criterio, ninguna tocada:**

1. **El piso de Python subió a 0.75.0.** Si algún CI o worktree apunta a un
   checkout más viejo, la fase 6 sale roja nombrando el error (no salta, que es
   el diseño). Si preferís que el cable se apague solo contra un Python viejo,
   decímelo — pero eso sería exactamente el skip silencioso que este arnés existe
   para eliminar, así que lo dejé duro.
2. **La divergencia que midió el worker de Python y me toca a mí.** Su §5: por
   `X402Client.extract_payload`, un header v2 real sale en sobre **v1** en Python
   porque `_normalize_v2_envelope` (`client.py:504`) aplana y resuelve
   `eip155:8453` → `base` antes de que la selección vea nada; TypeScript con el
   mismo header manda **v2**. Las dos son 200 hoy y reducen al mismo pago, así que
   nadie está roto. **La fase 6 no la ve** —empieza en el payload ya parseado, no
   en el header crudo— y por eso no la agregué como cable: hacerlo exigiría que
   los agentes expusieran el camino del cliente entero, que es un op nuevo y otro
   encargo. Es la única divergencia viva que queda entre los dos SDK sobre el
   sobre, y está en el camino más transitado.

**Lo que no hice:** ni push, ni publish, ni tag, ni deploy, ni subagentes. No
bumpeé versión: esto es solo el arnés, no toca el paquete publicado. 2 commits
locales en `0xultravioleta/xlang-cable-v2`, worktree limpio.
