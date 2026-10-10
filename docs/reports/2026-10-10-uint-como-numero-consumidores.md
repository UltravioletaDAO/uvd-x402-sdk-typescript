# Uints escritos como número JSON: inventario de consumidores

**Fecha:** 2026-10-10. **Encargo:** SDKTS-UINT-SALT, parte B (fila P1 de c0der, BACKLOG.md:361).
**Alcance:** solo lectura. No se editó ningún repo. Se leyó cada repo en su rama por defecto en origin,
después de `git fetch origin`, con `git grep -n` y `git show`.

| repo | rama leída | commit |
|---|---|---|
| execution-market | origin/main | f75d4171c |
| karmakadabra | origin/master (su rama por defecto) | 75e98c9f6 |
| karma-hello | origin/main | cc365ff02 |
| x402-rs | origin/main | 6b0fefea7 |
| emporium | origin/main | 271baf689 |
| meshrelay | origin/main | 5b7865ea4 |

## Qué se buscó

Un uint de EIP-712 escrito como NÚMERO JSON da el mismo digest donde se escribe. El problema está
en quien lo lee: `JSON.parse` en JavaScript redondea todo entero mayor que 2^53 - 1. Un salt de
32 bytes llega como 7.76e+76 y el navegador firma otro struct sin ningún error, y el facilitador
contesta `bad_signature`.

Cada hallazgo responde tres preguntas:

- ¿El valor puede pasar 2^53 - 1?
- ¿Ese JSON llega a un `JSON.parse` de JavaScript (navegador, SDK de TS, servicio Node)?
- ¿O solo lo leen Python o Rust, que parsean enteros grandes exactos?

Un campo acotado por su tipo no puede perder precisión como número: uint48 de expiraciones (máximo
2,8e14), uint16 de bps, chainId, ids secuenciales de ERC-8004, puntajes 0-100. Esos casos son
FALSO POSITIVO.

## Resultado

**0 hallazgos REALES en los seis repos.** Todo uint256, uint120 o u128 que llega a un consumidor
JavaScript ya viaja como string decimal o 0x-hex: salt, value, maxAmount, amount,
capturable/refundableAmount, y el agentId y el deadline dentro de typed data firmado. No hay nada
que despachar como arreglo de consumidor. Quedan tres trampas latentes (L1-L3) y un aviso que no
es de uints (A1).

| repo | REAL | FALSO POSITIVO | REVISAR EN RUNTIME |
|---|---|---|---|
| execution-market | 0 | 18 (+1 fixture) | 0 |
| karmakadabra | 0 | 13 (+1 test) | 0 |
| karma-hello | 0 | 1 | 0 |
| x402-rs | 0 | 12 (+2 test) | 0 |
| emporium | 0 | 0 (+1 fixture) | 0 |
| meshrelay | 0 | 3 | 0 |

Se verificaron a mano contra origin, línea por línea, en esta misma sesión:

- execution-market:
  - el pin `uvd-x402-sdk[...]==0.94.0` (mcp_server/requirements.txt:347);
  - `build_lifecycle_typed_data` (lifecycle_auth.py:512) y `const td = challenge.typed_data` (dashboard/src/services/h2aSigning.ts:283);
  - el `uint()` de shared/relayed-rating.ts (`Number.isSafeInteger`);
  - el `_json_safe` recursivo de envelope.py:221;
  - el puente de ows-mcp-server.
- x402-rs:
  - relay_v4.rs:314 y :341-349;
  - payment_operator/types.rs:59-60 y :81;
  - transaction_store.rs:170;
  - handlers.rs:17220/:17232/:17283.
- karmakadabra: el `_json_safe_message` de agents_sdk/signer.py:676, y su copia en em-drone-companion.
- uvd-x402-sdk-python 0.94.0 (e043d17): `"salt": str(_salt_to_int(...))` en escrow_signing.py:872.

El resto viene del barrido con los patrones del final.

## execution-market (origin/main f75d4171c)

