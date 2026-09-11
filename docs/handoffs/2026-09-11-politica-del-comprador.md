---
date: 2026-09-11
tags:
  - type/handoff
  - domain/x402
  - domain/sdk-typescript
  - priority/p3
status: active
---

# La decisión de comprar se toma contra la oferta en la mano, no contra el catálogo

**Versión:** 2.89.0 · **Fase P3** del plan de precios de Astra 6, mitad TypeScript ·
**Esta fase toca dinero:** decide cuándo el SDK firma un pago y cuándo no.

El facilitador ya lo implementó en Rust (`x402-rs` PR #44, release 2.25.0, crate
`x402-reqwest`) y dejó el contrato escrito para los SDK en
`docs/handoffs/2026-09-10-bazar-precios-p3.md`, sección "El contrato para los SDK".
Este handoff es la mitad TypeScript de ese contrato. **El contrato es la fuente
única**; acá está lo que hay que saber de esta implementación y en qué se aparta,
con la razón.

## Lo que cambió

Un listado de catálogo es lo que alguien dijo de su propio precio. El `402` que
vuelve del request es la oferta, y pueden diferir legítimamente. Ahora la decisión
de comprar se evalúa contra **la oferta concreta**, siempre, antes de firmar.

**Módulo nuevo: `src/policy.ts`.** `PurchasePolicy` con los cinco campos del
contrato (`perPayment`, `cumulative`, `spent`, `onlyPay`, `allowUnlistedAssets`),
`evaluate()` que devuelve un resultado tipado, `recordSpend()` aparte, y
`decideOnChallenge()` que corre los seis pasos en el orden fijo **sin stack de red**.
Los seis códigos son una unión literal cerrada en kebab, y cada negativa lleva los
números que la causaron. Aritmética en `bigint` de punta a punta.

**Cableado en el camino real: `X402Client.fetch()`** (`src/client/X402Client.ts`).
La evaluación corre después de seleccionar la oferta y **antes** de
`createPayment()`, o sea antes de que exista una firma. Sin política configurada, el
cliente sostiene `PurchasePolicy.permissive()`.

**`parse402` se volvió tolerante Y estricta a la vez (regla 7).** `accepts` es una
lista: una entrada ilegible ya no hunde la lista, las legibles se conservan y las otras
se cuentan por nombre de esquema. Y "ilegible" ahora incluye **el esquema**: una entrada
bien formada cuyo `scheme` este camino no puede firmar queda afuera en vez de firmarse
como `exact` (ver "Lo que corrigió la revisión de seguridad"). También lee las
`extensions` del desafío, que es donde vive `validUntil`, y devuelve el desafío
**completo**.

**Un error nuevo:** `PolicyRefusedError extends X402Error` con código
`POLICY_REFUSED` y la causa tipada en `.refusal`. Extiende `X402Error` a propósito:
un consumidor que ya atrapa `X402Error` sigue atrapándolo.

## Compatibilidad: nada cambia para quien no escribe una política

Es lo primero que hay que verificar al adoptar. `X402Client` sin `policy` sostiene
`permissive()`, así que un activo sin techo declarado sigue pagándose. Este SDK no
tenía presupuesto antes de 2.89.0, y encenderlo en silencio rechazaría pagos que los
consumidores hacen hoy. La asimetría es a propósito: quien se sienta a **escribir**
una política se lleva el default seguro (`PurchasePolicy.create()` deniega).

`maxAmount` queda intacto y sigue corriendo **antes** de la política, igual que en
Rust: quien puso un techo y ninguna política conserva exactamente el comportamiento
que tenía. Un test lo fija.

Lo único que cambia sin política configurada: un `402` cuyas ofertas son **todas**
ilegibles ahora lanza `POLICY_REFUSED` / `no-readable-offer` nombrando los esquemas,
donde antes lanzaba `NO_ACCEPTABLE_PAYMENT` con "402 response offered no usable
payment options" — que es justo el mensaje que manda a alguien a buscar un bug en su
propio código. Un `402` con `accepts` vacío **conserva** `NO_ACCEPTABLE_PAYMENT`: el
vendedor no mandó ofertas, que es otro hecho.

