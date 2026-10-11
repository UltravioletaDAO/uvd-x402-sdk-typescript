# SDKTS-DURABLE: post-hook durable en los paywalls

## Estado

- Hecho: opcion opt-in `durable` en `PaymentMiddlewareOptions` (Fetch, Hono, Express), modulo
  `src/backend/durable.ts`, tests `src/backend/durable-evidence.test.ts` (33), README y CHANGELOG.
- Hecho: rojo sobre la base `6a7a2798e` (20 de 28 tests del archivo nuevo caen; los otros 8 son
  los casos "no ancla", que en la base pasan por ausencia del hook) y verde con el arreglo.
- Hecho: mutaciones M1..M24 (23 caen; M22, el filtro HEAD de Express en `index.ts`, es
  equivalente: `wantsEvidence` ya excluye HEAD; ver PR).
- Hecho: pre-CI local sobre `origin/main` `6a7a2798e` (sin cambios desde el despacho): typecheck,
  1740 tests, lint, build, pack, carga de OWS, derive-erc8128 --check y conformance cross-language.
- Falta: refutacion de c0der sobre el PR. No mergear, no publicar.
- Proximo paso: atender lo que devuelva el refutador en la misma rama.

## Decisiones

- `payerKey` es una funcion `({ payment, settle }) => Uint8Array | undefined`: la clave del
  pagador depende de la firma de cada pago. `undefined` = aviso `payer_key_unavailable`.
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