| # | archivo:línea | qué | veredicto | por qué |
|---|---|---|---|---|
| 1 | mcp_server/integrations/x402/lifecycle_auth.py:512 | `typed = build_lifecycle_typed_data(` | FALSO POSITIVO (depende del pin) | Es el reto LifecycleOrder que sirven `GET /api/v1/h2a/tasks/{id}/lifecycle-challenge` (api/h2a.py:2060) y `GET /api/v1/escrow/task/{id}/lifecycle-challenge` (api/escrow.py:992). El navegador lo firma tal cual en `signLifecycleOrder` (dashboard/src/services/h2aSigning.ts:283). Lo construye el SDK de Python fijado en 0.94.0, que escribe cada uint como string, `paymentInfo.salt` anidado incluido; así es desde 0.80.0. Ver L3. |
| 2 | mcp_server/integrations/x402/lifecycle_auth.py:547 | `"deadline": deadline,` (y `"chain_id": int(chain_id)` :550) | FALSO POSITIVO | Son campos de nivel superior del reto, no del mensaje firmado. El deadline es now+600 (tope 900) y chainId está acotado. El `message.deadline` firmado es string. |
| 3 | mcp_server/integrations/x402/lifecycle_auth.py:472 | `"preApprovalExpiry": _get("pre_approval_expiry"),` (:472-478) | FALSO POSITIVO | Las expiraciones son uint48 y los bps uint16. `maxAmount` es `str(...)` (:471) y `salt` es el hex guardado. Solo alimenta al constructor del SDK (que pasa todo a string) y al verificador (Python). |
| 4 | dashboard/src/services/h2aSigning.ts:300 | `deadline: Number(auth.deadline),` | FALSO POSITIVO | Es el deadline que el navegador devuelve a EM (Python): segundos unix, como mucho now+900. |
| 5 | mcp_server/integrations/x402/assign_challenge.py:344 | `"preApprovalExpiry": pre_expiry,` (:344-348; `"expiresAt"` :426) | FALSO POSITIVO | Los únicos números son las expiraciones uint48 y los bps uint16. `maxAmount` (:343) y value/validAfter/validBefore (:373-375) son `str(...)`, y salt y nonce son hex. |
| 6 | dashboard/src/pages/publisher/Dashboard.tsx:223 | `bountyAtomic: BigInt(Math.round(bounty * 1_000_000)).toString(),` (igual en dashboard/src/services/marketplaceSigning.ts:94) | FALSO POSITIVO | Es la entrada de `buildEscrowPreAuth` y llega como string. `bounty` es un decimal en USD muy lejos de 2^53. |
| 7 | dashboard/src/services/h2a.ts:204 | `min_fee_bps: number` (:204-207) | FALSO POSITIVO | Es el networkConfig de `buildEscrowPreAuth`: chain_id, bps y ventanas en segundos, todos acotados. |
| 8 | mcp_server/integrations/erc8004/relayed_feedback.py:301 | `"typed_data": getattr(res, "typed_data", None),` | FALSO POSITIVO | Pasa sin cambios el typed data de x402-rs, que emite agentId, value y deadline con `.to_string()` (relay_v4.rs:341-349). El consumidor (shared/relayed-rating.ts y sus copias) acepta un número solo si `Number.isSafeInteger`. |
| 9 | mcp_server/integrations/auth/session_grant.py:169 | `"issuedAt": issued_at,` (y `expiresAt`; :423-424) | FALSO POSITIVO | Son timestamps unix; el `salt` del dominio es un bytes32 hex string (:115). |
| 10 | mcp_server/integrations/x402/escrow_lock.py:181 | `"max_amount": int(pi.get("maxAmount", 0)),` | FALSO POSITIVO | Va a `escrows.metadata.payment_info` (jsonb) y solo lo lee Python. Es USDC de 6 decimales bajo el límite de depósito. |
| 11 | mcp_server/services/stream_metering.py:1015 | `"preApprovalExpiry": pi["pre_approval_expiry"],` (:1015-1021) | FALSO POSITIVO | Es el cuerpo de release al facilitador (Rust). maxAmount y amount son `str(...)` y salt es hex. |
| 12 | mcp_server/integrations/dx402/payer_key.py:121 | `"value": int(auth["value"]),` | FALSO POSITIVO | Es la entrada de un digest local en Python y nunca se serializa. |
| 13 | mcp_server/integrations/reputation/counterparty_proof.py:426 | `"amount_raw": int(t["amount"])` (y :455, :492) | FALSO POSITIVO | Es un dict de auditoría interno (log), que no va a un cliente JS. |
| 14 | mcp_server/api/reputation.py:2013 | `"agent_id": int(agent_id),` (y dashboard/src/components/TaskDetail.tsx:964, xmtp-bot/src/commands/rate.ts:61) | FALSO POSITIVO | Son tokenIds de ERC-8004, secuenciales, del orden de decenas de miles. Se usan para mostrar o buscar y no se firman. |
| 15 | dashboard/public/scripts/ows_shim.py:158 | `typed_data_json = json.dumps(` | FALSO POSITIVO (shim viejo) | Hace `json.dumps` hacia el CLI de OWS (Rust), solo con campos EIP-3009 acotados. El SDK de Python actual ya no lo llama así. No debe recibir nunca un entero de 32 bytes (serde_json sin `arbitrary_precision` lo leería como f64), y hoy nada se lo manda. |
| 16 | ows-mcp-server/src/server.ts:83 | `const typedDataJson = JSON.stringify({` | FALSO POSITIVO | Re-serializa el mensaje EIP-3009, cuyos campos son acotados o strings. Un bigint haría tirar a `JSON.stringify`, que es ruidoso. Ver A1. |
| 17 | em-drone-companion/em_drone_companion/signer.py:303 | `"message": _json_safe_message(message),` | FALSO POSITIVO (latente) | Ver L1: pasa a string solo los enteros de primer nivel. Hoy el dron firma structs planos (EIP-3009). |
| 18 | scripts/e2e_h2h_flow.py:618 | `"value": int(auth["value"]),` (:618-620) | FALSO POSITIVO | Es un script e2e de operaciones que solo recupera localmente. |
| F1 | shared/test-vectors/escrow-preauth.json:60 | `"preApprovalExpiry": 1760003600,` (y :113, :157, :204) | FALSO POSITIVO (fixture) | Son números seguros (uint48/uint16); salt, maxAmount y value son strings. La nueva negativa del SDK no salta con este vector. |