**Y un breaking change del comprador que sí hay que leer:** un `accepts` sin `scheme`
pasó de pagable a **ilegible**, y una entrada bien formada en un esquema que este camino
no firma (`escrow`, `upto`, `commerce`, `fhe-transfer`) también. Antes las dos se
firmaban como `exact`. Está detallado abajo, en "Lo que corrigió la revisión de
seguridad".

## Donde esta implementación se aparta del Rust, y por qué

Tres cosas, ninguna cambia el contrato:

- **La clave del activo es `{ network, address }`, con la red RESUELTA.** El Rust usa
  su `TokenAsset { address, network }` con un enum de red. Acá se usa el nombre de
  cadena del SDK (`'base'`) cuando el 402 resuelve a uno, y el string crudo si no.
  Eso es lo que permite que **una** política escrita cubra los dos dialectos del 402:
  un desafío v1 dice `base` y uno v2 dice `eip155:8453`, y un presupuesto tecleado
  sobre el string crudo se perdería la mitad de las ofertas del mismo vendedor en
  silencio.
- **Una oferta que no declara `asset`** produce una dirección vacía, que ningún
  presupuesto puede contener (`perPayment` rechaza una dirección vacía), así que cae
  en `asset-not-budgeted` salvo modo permisivo. En Rust el asset siempre existe en el
  tipo; en el wire de TS es opcional. Un token sin nombre es un token que nadie
  presupuestó: es la dirección segura.
- **"Estado corrupto reporta el techo"** en Rust es el mutex envenenado. En JS no hay
  mutex, así que se traduce a lo que sí puede pasar: si la bolsa quedó con un valor
  que no es un `bigint` sano, `spent()` devuelve el límite acumulado. Misma propiedad,
  misma dirección segura. Y donde el Rust satura en overflow, acá `bigint` no
  desborda, pero un `recordSpend` negativo **se ignora**: devolver presupuesto no es
  algo que una liquidación pueda hacer, y tratarlo como tal sería ensanchar la
  política desde afuera.

**Un agregado que el Rust no tiene: `X402FetchOptions.onPaid`.** Se llama cuando el
reintento volvió con algo que no es otro `402`, o sea cuando el vendedor aceptó el
pago, y es donde quien llama hace `recordSpend`. Sin él el límite acumulado no es
usable en el camino de `fetch()`: el llamador no sabe qué activo ni qué monto
registrar. **No gasta por sí solo** — sigue siendo el llamador el que registra, y
evaluar sigue sin gastar. Si c0der prefiere no tener esa superficie, se saca y el
acumulado queda solo para quien llame `decideOnChallenge()` a mano.

## Lo que NO trae, igual que el Rust

Dicho fuerte, porque la sección 9 del plan tiene más puntos que estos:

- **Verificación de firma de `offer-receipt`.** Está el transporte y la vigencia; no
  la firma ni la autoridad del firmante. Eso necesita decidir qué clave firma una
  oferta y cómo se prueba que es la del vendedor: diseño de identidad, no un parser.
- **Vinculación por input.** La extensión versionada es el lugar; el perfil que ata
  método, parámetros y revisión de política, no.
- **Contabilidad de `upto`** y reconciliación de liquidaciones inciertas: el
  facilitador ya tiene anti-doble-cobro, nonces y `PendingNonceManager`.
- **La comprobación del facilitador** (un `settle` que no pague más que la oferta
  vigente presentada): requiere que la oferta vigente le llegue al facilitador, que
  es el punto de la firma otra vez.

## Lo que corrigió la revisión de seguridad

Un revisor independiente dejó el PR en CONDITIONAL con tres hallazgos. **Los tres eran
ciertos, y dos cambian el comportamiento del dinero.**

