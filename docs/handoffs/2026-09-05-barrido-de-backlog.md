# Barrido de backlog en el SDK TypeScript — 2026-09-05

Rama `0xultravioleta/tx-backlog`. Tres commits, tres filas resueltas, cinco
cerradas por vencidas, tres que necesitan al dueño.

---

## Lo primero, porque cambia el resto: este repo NO tiene backlog

El encargo decía "ubica el backlog de este repo, suele ser
`docs/planning/BACKLOG.md`". Acá no existe, ni con ese nombre ni con otro:

```
find . -path ./node_modules -prune -o -iname "*backlog*" -print   ->  (vacío)
ls docs/                                                          ->  carrusel-de-pago-compartido.md  handoffs/
```

Y no es un descuido de nombre: el registro del coordinador clasifica a este repo
como **informe**, no como cola. De las 60 colas de `data/backlogs.json` (barrido
de hoy 12:34Z), ninguna vive acá; la única entrada del repo está en la sección
`informes`, y es un handoff.

**La cola que sí manda sobre este repo es la del coordinador**,
`docs/planning/BACKLOG.md` en c0der, que tiene 20 filas mencionando el SDK
TypeScript. Ese es el backlog que barrí. Las referencias `L<n>` de abajo son
números de línea de ese archivo.

**No lo edité.** `git worktree list` en c0der muestra un worktree
`0xultravioleta/c0-backlog` abierto: hay otra sesión adentro del backlog y no
piso lo que no es mío. Las columnas de estado que hay que escribir van
transcritas literales más abajo, listas para pegar.

---

## Filas resueltas (3)

### L212 · P1 · `X402Client.fetch()`, el buyer loop — commit `bc84d59`

La fila decía "falta paridad TypeScript (src/client sin el buyer loop)". **La
premisa era correcta** y la verifiqué antes de escribir nada:

```
grep -rn "status === 402" src/ --include="*.ts" | grep -v "\.test\."   ->  0 líneas
grep -rn "fetchWithPayment|withPayment|payAndRetry|autoPay" src/       ->  0 líneas
```

El cliente sabía firmar un pago y no sabía pedirlo, así que cada consumidor
escribió el mismo bucle a mano y cada copia inventó su propia respuesta a
"cuánto es demasiado".

```ts
await client.connectWithPrivateKey(key, 'base');
const res = await client.fetch(url, { maxAmount: '0.05' });
```

`maxAmount` es techo duro: un 402 que pide más lanza `PAYMENT_EXCEEDS_MAX` y no
firma nada. Tres defectos que el bucle tenía que resolver: los dos dialectos del
402 (v1 `maxAmountRequired` + nombre de cadena, v2 `amount` + CAIP-2), la
versión la dice el recurso y no la config (`x402Version: 'auto'` era el default
documentado y **siempre salía v1**), y los decimales por cadena al comparar
ofertas (el USDC de BSC tiene 18 y leerlo a 6 elige mal la más barata).

**Los dos estados, como pide el encargo:**

```
SIN el cambio (git checkout de src/client/X402Client.ts y src/types/index.ts):
   Test Files  1 failed (1)
        Tests  16 failed (16)     TypeError: client.fetch is not a function

CON el cambio:
   Test Files  1 passed (1)
        Tests  16 passed (16)
```

"No existe la función" no prueba que los tests midan comportamiento, así que
inyecté dos defectos uno a uno sobre el código ya escrito:

| Defecto inyectado | Test que se pone rojo |
|---|---|
| `offerDecimals()` devolviendo siempre 6 | `picks the cheapest offer across chains with different decimals` |
| `version = this.config.x402Version === 2 ? 2 : 1` (ignorar el hint del 402) | `reads a v2 CAIP-2 challenge and retries with a v2 payload` |

```
Test Files  1 failed (1)    Tests  2 failed | 14 passed (16)
```

Cada defecto mata exactamente su test y ningún otro.

### L323 · P2 · `generatePaymentOptions` multi-token — commit `5c6d52e`

Reproducido contra el dist publicado antes de tocar nada:

```
generatePaymentOptions([getChainByName('base')],'5')  ->  1 opción
Object.keys(getChainByName('base').tokens)            ->  ['usdc','eurc']
```