Sin hallazgos:

- em-plugin-sdk/em_plugin_sdk/escrow_signing.py: el auth del wire va en strings.
- em-mobile/lib/h2aSigning.ts y dashboard/src/services/h2aSigning.ts: hacen `JSON.parse` del JSON del SDK, con uints en string.
- scripts/emlib/escrow_recovery.py:141: normaliza un salt int a 0x-hex.
- No hay ningún `"salt": <número>` en el repo, y ningún replacer que pase bigint a Number.

## karmakadabra (origin/master 75e98c9f6)

| # | archivo:línea | qué | veredicto | por qué |
|---|---|---|---|---|
| 1 | agents_sdk/signer.py:332 | `"message": _json_safe_message(message),` | FALSO POSITIVO (latente) | Ver L1. Todo lo que KK firma por PayBox es plano (Receive/TransferWithAuthorization, RelayedGiveFeedback, SafeTx, Snapshot). |
| 2 | agents_sdk/signer.py:329 | `"domain": domain,` | FALSO POSITIVO | El único uint del dominio es chainId, acotado (el mayor es SKALE, 1187947933). |
| 3 | agents_sdk/dx402_anclajes.py:282 | `"preApprovalExpiry": int(w[5], 16),` (:282-286) | FALSO POSITIVO | Son uint48 y uint16; maxAmount es string (:281) y salt es hex (:288). Va a x402-rs (Rust). |
| 4 | lib/turnstile_client.py:472 | `"value": int(amount),` | FALSO POSITIVO | Es entrada de `encode_typed_data` local. Lo que viaja a Turnstile (Node) va en strings (:499-501). |
| 5 | agents_sdk/uvd_buyer.py:363 | `"authorization": {k: (str(v) ...` | FALSO POSITIVO | Pasa value/validAfter/validBefore a string antes del `json.dumps` hacia cualquier vendedor. |
| 6 | agents_sdk/uvd_adapter.py:106 | `"value": int(value),` | FALSO POSITIVO | Es entrada de firma; la autorización que devuelve (:112-113) va en strings. |
| 7 | agents_sdk/rating_rail.py:281 | `"agentId": agent_id, "value": value,` | FALSO POSITIVO | agentId es un id chico, value va de 0 a 100 y deadline es un timestamp. El submit va a EM (Python). |
| 8 | scripts/kk/sign_payment.py:135 | `"validAfter": valid_after,` (:135-136) | FALSO POSITIVO | Es un CLI manual que imprime por stdout; value es string y los otros son timestamps. |
| 9 | scripts/kk/escrow_audit.py:235 | `row.update({"state": ..., "words": words, ...` | FALSO POSITIVO | Las palabras capturable/refundable (uint120) salen como enteros JSON, pero son USDC de 6 decimales bajo $100 (~1e8) y solo las lee Python. Pasaría a REAL con un lector JS o un token de 18 decimales. |
| 10 | shared/a2a_protocol.py:121 | `agentId: int = Field(...)` (y :147) | FALSO POSITIVO | Los ids de ERC-8004 son chicos. |
| 11 | dashboard/live/js/graph3d.js:2471 | `const v = BigInt(String(amount));` | FALSO POSITIVO | Es solo para mostrar. `amount` llega del SSE `/events` de x402-rs como `Option<String>` (events.rs:92). |
| 12 | dashboard/live/js/panels.js:406 | `const v = BigInt(crudo);` | FALSO POSITIVO | Es solo para mostrar. `volumeAtomic` llega de x402-rs con `.to_string()` (handlers.rs:17220). |
| 13 | scripts/kk/gen_escrow_golden_vectors.py:193 | `pi["salt"] = _strip0x(pi["salt"])` | FALSO POSITIVO | El salt queda como string hex sin 0x, nunca como número. |
| T1 | tests/sdk/test_canal_estado_reconciliar.py:76 | `"salt": 7,` | FALSO POSITIVO (test) | Es una semilla u64 de un PDA de Solana, no EIP-712, y solo la lee Python. |