**P1 — el `scheme` de la oferta no decidía nada, y el PR publicaba la regla 7 como
implementada.** `parse402` solo exigía monto, payee y red, así que una oferta **bien
formada** pidiendo `batch-settlement` se leía como pagable y después se **firmaba como
`exact`** (el constructor de payload estampa ese literal), o sea un pago ofrecido al
vendedor bajo un esquema que nunca pidió. Y mis dos tests de ilegibles usaban entradas
a las que les **faltaban campos**, así que probaban que los campos faltantes se
detectan — no la regla 7. El revisor tenía razón en las dos mitades: el arreglo y la
crítica al test.

Es el error inverso al que tuvo Rust. Allá un enum cerrado actuando de colección
abierta **rechazaba de más** (una entrada ilegible tumbaba la lista entera); acá el
parseo permisivo **aceptaba de más**. Las dos son la misma confusión entre reconocer y
poder pagar, en direcciones opuestas.

Ahora hay **dos conjuntos**, y esto es lo que no hay que colapsar:

- `KNOWN_SCHEMES` = `exact`, `upto`, `escrow`, `commerce`, `fhe-transfer` — el
  vocabulario compartido con el enum cerrado de `x402-rs` y con `KNOWN_SCHEMES` de
  Python.
- `CLIENT_PAYABLE_SCHEMES` = `exact` — lo que **este** camino puede firmar.

Con los cinco como pagables, una oferta `escrow` bien formada se vuelve a firmar como
`exact`. Hay un test que fija los dos conjuntos y que se pone rojo si se colapsan.

**El `scheme` ausente ahora es ilegible, como en Rust** (decisión de c0der, alineación
de los tres SDK). Rust exige el campo; un comprador que adivinara `exact` firmaría bajo
un esquema que el vendedor nunca nombró. Se cuenta sin nombre, porque no tiene ninguno.
**Es asimétrico a propósito con el lado vendedor de este mismo SDK**
(`src/backend/index.ts:1567`: "'exact' is the default, not an override"): un vendedor es
indulgente con lo que acepta, un comprador es estricto con lo que firma.

> **Dato para c0der, medido:** los 13 fixtures de `accepts` de la suite declaran
> `scheme`, así que **nada se rompió** — pero eso no prueba que ningún vendedor real lo
> omita, y el cambio **es observable**: un `402` sin `scheme` pasa de pagable a
> impagable por este camino. Si aparece un vendedor así, la reversión es una línea
> (`accept.scheme ?? 'exact'`) y hay un test que marca la decisión.

**P2 — la política aprobaba un activo y el firmante firmaba otro.** `evaluate()` juzga
el `asset` de la oferta; `createPayment()` firma el token al que resuelve `tokenType`
en esa cadena y lee el precio con **los decimales de ese** token. Con USDC en los dos
lados coinciden, que es por lo que no se vio en ningún test. Un vendedor cotizando en
otro token daba **aprobación sobre A y firma sobre B**, y quien llamaba creía tener un
presupuesto que nunca se aplicó.

Ahora una oferta que nombra un activo distinto al de `tokenType` se rechaza
(`NO_ACCEPTABLE_PAYMENT`, con los dos addresses en el mensaje) en vez de re-apuntarse
en silencio: con qué token pagar es decisión de quien llama, y adivinarlo del `402` del
vendedor es cómo una wallet firma por un token que nadie eligió. Corre **después** de
la política, para que un activo no presupuestado siga reportándose como
`asset-not-budgeted` — la causa útil. La comparación es canonicalizada: un USDC en
minúscula frente al registro en checksum no es un desalineo, y hay un test para eso
porque refutar ahí rompería pagos legítimos.

**P3 — `assetKey` no normalizaba la caja de la red.** `'Base'` contra `'base'` fallaba
cerrado (`asset-not-budgeted`, ningún pago malo) pero tropieza al operador con una
mayúscula, y la negativa apuntaría al presupuesto en vez de al typo. La red se pliega a
minúscula; la **dirección** conserva su trato por familia.

