# SDKTS-DURABLE: post-hook durable en los paywalls

## Estado

- Hecho: opcion opt-in `durable` en `PaymentMiddlewareOptions` (Fetch, Hono, Express), modulo
  `src/backend/durable.ts`, tests `src/backend/durable-evidence.test.ts` (32), README y CHANGELOG.
- Hecho: rojo sobre la base `6a7a2798e` (20 de 28 tests del archivo nuevo caen; los otros 8 son
  los casos "no ancla", que en la base pasan por ausencia del hook) y verde con el arreglo.
- Hecho: mutaciones M1..M23 (22 caen, M22 equivalente; ver PR).
- Falta: revision adversarial, merge de origin/main, pre-CI completo, push y PR.
- Proximo paso: abrir el PR unico y esperar al refutador de c0der. No mergear.

## Decisiones

- `payerKey` es una funcion `({ payment, settle }) => Uint8Array | undefined`: la clave del
  pagador depende de la firma de cada pago. `undefined` = aviso `payer_key_unavailable`.
- Se ancla solo con `settle.success === true` y `transactionHash` no vacio del mismo request.
- Limites: `maxBodyBytes` (default `ANCHOR_MAX_REQUEST_BYTES`, 64 KiB) y `timeoutMs`
  (default 5000, maximo 2^31-1). Fuera de limites: respuesta intacta, aviso `skipped`, cero anchors.
- El cifrado y el anchor son los de `anchorEvidence` (`src/dx402.ts`); no hay cifrado nuevo.
- No se tocan firmas de escrow.

## Riesgos conocidos

- Tras el deadline la respuesta sale con aviso `timeout`; un `sign`/`upload` aun en vuelo no
  puede enviar el anchor (el fetch del anchor rechaza con la senal abortada).
- Express: los bytes se retienen hasta `end()` o hasta el limite; `write` capturado devuelve `true`.