## karma-hello (origin/main cc365ff02)

| # | archivo:línea | qué | veredicto | por qué |
|---|---|---|---|---|
| 1 | services/payment_idempotency.py:257 | `"amount": int(amount),` | FALSO POSITIVO | Es un documento de MongoDB (BSON) que solo lee Python. No es EIP-712. |

No hay typed data EIP-712 en el repo. Los `salt` que aparecen son de KDF y compliance
(backend/core/compliance.py:163, secure_key_manager.py:72/:85), y ninguno es un uint.

## x402-rs (origin/main 6b0fefea7)

| # | archivo:línea | qué | veredicto | por qué |
|---|---|---|---|---|
| 1 | src/erc8004/relay_v4.rs:314 | `"chainId": chain_id,` (`give_feedback_typed_data`) | FALSO POSITIVO | `chain_id: u64` está acotado. En el mismo `json!`, agentId (:341), value (:342) y deadline (:349) usan `.to_string()`. |
| 2 | src/erc8004/relay_v4.rs:343 | `"valueDecimals": p.valueDecimals,` | FALSO POSITIVO | Es u8. |
| 3 | src/erc8004/relay_v4.rs:221 | `"chainId": chain_id,` (`append_response_typed_data`) | FALSO POSITIVO | Igual que #1: agentId (:245), feedbackIndex (:247) y deadline (:250) usan `.to_string()`. |
| 4 | src/erc8004/types.rs:375 | `pub deadline: Option<u64>,` (`PrepareRelayFeedbackResponse`) | FALSO POSITIVO | Es un timestamp de nivel superior; el deadline firmado es string. |
| 5 | src/payment_operator/types.rs:63 | `pub pre_approval_expiry: u64,` (y :66, :69; bps u16 :72/:75) | FALSO POSITIVO | Son uint48 y uint16. `max_amount` usa `string_u128` (:59-60) y `salt: FixedBytes<32>` (:81) rechaza un número al deserializar. |
| 6 | src/payment_operator/lifecycle_auth.rs:115 | `pub deadline: u64,` (`LifecycleAuth`) | FALSO POSITIVO | Segundos unix, con tope now+900. x402-rs solo verifica la orden; no emite el typed data. |
| 7 | src/transaction_store.rs:170 | `pub volume_atomic: u128,` (y :192) | FALSO POSITIVO (latente) | Ver L2. |
| 8 | src/handlers.rs:10935 | `"agentId": agent_id,` (y :9254, :9683, :13407, :13501, :13732; src/discovery_attestation.rs:109) | FALSO POSITIVO | Son tokenIds secuenciales (~95k) en respuestas de solo lectura. |
| 9 | src/handlers.rs:9257 | `"summaryValue": summary_value,` (i128) | FALSO POSITIVO | Es una suma de puntajes 0-100, de solo lectura. |
| 10 | src/erc8004/types.rs:178 | `pub value: i128,` (`FeedbackParams`) | FALSO POSITIVO | Es una ENTRADA (de JS a Rust, que la lee exacta) y un puntaje chico. |
| 11 | static/index.html:3715 | `const balanceEth = Number(balanceWei) / 1e18;` (y static/networks.html:675) | FALSO POSITIVO | Formatea un saldo para mostrar. |
| 12 | src/openapi.rs:930 | `"preApprovalExpiry": 281474976710655,` (:930-934) | FALSO POSITIVO | Es el ejemplo de la doc: el máximo de uint48, por debajo de 2^53. |
| T1 | tests/escrow/verify_nonce.py:53 | `"salt": 0x1234567890abcdef...,` (y tests/escrow/verify_onchain_hash.py:33) | FALSO POSITIVO (test con salt int) | Es un int de Python para abi.encode/keccak local y nunca se serializa a JSON. |
| T2 | tests/x402/load/k6_load_test.js:105 | `validAfter: 0,` / :106 `validBefore: now + 3600,` | FALSO POSITIVO (test) | Son timestamps; value es string (:104). |