**Se mantiene la resolución CAIP-2 → nombre del SDK al armar la clave del activo** (es
la que Python va a adoptar): la clave usa `chainName` resuelto, así que una política
escrita con `'base'` cubre tanto un `402` v1 que dice `base` como uno v2 que dice
`eip155:8453`.

## Cómo se probó

**40 tests nuevos** en `src/policy.test.ts`, y **17 probados en rojo por mutación**:
cada propiedad se verificó rompiendo el código a propósito y midiendo que el test
correspondiente se pone rojo. Las mutaciones y sus veredictos:

| mutación | test que se pone rojo |
|---|---|
| cable de `extensions` roto (el bug que Rust tuvo un commit entero) | oferta vencida por el camino real |
| la evaluación no corre antes de firmar | activo no presupuestado por el camino real |
| `canonicalRecipient` pliega todo con `toLowerCase` | base58 exacto vs hex plegado |
| `validUntil == now` se trata como vencido | `validUntil === now` todavía vale |
| `validUntil` ilegible se lee como cero | ilegible no vence la oferta |
| una copia lleva su propia bolsa | copia comparte bolsa |
| evaluar gasta | evaluar no gasta |
| `asset-not-budgeted` después del techo por pago | orden de evaluación |
| `accepts` ilegible no se cuenta por esquema | nombra los esquemas ofrecidos |
| bolsa corrupta reporta cero | reporta el techo, nunca cero |
| `recordSpend` negativo devuelve presupuesto | negativo se ignora |
| no se valida el `scheme` en `parse402` (P1) | oferta bien formada en esquema no pagable |
| pagable = los cinco conocidos (colapsar los dos sets) | los dos conjuntos de esquemas |
| `scheme` ausente se adivina como `exact` | ausente es ilegible |
| no se alinea el activo aprobado con el firmado (P2) | nunca firma un activo tras aprobar otro |
| el activo se compara sin canonicalizar | paga el token configurado en minúscula |
| la caja de la red decide (P3) | la caja del nombre de red no decide |

**Dos entran por el camino real** (`client.fetch()` con `fetch` mockeado devolviendo
el 402), y esa es la lección que el handoff del facilitador dejó explícita: en Rust el
cable que llevaba las `extensions` del desafío a la política faltó un commit entero
con **todos los tests unitarios en verde**, así que el vendedor declaraba
`validUntil`, la política sabía comprobarlo, y entre las dos no había cable. Un test
que solo ejerce la pieza no ve eso.

**Suite completa: 681/681 verde** (40 en `policy.test.ts`, y **17 mutaciones** probadas
en rojo contando las seis de la revisión de seguridad). `typecheck` limpio, `lint` limpio, `build` OK.

**`npm run test:xlang` no se pudo correr acá**: el gate necesita el checkout de
`uvd-x402-sdk-python` al lado, que no existe en este worktree. El CI lo corre en un
job aparte que lo clona. **No debería verse afectado**: ese gate compara firmas,
envelopes y precios entre los dos SDK, y esta versión no toca ninguna firma —
`src/policy.ts` es lado comprador y decide **antes** de firmar, sin tocar el payload.

## Para c0der

### Qué cambió

| archivo | qué |
|---|---|
| `src/policy.ts` | **nuevo** — `PurchasePolicy`, los seis códigos, `decideOnChallenge`, `offerValidUntil`, `canonicalRecipient` |
| `src/policy.test.ts` | **nuevo** — 40 tests, 17 probados en rojo por mutación |
| `src/client/X402Client.ts` | `parse402` tolerante + valida el `scheme` + lee `extensions`; `KNOWN_SCHEMES` y `CLIENT_PAYABLE_SCHEMES`; evaluación antes de firmar y alineación del activo en `fetch()`; getter `policy` |
| `src/types/index.ts` | `POLICY_REFUSED`; `X402ClientConfig.policy`; `X402FetchOptions.advertised` y `.onPaid` |
| `src/index.ts` | exports de la política |
| `package.json` | 2.88.0 → **2.89.0** |
| `CHANGELOG.md`, `README.md` | el contrato: tabla de campos, orden, códigos, las siete reglas |