**Refuto la forma del arreglo que la fila insinúa.** "Emitir todos los tokens que
el registro conoce" no es un arreglo, es una regresión de plata: este arreglo
termina siendo el `accepts` de un 402, o sea que cada entrada es una moneda que
el vendedor aceptó públicamente cobrar, a `amount` unidades de ella. Un vendedor
que puso precio en dólares y de repente también acepta 5 EURC está vendiendo a
un tipo de cambio 1:1 EUR/USD que nadie acordó, y el comprador elige el lado que
le convenga.

Así que `tokens` es opt-in y el default sigue siendo `['usdc']`:

```ts
generatePaymentOptions([base], '5.00');                             // igual que antes
generatePaymentOptions([base], '5.00', undefined, ['usdc','eurc']); // ambas, explícito
```

```
SIN el cambio:  Tests  2 failed | 3 passed (5)
                -> "expected [...] to have a length of 2 but got 1"  (x2)
CON el cambio:  Tests  5 passed (5)
```

Los 3 que pasan en los dos estados son deliberados: prueban que no hubo
regresión (default USDC-only devuelve 25 opciones sobre las 25 cadenas
habilitadas; override de facilitator; cadena deshabilitada se salta). Un test
que pasa antes y después es el único que puede probar eso.

Honestidad sobre un cuarto test: el de decimales de BSC también pasa en los dos
estados, porque el código viejo usaba `chain.usdc.decimals` y para BSC eso da 18
igual. Es un guard, no un discriminante, y así queda dicho.

### L322 · P2 · CHANGELOG, una entrada por tag — commit `2d37319`

**Dos correcciones a la fila.** Primero, son más de las que dice: la fila nombra
12 versiones y faltaban **19** dentro del alcance del archivo — además de las
suyas, faltaban v2.55.0–v2.59.0, v2.77.0 y **v2.81.0**, que era la versión que el
propio `package.json` tenía cuando empecé.

Segundo, **no son 25**, que es lo que conté yo en la primera medición y estaba
mal: el preámbulo del archivo declara su propio piso ("starting at v2.47.0"), así
que v2.42.0–v2.46.0 están fuera de alcance a propósito y no son un hueco.

```
antes: 19 tags >=2.47.0 sin entrada
ahora: NINGUNO
git diff --numstat CHANGELOG.md  ->  121  0   (cero borrados: ninguna entrada
                                               existente se tocó)
```

Un caso raro quedó dicho en vez de tapado: v2.74.0 no es ancestro de v2.75.0, así
que el tramo trae 133 commits; esa entrada da el commit del tag y manda al rango.

---

## Filas cerradas porque YA ESTABAN hechas (5)

El encargo avisaba que la tasa de filas vencidas es alta. Lo es: **cinco de las
ocho filas accionables de este repo ya estaban resueltas** y seguían mandando
gente a trabajar de gratis.

### L30 · P1 · estado escrito: `Listo para despachar`

> `grep -c "payloadShape: 'v2'" scripts/xlang/cross-language-conformance.mjs` → **2**
> `git log --oneline -1 -S "payloadShape: 'v2'" -- scripts/xlang/cross-language-conformance.mjs` → **e168dfa**

El cable ya está puesto en dos casos de `ENVELOPE_CASES`. Lo agregó el PR #9.

### L319 · P1 · estado escrito: `pendiente`

Esta tenía tres condiciones de cierre y **las tres se cumplen**:

| Criterio de la fila | Comando | Resultado |
|---|---|---|
| `FacilitatorClient.verify/settle` aceptan payload v2 con test | `grep -n "buildVerifyRequestForVersion\|buildSettleRequestForVersion" src/backend/index.ts` | `1008:` y `1066:`, dentro de `verify()` y `settle()`; tests en `src/backend/v2-envelope.test.ts` |
| versión publicada | `npm view uvd-x402-sdk version` | `2.81.0` |
| `turnstile/payments.js` sin `postV2` | `grep -rn "postV2\|verifyV2" meshrelay/turnstile/ --include="*.js"` | **0 líneas** (el archivo existe, 27 KB, y ya usa `FacilitatorClient` del SDK en dos instancias, v1 y v2) |