Sin hallazgos:

- Van como string: `TokenAmount` y `UnixTimestamp` (types.rs:1042-1044, timestamp.rs:18-20), `EscrowAuthorization` (`string_u128`/`string_u64`, payment_operator/types.rs:27-36), `EscrowLifecyclePayload.amount` (:180) y capturable/refundableAmount de `EscrowStateResponse` (:218-223).
- No hay ningún `"salt": <número>` en src/, crates/, tests/, static/ ni *.json.

## emporium (origin/main 271baf689)

Sin hallazgos. Emporium no tiene constructores propios de EIP-712 ni de payloads x402, y paga con
uvd-x402-sdk. En Rust los montos son `String`: rust/src/modulos/cotizaciones/pago.rs:60/:70,
rust/src/modulos/directorio/bazar.rs:125 y rust/src/modulos/directorio/evidencia.rs:114. El único
u128 es tests/fixtures/anti_riel/sucio/eip3009.rs:11, un fixture "sucio" a propósito que el escáner
anti-riel tiene que marcar (FALSO POSITIVO, fixture).

## meshrelay (origin/main 5b7865ea4)

| # | archivo:línea | qué | veredicto | por qué |
|---|---|---|---|---|
| 1 | scripts/smoke/pago_testigo.py:171 | `"value": int(lg["data"], 16),` | FALSO POSITIVO | Es un script de humo en Python que lee un log de Transfer; no va a JS. |
| 2 | scripts/sdk-parity/gen-accepts.mjs:76 | `!Number.isFinite(Number(rq.maxAmountRequired))` | FALSO POSITIVO | Es un chequeo de finitud; no re-serializa el valor. |
| 3 | bridge/em-events.js:1680 | `Number(p.bounty_usd ?? ...).toFixed(2)` | FALSO POSITIVO | Muestra USD en una línea de IRC. |

Sin hallazgos: turnstile/config.js:381 y multibrain/turnstile emiten montos como string, y el
schema del webhook de EM tipa `amount` como string decimal (api/src/lib/em-webhook.ts:46/:265).

## Trampas latentes (no son REALES hoy)

- **L1. Stringificadores de un solo nivel hacia PayBox.** `karmakadabra/agents_sdk/signer.py:676`
  y `execution-market/em-drone-companion/em_drone_companion/signer.py:501` (`_json_safe_message`)
  pasan a string solo los enteros de primer nivel del mensaje. Hoy no pasa nada porque los dos
  firman structs planos. Si un día les llega un struct con un uint anidado armado con ints (una
  LifecycleOrder con `paymentInfo.salt` int), ese salt viaja a PayBox/MoonX (JS) como número de
  32 bytes. El patrón a copiar es el `_json_safe` recursivo de
  `execution-market/mcp_server/integrations/paybox/envelope.py:221`.