`origin/main` estaba en 2.88.0 (commit `48519e0`), que es lo publicado en npm, así
que el bump minor va a **2.89.0**. El checkout del dueño en
`Z:/ultravioleta/dao/uvd-x402-sdk-typescript` estaba sucio y con `package.json` en
2.89.0 sin publicar: **no se usó como referencia** y este worktree salió de
`origin/main`. Si ese 2.89.0 local resulta ser trabajo distinto que después se
mergea, hay que resolver el choque de versión ahí, no acá.

### Qué NO cambió

- **La firma de `offer-receipt` no se verifica.** Solo transporte y vigencia, igual
  que el facilitador. Adoptar media extensión y decirlo es más reversible que inventar
  la otra mitad.
- **Vinculación por input: fuera.** La extensión versionada es el lugar; el perfil
  queda sin definir a propósito hasta que haya un vendedor real que lo necesite.
- **`upto`: fuera.** Está en `KNOWN_SCHEMES` porque es parte del vocabulario
  compartido, pero **no es pagable por este camino** y no hay ninguna contabilidad de
  `upto` en esta versión.
- **Nada se persiste.** La política vive en memoria del comprador y no se escribe.
- **Ningún payload de pago cambió.** Cero impacto en el facilitador, en los vectores
  ERC-8128 y en el gate cross-language.

### El tag y la publicación

**Este worker no publicó nada y no creó el tag.** Después del merge, c0der tagea
`v2.89.0` sobre el commit de merge: `.github/workflows/publish.yml` dispara con el
tag. Si `npm publish` da `E404`, es el `NPM_TOKEN` vencido, no un 404 real —
regenerar el token de Automation y actualizar el secret de GitHub.

### Qué tienen que hacer los consumidores para adoptarla

Ninguno **tiene** que hacer nada: sin `policy`, el comportamiento es idéntico al de
hoy. Pero cada uno de estos hoy inventa su propia respuesta a "¿cuánto es demasiado?",
y esa respuesta ahora vive en un lugar con seis causas nombradas:

- **EM dashboard / xmtp-bot** — es el que más gana: un bot que compra sin supervisión
  es exactamente el caso donde un techo acumulado importa. Escribir
  `PurchasePolicy.create().perPayment(USDC_BASE, ...).cumulative(USDC_BASE, ...)`,
  pasarla al `X402Client`, y usar `onPaid` para `recordSpend`. **Ojo con el acumulado
  y el ciclo de vida del proceso**: la política vive en memoria, así que un reinicio
  la resetea. Si el techo acumulado tiene que sobrevivir un reinicio, eso es
  persistencia del lado del consumidor y no del SDK (y es un buen item de backlog
  para el SDK, con el estado inyectable).
- **402milly frontend** — `onlyPay([...])` con las wallets del marketplace es la parte
  que le sirve más: un 402 que apunta a un payee que no es el del marketplace es
  justamente lo que no hay que firmar. Y si el frontend ya lee el catálogo, pasar
  `advertised` le da la divergencia reportada gratis, sin que decida nada.
- **meshrelay** — si compra rutas pagas, `perPayment` acotado y `create()` (no
  `permissive()`) para que un activo que nadie presupuestó se niegue en vez de
  firmarse.
- **Cualquiera que hoy atrape `X402Error` con `code === 'NO_ACCEPTABLE_PAYMENT'`**
  para el caso "no pude leer las ofertas": ese caso ahora llega como
  `POLICY_REFUSED` / `no-readable-offer`, con los nombres de esquema en
  `err.refusal.offered`. El caso "el vendedor no mandó ofertas" **no cambió**.

Y la regla que más fácil se rompe al adoptar: **`recordSpend` es una llamada aparte**.
Un consumidor que espera que el acumulado se mueva solo va a creer que tiene un techo
que no tiene. Evaluar no gasta a propósito — firmar puede fallar y una liquidación
puede rechazarse, y un límite que contara intentos dejaría al consumidor sin dinero
que nunca gastó.
