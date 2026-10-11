# SDKTS-DURABLE: post-hook durable en los paywalls

## Estado

- Hecho: opcion opt-in `durable` en `PaymentMiddlewareOptions` (Fetch, Hono, Express), modulo
  `src/backend/durable.ts`, tests `src/backend/durable-evidence.test.ts`, README y CHANGELOG.
- Hecho: ronda 1 de REF-SDKTS-53 (head refutado `78d5923`): P1-1 (Express sellado durante el anchor),
  P2-1 (aislamiento por request, secuencial y concurrente en las 3 superficies), P2-2, P2-3 (y el arreglo:
  los bytes previos al error ahora llegan; antes `controller.error` vaciaba la cola), P2-4 (recibo
  `pending`/`unknown`/`rejected`), P2-5 (`no_payer_key`, vocabulario documentado), P3 D8/D9/D11 y el
  ejemplo de `payerKey` del README (verificado por test con firma sintetica).
- Hecho: el archivo de tests pasa 47/47; sobre `78d5923` caen 6 de los nuevos (ver PR).
- Falta: nueva refutacion de c0der. No mergear, no publicar.
- Proximo paso: atender lo que devuelva el refutador en la misma rama.

## Decisiones

- `payerKey` es una funcion `({ payment, settle }) => Uint8Array | undefined`: la clave del
  pagador depende de la firma de cada pago. `undefined` o vacia = aviso `no_payer_key`.
- Se ancla solo con `settle.success === true`, `replayed !== true` y `transactionHash` no vacio
  del mismo request: un settle repetido no genera un segundo anchor del mismo pago.
- Limites: `maxBodyBytes` (default `ANCHOR_MAX_REQUEST_BYTES`, 64 KiB) y `timeoutMs`
  (default 5000, maximo 2^31-1). Fuera de limites: respuesta intacta, aviso `skipped`, cero anchors.
- El cifrado y el anchor son los de `anchorEvidence` (`src/dx402.ts`); no hay cifrado nuevo.
- No se tocan firmas de escrow.

## Riesgos conocidos

- Tras el deadline la respuesta sale con aviso `timeout`; un `sign`/`upload` aun en vuelo no
  puede enviar el anchor (el fetch del anchor rechaza con la senal abortada).
- Express: los bytes se retienen hasta `end()` o hasta el limite; `write` capturado devuelve `true`.
  Entre `end()` y la respuesta del anchor (maximo `timeoutMs`) `res` se ve enviado; un `write` tardio
  se rechaza como write-after-end.
- Sin presupuesto agregado de memoria en vuelo (Rust `max_inflight_bytes`): fuera de esta ronda.
- Default `maxBodyBytes` 64 KiB de texto plano vs. tope de 64 KiB del request sellado en modo `direct`:
  un cuerpo de ~47-64 KB termina en `too_large` tras retenerse. Fuera de esta ronda.