La fila decía "el bump a 2.76.0 NO arregla el doble cobro en el camino v2". Hoy
sí está arreglado, de las dos puntas.

### L311 · P0 · estado escrito: `DONE (consumidores en commit local; push pendiente)`

> `npm view uvd-x402-sdk version` → **2.81.0**

Publicado y cinco minors por delante de lo que la fila pedía.

### L35 · P1 · estado escrito: `Parcial` — la mitad TypeScript

> `resolveEnvelopeVersion(payload_sin_network, {network:'eip155:8453'}, 'auto')` → **2**, sin `TypeError`

El lado TS está arreglado y sigue arreglado después de mis cambios. **La mitad de
Python es la que queda viva**, y esa fila no es de este repo.

### L169 · P2 · estado escrito: `Medido`

La fila dice "la versión de referencia del SDK se movió por quinta vez" y cita
2.70.0. Hoy npm dice 2.81.0 y el disco dice 2.83.0 después de estos commits. Es
una fila que se vence sola cada dos días; su valor era la lección que ya está
escrita en ella (ninguna cifra de versión aguanta un día en prosa), no el número.

---

## Filas que necesitan al dueño (3) — NO las toqué

### L345 · P1 · La ventana de validez y el checksum del destinatario

Los dos SDK no arman el mismo header. Sigue vivo y **medido hoy**:

> `src/client/X402Client.ts:798` → `const validityWindowSeconds = chain.name === 'base' ? 300 : 60;`
> contra `valid_duration=3600` en el SDK Python.

Un pago firmado en Python vive una hora; el mismo en TypeScript, un minuto.
**Cuál es la ventana correcta es decisión de producto, no mía** — y la fila ya lo
dice. Lo que sí parece unilateral es el checksum del destinatario (TS normaliza,
Python no); esa mitad se puede subir a Python sin preguntar.

Para desbloquearla hace falta: qué ventana quiere el dueño para meshrelay, y cuál
de los dos SDK se alinea al otro.

### L192 · P1 · Los 3 gates del dueño de la tanda 2

Externos e irreversibles por definición. Sin cambios de mi lado.

### L316 · P0 · Push de los manifiestos + 402milly paso 3 + decisión tumblrfi

Necesita OK de push explícito y una compra real. Fuera de alcance de un worker.

---

## Hallazgos nuevos que no estaban en ninguna fila

1. **`2.67.0` tiene entrada en el CHANGELOG y no tiene tag en git.** Es el
   defecto espejo de L322. No lo arreglé: crear un tag retroactivo es escribir
   historia, y eso lo decide el dueño.

2. **Un guard que ate el CHANGELOG a los tags necesita `fetch-depth: 0`.** La CI
   usa `actions/checkout@v4` sin profundidad, o sea checkout shallow sin tags: un
   test que compare contra `git tag` se saltaría siempre y no protegería nada.
   Tocar un pipeline que funciona no entra en este encargo (regla anti-scope-creep
   del stack), así que queda propuesto y no hecho. Sin él, L322 se reabre en el
   próximo release.

3. **`turnstile` está pineado en `uvd-x402-sdk` 2.78.0**, tres minors atrás de lo
   publicado. No es urgente — 2.78.0 ya trae el arreglo del sobre v2 — pero es
   drift que ningún barrido de manifiestos parece estar contando.

4. **BSC va `x402.enabled: false` de fábrica** y su USDC tiene 18 decimales. Está
   bien así (ese USDC no soporta EIP-3009), pero sorprende a cualquiera que
   escriba un test asumiendo que toda cadena del registro se puede pagar.

5. **L244 está parcialmente vencida.** Afirma que ninguno de los cuatro repos de
   SDK tiene `docs/plans`, `docs/reports` ni `docs/handoffs`; este repo **sí tiene
   `docs/handoffs`**, con 4 archivos antes de este. Lo demás de esa fila sigue
   siendo cierto: no hay `CLAUDE.md`, ni `docs/plans`, ni `docs/reports`, ni
   `docs/planning`.

6. **Upstream-first pendiente hacia Python.** Mi buyer loop manda el payload bajo
   **los dos** nombres de header en v2 (`X-PAYMENT` y `PAYMENT-SIGNATURE`); el
   `fetch` de Python manda sólo `X-PAYMENT`. Es una mejora que va **de acá para
   allá**, y no al revés: no bajar nada de Python hasta que su lado lo tenga.

