# Solana: el rater firma su propia calificación (SDK TS 2.88.0)

**Fecha:** 2026-09-07 · **Rama:** `0xultravioleta/sdk-feedback-solana-ts` ·
**Worker:** `sdk-feedback-solana-ts` (ws-5 del plan `2026-09-07-solana-full`)

---

## QUÉ

`Erc8004Client` gana dos métodos —`prepareSolanaFeedback()` y
`submitSolanaFeedback()`— contra `POST /feedback/solana/prepare` y `/submit` del
facilitador, más su propio par de ruteo `SOLANA_FEEDBACK_NETWORKS` /
`supportsSolanaFeedback()`.

## POR QUÉ

`submitFeedback()` escribe la calificación con la llave del **facilitador** en la
cuenta 0 de la instrucción `give_feedback`, que el programa declara
`[signer, writable] client (feedback author)`. O sea: la cadena registra al
facilitador como autor, y el facilitador es el único que puede revocarla. El
servidor ya tenía el arreglo desplegado desde el 2026-08-13; lo que faltaba era
el cliente.

## RIESGO

Si `solana` entrara a `RELAYED_FEEDBACK_NETWORKS`, la llamada se iría a
`/feedback/evm/prepare` —400— y además el SDK estaría afirmando un
`FeedbackDelegate` que no existe y que **no falta**: en Solana no hace falta
delegación, la transacción lleva varias firmas de forma nativa. Un test nuevo
fija que las dos listas no se tocan.

---

## Los nombres exactos (para que el SDK de Python los espeje)

El worker de Python (`sdk-feedback-solana-py`) todavía no había escrito nada
cuando esto se cerró, así que estos son los nombres canónicos. La versión Python
de cada uno es el mismo nombre en `snake_case`:

| TypeScript (`uvd-x402-sdk/backend`) | Python (`uvd_x402_sdk.erc8004`) |
|---|---|
| `SOLANA_FEEDBACK_NETWORKS` | `SOLANA_FEEDBACK_NETWORKS` |
| `supportsSolanaFeedback(network)` | `supports_solana_feedback(network)` |
| `Erc8004Client.prepareSolanaFeedback(request)` | `Erc8004Client.prepare_solana_feedback(...)` |
| `Erc8004Client.submitSolanaFeedback(request)` | `Erc8004Client.submit_solana_feedback(...)` |
| `PrepareSolanaFeedbackRequest` | `PrepareSolanaFeedbackRequest` |
| `PrepareSolanaFeedbackResponse` | `PrepareSolanaFeedbackResponse` |
| `SubmitSolanaFeedbackRequest` | `SubmitSolanaFeedbackRequest` |

`SOLANA_FEEDBACK_NETWORKS = ['solana', 'solana-devnet']` — las dos que el
facilitador sirve en vivo (`GET /supported`, medido hoy).

### Campos del wire (camelCase en los dos lenguajes, es lo que serde emite)

`prepare` request → `{ x402Version, network, feedback: { agentId, rater, value,
valueDecimals?, score?, tag1?, tag2?, endpoint?, feedbackUri?, feedbackHash?,
proof? } }`.

`prepare` response → `{ success, transaction?, rater?, feePayer?, blockhash?,
lastValidBlockHeight?, error?, network }`.

`submit` request → `{ x402Version, network, feedback: <lo mismo>, transaction }`.

`submit` response → el `FeedbackResponse` de siempre (`success`, `transaction`,
`error`, `network`, `proof`).

---

## Medido en vivo contra el facilitador desplegado (2026-09-07)

`GET /api-docs/openapi.json` → **v2.16.0**, con `/feedback/solana/prepare` y
`/feedback/solana/submit` en la lista de rutas.

Y una llamada real desde el paquete compilado de esta rama —`prepare` no escribe
nada on-chain y no cuesta nada; **no firmé ni sometí nada**:

```
supportsSolanaFeedback('solana'): true
success              : true
rater                : 9oSLm8Rk1kQ9y8dFcqbAcTNqYqcrTUR6cQ4mL8mYNXpB   (el que mandé)
feePayer             : F742C4VfFLQ9zRQyithoj5229ZgtX2WqKCSFKgH2EThq   (el facilitador)
blockhash            : Fkr9WGmKNPfVqAyjugNZLLLdH2N5VLKgJ8tKoswWB9b4
lastValidBlockHeight : 423234967
transaction          : 592 bytes, primer byte = 2 (dos firmas esperadas)
```

Deserializada con `Transaction.from()` de `@solana/web3.js`:

```
feePayer del mensaje : F742C4VfFLQ9zRQyithoj5229ZgtX2WqKCSFKgH2EThq
firmantes requeridos : [facilitador, rater]
firmas presentes     : [VACIA, VACIA]
programa             : 8oo4dC4JvBLwy5tGgiH3WwK4B9PWxL9Z4XjA2jzkQMbQ
cuenta 0 de la ix    : 9oSLm8Rk1kQ9y8dFcqbAcTNqYqcrTUR6cQ4mL8mYNXpB {signer:true, writable:true}
```

