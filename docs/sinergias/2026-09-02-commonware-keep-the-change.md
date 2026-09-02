# Sinergias con "Keep the Change" (Commonware) — 3.3 uvd-x402-sdk-typescript

> Depositado por c0der el 2026-09-02. Fuente: `c0der/docs/plans/commonware-clearing-que-adoptar.md`
> (análisis de los 15 proyectos x402 del stack: 66 sinergias propuestas, 40 sostenidas por un refutador
> que abrió cada `archivo:línea`; las descartadas y su motivo están en la sección 4 del documento fuente).
> Post original: <https://commonware.xyz/blogs/clearing> (Patrick O'Grady, 2026-08-19). Esta carpeta
> `docs/sinergias/` es donde c0der deja lo que otros análisis encuentren para este proyecto.

## Principios transversales que aplican a todo el stack (títulos; el detalle está en la fuente, sección 2)

- P1 · La preconfirmación es un par firmado transferible, no un booleano
- P2 · El reintento devuelve el mismo recibo, y la clave se DERIVA de la identidad del pedido
- P3 · Una escritura cara por cuenta cambiada, no por evento
- P4 · La retención de evidencia se ata a la ventana de disputa — y la ventana no existe
- P5 · La ventana de idempotencia y la de retención de evidencia son dos relojes
- P6 · Disputa de un solo tiro: el que reclama presenta el par, y un predicado lo resuelve
- P7 · Un piso es seguro para gastar; el estado que se reconcilia tarde se ajusta, nunca se sobrescribe
- P8 · El benchmark declara qué variable NO aparece
- P9 · El identificador de deduplicación lo pone quien ya lo usa, no vos *(no sale del post)*
- P10 · Cada componente declara su postura ante fallo en su propio doc-comment *(no sale del post)*
- P11 · El valor efectivo de un parámetro se publica en un endpoint legible *(regla del CLAUDE.md global, no del post)*

## Lo específico de este proyecto (sección 3.3 de la fuente, verbatim)

### 3.3 uvd-x402-sdk-typescript

| Idea (sección del post) | Aplicación concreta | archivo:línea | Esf. | Valor | Riesgo | Cómo se verifica |
|---|---|---|---|---|---|---|
| Reintento idempotente ("Payments as Fast as Browsing the Web") | Agregar `Idempotency-Key` en el camino que el SDK **ya** considera replayable | `src/backend/facilitator-error.ts:230-247` (429 / 503-de-lease = replay seguro; `forward_failed`/timeout = puede estar minando), reintento en `:322-330`; `settle()` en `src/backend/index.ts:794`, `:866-874` | **S** | alto | bajo | `src/backend/writer-lease-503.test.ts` ya ejercita el replay: afirmar que las dos llamadas llevan la **misma** clave (`npm test`, vitest) |
| El par transferible ("Payments as Fast as Browsing the Web") | Que el middleware devuelva `proofOfPayment` al buyer en el header `PAYMENT-RESPONSE` | conservado en `index.ts:861`; el header solo existe como nombre en CORS (`:595`, `:605-606` — verificado hoy: las 3 únicas apariciones); destino real: `createPaymentMiddleware` (`:1547`) y `createHonoMiddleware` (`:1690`) | M | alto | bajo | Test de middleware: una respuesta paga lleva `PAYMENT-RESPONSE` con `tx` y `proofOfPayment`, y un cliente lo verifica sin llamar al facilitador |

**Notas.** (1) La clave tiene que ser constante **entre** reintentos del mismo settle
lógico: `facilitatorFetch` reintenta adentro (`:322-330`), así que se construye en
`settle()` y se pasa hacia abajo, **nunca dentro del bucle**. (2) **La forma de
`PAYMENT-RESPONSE` no se inventa**: ya hay productor y consumidor vivos en el stack —
`karmakadabra/terraform/x402-seller/lambda/x402_seller.py:250-254` la emite (verificado hoy:
base64 de `{success, transaction, network, payer}`) y `karmakadabra/agents_sdk/uvd_buyer.py:519-528`
la lee. Se copia ese formato.