---

## Estado de la suite

| Momento | Resultado |
|---|---|
| Línea base, esta rama sin tocar | **525 passed / 30 archivos** — cero rojos preexistentes |
| Después de L212 | 541 passed / 31 |
| Después de L323 | **546 passed / 32** |

`npm run typecheck`, `npm run lint` y `npm run build`: limpios en cada paso.

Working tree del repo: **limpio** al empezar (verificado con `git status
--porcelain`, sin salida). Nadie más estaba adentro de este repo.

---

## Columnas de estado, listas para pegar en el backlog del coordinador

No las escribí yo porque hay otra sesión en el worktree `c0-backlog`.

| Fila | Estado nuevo propuesto |
|---|---|
| L30 | `CERRADA 2026-09-05: ya estaba. grep -c "payloadShape: 'v2'" scripts/xlang/cross-language-conformance.mjs = 2, agregado en e168dfa (PR #9).` |
| L319 | `CERRADA 2026-09-05: los 3 criterios se cumplen. verify/settle usan buildVerify/SettleRequestForVersion (src/backend/index.ts:1008,1066) con tests en v2-envelope.test.ts; npm view uvd-x402-sdk version = 2.81.0; grep postV2 en meshrelay/turnstile/*.js = 0 lineas, payments.js ya usa FacilitatorClient v1+v2.` |
| L311 | `CERRADA 2026-09-05: npm view uvd-x402-sdk version = 2.81.0, cinco minors por delante de lo pedido.` |
| L35 | `Parcial -> la mitad TS CERRADA 2026-09-05: resolveEnvelopeVersion con payload sin network de primer nivel y version 'auto' devuelve 2 sin TypeError, medido sobre el dist. Queda viva solo la mitad Python.` |
| L169 | `CERRADA 2026-09-05 por vencimiento: npm 2.81.0, disco 2.83.0. La leccion ya esta escrita en la fila; el numero no se vuelve a escribir.` |
| L212 | `CERRADA 2026-09-05: X402Client.fetch() en 2.82.0, commit bc84d59. 16 tests, rojos sin el cambio y verdes con el, mas 2 defectos inyectados que matan un test cada uno.` |
| L323 | `CERRADA 2026-09-05: 2.83.0, commit 5c6d52e. tokens es OPT-IN (default ['usdc']) porque emitir todo el registro cambia la moneda de cobro en silencio; 2 tests rojos antes y 5 verdes despues.` |
| L322 | `CERRADA 2026-09-05: commit 2d37319, 19 tags sin entrada (no 12) llevados a cero; v2.42-2.46 estan fuera de alcance por el preambulo del archivo. Se reabre en el proximo release sin fetch-depth: 0 en la CI.` |
| L244 | `Parcialmente vencida 2026-09-05: uvd-x402-sdk-typescript SI tiene docs/handoffs (5 archivos). Sigue sin CLAUDE.md, docs/plans, docs/reports ni docs/planning.` |

---

## Para c0der

1. **Cinco filas cerradas por vencidas** (L30, L319, L311, L35-mitad-TS, L169) —
   cuatro de ellas P0/P1 que estaban mandando gente a trabajo ya hecho; L319 tenía
   sus tres criterios cumplidos, incluida la mitad de meshrelay.
2. **Tres filas arregladas** (L212 P1 buyer loop, L323 P2 multi-token, L322 P2
   changelog), cada una con su commit, su test discriminante corrido en los dos
   estados, y `generatePaymentOptions` refutada: el arreglo obvio era una
   regresión de plata.
3. **Tres necesitan al dueño**: L345 (qué ventana de validez es la correcta y cuál
   SDK se alinea), L192 (los 3 gates) y L316 (OK de push + compra real de
   402milly). No toqué ninguna.
4. **El PR queda listo para revisar y NO lo mergeo yo.** Suite 546/546 verde,
   typecheck/lint/build limpios, cero rojos preexistentes. Ojo con dos cosas antes
   de mergear: este repo **no tiene backlog propio** (la cola vive en el tuyo), y
   L322 se reabre en el próximo release salvo que decidas poner `fetch-depth: 0`
   en la CI.