- **L2. `x402-rs/src/transaction_store.rs:170` y `:192`, `volume_atomic: u128`** con `Serialize`
  derivado: se serializaría como número. Hoy siempre sale con `.to_string()` (handlers.rs:17220,
  :17232, :17283). Un `Json(aggregate)` futuro pondría en el wire valores mayores que 2^53 (tokens
  de 18 decimales). Lo cierra un `#[serde(with = "string_u128")]`. El comentario del campo dice "a
  string", pero el tipo no lo es.
- **L3. execution-market depende del pin del SDK de Python.** El reto LifecycleOrder (fila 1 de
  execution-market) es seguro porque `uvd-x402-sdk==0.94.0` escribe cada uint como string desde
  0.80.0. Bajar el pin por debajo de 0.80.0 convierte esa fila en REAL: el salt anidado llegaría al
  navegador como número.

## Aviso aparte (no es de uints)

- **A1. ows-mcp-server contra el SDK de TS 2.101.0.** `execution-market/ows-mcp-server/src/server.ts:679`
  y `:851` hacen `new OWSWalletAdapter(owsBridge)`. El puente (`createOWSWalletBridge`, :54) es el
  objeto viejo con `accounts`, y desde 2.101.0 (#41) ese constructor tira `INVALID_CONFIG`. El
  lockfile fija 2.100.0 (ows-mcp-server/package-lock.json:2529) con `^2.100.0` en package.json, así
  que la primera actualización a 2.101.0 deja las dos tools devolviendo error (el `try/catch` de
  :678 lo captura). Hay que avisar a quien mantenga ows-mcp-server.

## Qué hace el SDK desde 2.102.0

Un uint que llega como número JSON mayor que 2^53 - 1 se rechaza con un error que nombra el campo,
en todos los caminos que leen uints para firmar o hashear (ver CHANGELOG 2.102.0). Por eso un
consumidor que en el futuro mande un uint como número va a ver un error y no un `bad_signature`
mudo. El SDK sigue emitiendo cada uint ancho como string.

## Patrones usados

Todos con `git -C <repo> grep -n -I ... origin/<rama> -- . ':!**/node_modules/**' ':!**/dist/**'
':!**/build/**' ':!*lock*' ':!**/vendor/**' ':!*.min.js'`. En el git de esta Mac, `-E` con `\s` o
`\b` no matchea nada sin avisar, así que se usaron `-P`, `-w` o clases POSIX.

- Llamadas al SDK: `buildLifecycleTypedData|buildLifecycleAuth|lifecycleAuthFromSignature|buildEscrowPreAuth|computeEscrowNonce|EnvKeyAdapter|wagmiLifecycleSigner`; en Python, `build_lifecycle_typed_data|build_lifecycle_auth|lifecycle_auth_from_signature`.
- Salt: `-i -w salt`; `["']salt["']\s*:\s*(int\(|\d)|salt\s*=\s*(int\(|\d)|salt:\s*(\d|BigInt)`; `int\(\s*\w*salt\w*\s*,\s*16\)`.
- Dicts de Python: `["'](salt|value|amount|maxAmount|max_amount|capturableAmount|refundableAmount|validAfter|validBefore|nonce|agentId|agent_id|maxAmountRequired|deadline|preApprovalExpiry|authorizationExpiry|refundExpiry|minFeeBps|maxFeeBps)["']\s*:\s*int\(`, y las mismas claves con un valor que no es `str(`, literal ni None.
- Modelos pydantic y dataclasses: `^\s+(salt|max_amount|maxAmount|capturable_amount|refundable_amount|value|valid_after|valid_before|nonce|amount|agent_id|agentId)\s*:\s*(Optional\[)?(int|conint|StrictInt)\b`.
- Documentos typed data: `["']primaryType["']\s*:`, `signTypedData|eth_signTypedData`, `sign_typed_data\(|encode_typed_data`, `TransferWithAuthorization|ReceiveWithAuthorization|PaymentInfo`.
- JS/TS: `(Number|parseInt|parseFloat)\(...(salt|maxAmount|amount|atomic|capturable|refundable|validBefore|validAfter|nonce|\.value\b|agentId|maxAmountRequired)`; replacers `bigint ... ? Number(`; `.toNumber()`.
- Rust: `pub\s+\w+\s*:\s*(Option<)?(u128|i128|U256|Uint<)`, `serde\(with|serde_as|DisplayFromStr|serialize_with`, y los cuerpos de `json!(` con typed data.