**La cuenta 0 de la instrucción es el rater, no el facilitador.** Ese es el
asiento que el plan dice que el facilitador venía ocupando. Y es una transacción
**legacy**: se lee con `Transaction.from()`, no con `VersionedTransaction`.

La dirección del fee payer no es un secreto: ya viaja pública en
`GET /supported` (`extra.feePayer` de las redes Solana).

---

## Las tres trampas que quedaron escritas en el código

1. **Sin `score` la calificación no cuenta.** `score` es opcional en el wire y el
   ATOM Engine ignora un feedback sin score: la transacción sale bien, el
   registro queda en el agente, y la reputación se queda en cero
   (`had_impact=false`). No es retroactivo. Está en el JSDoc de
   `PrepareSolanaFeedbackRequest.feedback`, en el README y en un test.
2. **`prepare` da una ventana, no un permiso.** Pasado `lastValidBlockHeight` la
   red descarta la transacción: no se escribe ni se cobra nada, y reenviar exige
   un `prepare` nuevo porque el blockhash que el rater firmó ya venció. Por eso
   `submitSolanaFeedback` reporta `retryable: true, safeToReplay: false` ante un
   fallo de red — el SDK no reintenta solo.
3. **No re-encodear el mensaje.** El facilitador re-deriva el mensaje desde los
   parámetros declarados más el blockhash que viaja en la transacción, y se
   niega a co-firmar cualquier cosa que no sea byte por byte la que él armó.
   Firmar blobs arbitrarios convertiría la llave del fee payer en un oráculo de
   firma público. Por eso los parámetros de `feedback` **no son redundantes** en
   `submit`.

---

## Archivos

| Archivo | Qué |
|---|---|
| `src/backend/index.ts` | `SOLANA_FEEDBACK_NETWORKS`, `supportsSolanaFeedback`, los tres tipos de wire, y los dos métodos del cliente |
| `src/backend/solana-feedback.test.ts` | 13 tests nuevos, incluido el que fija que las dos listas de redes no se tocan |
| `README.md` | sección nueva bajo "Ratings the chain attributes to the rater" |
| `CHANGELOG.md` | entrada 2.88.0 |
| `package.json` | 2.87.0 → 2.88.0 |

Superficie pública: **solo `uvd-x402-sdk/backend`**. El `src/index.ts` raíz no
re-exporta nada de ERC-8004 (tampoco `supportsRelayedFeedback`), así que no se
tocó.

## Verificación

```
npm run typecheck   OK
npm run lint        OK
npm run test:run    641 tests, 39 archivos, todos verdes
npm run build       OK
npm pack --dry-run  uvd-x402-sdk-2.88.0.tgz, 151 archivos
```

El test que importa se probó **discriminante**: metiendo `solana` a mano en
`RELAYED_FEEDBACK_NETWORKS`, se ponen rojos los dos —el guard nuevo
(`solana-feedback.test.ts` → "shares nothing with the EIP-7702 delegate list") y
el que ya existía (`relayed-feedback.test.ts:75` → "is exactly the set with a
verified delegate")—. Revertido.

---

## Para c0der

- **Listo para mergear.** PR contra `main` de `uvd-x402-sdk-typescript`. No
  mergeé nada ni disparé ningún deploy.
- **La publicación es un tag, no un push.** Cuando el PR esté mergeado, hay que
  tagear `v2.88.0` sobre el commit de merge: `.github/workflows/publish.yml` solo
  corre con `push: tags: v*`. Sin el tag, el paquete no sale a npm.
- **Lo que NO hice, y no era mío:** el punto (a) de ws-5 —un `prepare → firma del
  rater → submit` real que deje una tx en Solana— es una **escritura on-chain**.
  Verifiqué toda la mitad de lectura contra el facilitador vivo (arriba); la
  firma y el `submit` necesitan una llave de rater con la que escribir. El
  criterio 2 y 3 de cierre de ws-5 (`NewFeedback.client` = pubkey del agente,
  `distinct_raters` de 33 → 34 en describe.net) se cierran con esa llamada, no
  con este PR.
- **Para el worker de Python:** los nombres canónicos están en la tabla de
  arriba. Cuando `uvd-x402-sdk-python` los espeje, `supports_solana_feedback` y
  `SOLANA_FEEDBACK_NETWORKS` tienen que quedar como un par propio y
  `RELAYED_FEEDBACK_NETWORKS` **no se toca** —
  `tests/test_relayed_feedback.py:56` lo fija contra `DELEGATE_NETWORKS`, igual
  que su gemelo de acá.
- **Sin capturas:** este worker no toca ninguna superficie visual.
