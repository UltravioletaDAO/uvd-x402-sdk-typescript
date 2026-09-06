# El publisher firma la orden en su browser: `buildLifecycleTypedData` + `lifecycleAuthFromSignature`

**Fecha:** 2026-09-06 · **Rama:** `0xultravioleta/ts-lifecycle-2` · **Versión:** 2.87.0 (sin publicar, sin tag)
**Sigue a:** [`2026-09-06-lifecycle-auth-typescript.md`](2026-09-06-lifecycle-auth-typescript.md) (2.86.0)
**Pedido de:** el handoff de execution-market `docs/handoffs/2026-09-06-lifecycle-auth-firma-el-payer.md` (PR #178 de EM, mergeado, flag `EM_LIFECYCLE_PAYER_SIGNS` en `off`)
**Fuente de verdad del formato:** `x402-rs`, `src/payment_operator/lifecycle_auth.rs` (PR #21) — no se tocó
**Gemelo Python:** `uvd-x402-sdk-python` 0.78.0 — el mismo vector, la misma firma, byte a byte

---

## QUÉ / POR QUÉ / RIESGO

**QUÉ:** `buildLifecycleTypedData` deja de exigir `deadline` y `nonce` (los
default igual que `buildLifecycleAuth`), aparece
`lifecycleAuthFromSignature(typedData, signature, signer)` que arma el bloque de
wire desde una firma hecha en otro lado, y `releaseViaFacilitator` /
`refundViaFacilitator` aceptan `{ lifecycleAuth }` ya firmado como alternativa
**excluyente** a `{ lifecycleSigner }`.

**POR QUÉ:** el dueño decidió que la orden `LifecycleOrder` la firma **el
payer** — el publisher, en su browser, con el mismo adaptador con que firmó el
pago — y que EM solo la transporta. La 2.86.0 dejó una sola forma de firmar y no
sirve para eso: `buildLifecycleAuth` firma con un `WalletAdapter` inyectado y
genera su propio nonce y su propio deadline, mientras que el publisher firma un
documento que el backend ya armó y devuelve **una firma y nada más**.

**RIESGO:** que las dos formas produzcan órdenes distintas. Es el riesgo entero,
porque una orden que no verifica se ve bien de los dos lados: el browser firmó
algo válido y el backend mandó un bloque bien formado, y el único síntoma es un
`bad_signature` en el facilitador. Acotado por el test que compara **el bloque
entero** de las dos formas para el mismo nonce y deadline
(`src/lifecycle-auth.test.ts`, *produces byte-for-byte the block
buildLifecycleAuth produces*), y por el vector compartido con Python.

---

## 1. Lo que ya estaba y lo que se agregó

`buildLifecycleTypedData` **ya era público en 2.86.0** (`src/index.ts:361`,
definido en `src/lifecycle-auth.ts`). Lo que le faltaba para servirle a un
browser no era la exportación: era que un backend pudiera llamarlo sin inventar
un nonce a mano, y que hubiera con qué volver a armar el bloque del otro lado.

| símbolo | qué es | estado |
|---|---|---|
| `buildLifecycleTypedData({action, paymentInfo, payer, amount, chainId, deadline?, nonce?, now?})` | el documento EIP-712 listo para `signTypedData` | ya existía; `deadline` y `nonce` ahora son **opcionales** |
| `lifecycleAuthFromSignature(typedData, signature, signer)` | arma `{signer, deadline, nonce, signature}` desde una firma hecha en otro lado | **nuevo** |
| `LifecycleTypedData` | el tipo del documento — es un tipo de **wire** | **nuevo** |
| `LifecycleAuthOptions.lifecycleAuth` | la orden ya firmada que el backend solo transporta | **nuevo** |

`src/backend/index.ts`: la regla de exclusión vive en **una** función,
`resolveLifecycleAuth`, que usan los dos métodos. Duplicada, el día que una rama
crece una condición la otra se queda callada con la vieja.

### Dos decisiones que valen más que el código

**1. `deadline` y `nonce` se leen del documento, no del llamador.**
`lifecycleAuthFromSignature` no los recibe: los saca de `typedData.message`, que
es lo que realmente se hasheó. Recibirlos dejaría que el bloque declare un nonce
que la firma nunca comprometió, y las dos mitades se verían correctas por
separado. Fijado en *reads deadline and nonce from the DOCUMENT, never from the
caller*.

**2. La firma no se recupera acá.** Es tentador hacer `ethers.verifyTypedData` y
fallar temprano. Rompería a todos los payers que este SDK ya sirve: las cuentas
delegadas ERC-7702 y las wallets de contrato validan por **ERC-1271**
(`src/erc7702.ts:8`), y sus firmas no hacen `ecrecover` a su dirección ni miden
65 bytes. El chequeo local rechazaría justo las buenas. La recuperación —y el
chequeo de rol que la acompaña— es del facilitador, contra la cadena. Fijado en
*passes an ERC-1271 signature through instead of trying to recover it*.

---

## 2. El camino completo, como lo escribe un frontend

### 2.1 El backend arma el documento

```ts
import { buildLifecycleTypedData } from 'uvd-x402-sdk';

// GET /api/tasks/:id/release-order
const typedData = buildLifecycleTypedData({
  action: 'release',          // o 'refundInEscrow'
  paymentInfo: task.paymentInfo,  // el MISMO objeto que se va a enviar
  payer: task.payer,              // payload.payer, NO va adentro de paymentInfo
  amount: task.bountyAtomic,      // el MISMO que payload.amount
  chainId: task.chainId,
});
// deadline -> now + 600 · nonce -> 32 bytes frescos
// Guardá `typedData` con la sesión: es lo que hay que pasarle después a
// lifecycleAuthFromSignature, y es de donde salen el deadline y el nonce.
res.json({ typedData });
```

### 2.2 El browser firma — wagmi

```tsx
import { useWalletClient, useAccount } from 'wagmi';

function ApproveButton({ task }) {
  const { data: walletClient } = useWalletClient();
  const { address } = useAccount();

  async function approve() {
    // 1. El documento lo arma el backend, con su deadline y su nonce adentro.
    const { typedData } = await fetch(
      `/api/tasks/${task.id}/release-order`
    ).then((r) => r.json());

    // 2. El publisher firma en su propia wallet. La clave nunca sale de ahí.
    //    El documento se pasa tal cual: el dominio de ciclo de vida NO tiene
    //    verifyingContract, y agregarle uno cambia el digest.
    const signature = await walletClient.signTypedData({
      domain: typedData.domain,
      types: typedData.types,
      primaryType: typedData.primaryType,
      message: typedData.message,
    });

    // 3. EM solo transporta la firma. No manda el documento de vuelta: ya lo tiene.
    await fetch(`/api/tasks/${task.id}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ signature, signer: address }),
    });
  }

  return <button onClick={approve}>Aprobar y liberar</button>;
}
```

> Si preferís armar el bloque entero en el browser en vez de mandar la firma
> suelta, `lifecycleAuthFromSignature` corre igual del lado del cliente —
> importá `{ lifecycleAuthFromSignature }` y postéale el resultado al backend.
> Es la misma función; lo único que no cambia es que el `typedData` que le pasás
> tiene que ser el que se firmó.

### 2.3 El backend vuelve a armar el bloque y lo despacha

```ts
import { lifecycleAuthFromSignature } from 'uvd-x402-sdk';

// POST /api/tasks/:id/approve
const lifecycleAuth = lifecycleAuthFromSignature(typedData, signature, signer);

await client.releaseViaFacilitator(task.paymentInfo, task.bountyAtomic, {
  lifecycleAuth,   // viaja tal cual; nada se vuelve a derivar
});
```

### Las tres trampas del camino partido

1. **El `paymentInfo`, el `payer` y el `amount` firmados tienen que ser los que
   se envían.** Si EM recalcula cualquiera de los tres entre firmar y mandar el
   `/settle`, es `bad_signature`. La más fácil de pisar es el `amount`: el
   browser firma la bounty entera y el backend manda un parcial. Fijada en
   `src/backend/lifecycle-wiring.test.ts`, *an order signed for a DIFFERENT
   amount than the one sent does not recover*.
2. **La orden vive 600 segundos.** Armar el documento cuando el usuario va a
   firmar, no al pintar la página. Si firma y el backend la manda veinte minutos
   después, es `expired`.
3. **Un nonce por orden.** `buildLifecycleTypedData` lo genera fresco; no
   reusarlo entre reintentos, porque el facilitador lo consume al aceptar y el
   segundo intento es `replayed`. Si el reintento es después de un `503` del
   writer lease, el facilitador **no** llegó a la cadena y el nonce no se
   consumió — pero armar un documento nuevo cuesta nada y no hay que razonarlo.

### Los dos parámetros juntos

```ts
await client.releaseViaFacilitator(pi, amount, {
  lifecycleSigner: adapter,
  lifecycleAuth: fromBrowser,   // ← lanza
});
// X402Error: lifecycleSigner and lifecycleAuth are mutually exclusive: ...
```

No es una preferencia que se resuelva por precedencia. Significa que el llamador
cree que van a viajar dos órdenes distintas, y solo una puede.

`lifecycleDeadline` **se ignora** al lado de un `lifecycleAuth`: la orden ya
trae el deadline con el que se firmó. Chequearlo acá sería mirar un reloj que no
es el que firmó, y agregaría un rechazo local a algo que el facilitador hoy —en
modo `off`— acepta. Fijado en *lifecycleDeadline is ignored next to a pre-signed
order*.

---

## 3. Los tests

`npx vitest run` → **628 pasan, 38 archivos**. Los 19 nuevos son 13 en
`src/lifecycle-auth.test.ts` (26 → 39) y 6 en
`src/backend/lifecycle-wiring.test.ts` (8 → 14); la línea base era 609.
`npm run typecheck`, `npm run lint` y `npm run build`: limpios.

### En rojo primero

Los 13 tests nuevos de `src/lifecycle-auth.test.ts` corrieron antes de importar
la función: **12 en rojo** con `ReferenceError: lifecycleAuthFromSignature is not
defined` (el 13º, el de los defaults, no la usa y pasó porque
`buildLifecycleTypedData` ya defaulteaba). Después, verdes.

### Discriminantes — tres mutantes medidos

| mutante | qué se rompió | rojos |
|---|---|---|
| `resolveLifecycleAuth` sin el throw de exclusión | los dos parámetros juntos dejan pasar uno | 2 |
| `lifecycleAuthFromSignature` con `randomNonce()` en vez de leer `message.nonce` | el bloque declara un nonce que la firma no comprometió | **6** — incluidos la paridad con Python y el oráculo local |
| `resolveOrderTiming` con nonce constante en vez de fresco | dos órdenes con el mismo nonce | 3 |

El de 6 es el que importa: es exactamente el defecto que el camino partido
habilita, y lo cachan a la vez la paridad byte a byte, el oráculo local
(`pre_evaluate` + `local_role` reimplementados a mano desde
`lifecycle_auth.rs`) y el transporte del backend.

### Paridad byte a byte

`src/lifecycle-auth.vectors.json` no se tocó. El camino partido llega a **la
misma firma** que Python fijó (`reaches the exact signature Python fixed for
this vector`) y el bloque entero es igual al de `buildLifecycleAuth`
(`toEqual`, no campo por campo). También se fija que el documento sobrevive al
`JSON.parse(JSON.stringify(...))` — cruza la red, y un `bigint` o un `Date`
adentro lo rompería en silencio.

---

## Para c0der

### La API nueva

```ts
import {
  buildLifecycleTypedData,
  lifecycleAuthFromSignature,
} from 'uvd-x402-sdk';

// backend: armá el documento (deadline y nonce salen solos)
const typedData = buildLifecycleTypedData({
  action: 'release',
  paymentInfo: pi,
  payer,
  amount,
  chainId: 8453,
});

// browser: firmalo con wagmi/viem/ethers y devolvé la firma

// backend: reensamblá y despachá
const lifecycleAuth = lifecycleAuthFromSignature(typedData, signature, payer);
await client.releaseViaFacilitator(pi, amount, { lifecycleAuth });
await client.refundViaFacilitator(pi, amount, { lifecycleAuth });
```

Lo de 2.86.0 sigue igual y es lo correcto cuando quien firma es el propio
proceso:

```ts
await client.releaseViaFacilitator(pi, amount, { lifecycleSigner: adapter });
```

### Qué le falta a EM

EM ya cableó su lado (PR #178, flag `EM_LIFECYCLE_PAYER_SIGNS` en `off`). Contra
esta versión del SDK le queda:

1. **Pinear `uvd-x402-sdk` ≥ 2.87.0** en `execution-market/dashboard` y en
   donde arme el documento. Hoy no hay ningún consumidor TS del stack usando
   `releaseViaFacilitator` / `refundViaFacilitator` — EM arma el JSON a mano en
   Python (`mcp_server/integrations/x402/payment_dispatcher.py:2118` y `:2562`,
   `services/stream_metering.py:1006`, medidos en el handoff de 2.86.0). Así que
   el pin nuevo es del dashboard.
2. **Decidir dónde vive `typedData` entre el paso 1 y el 3.** Es el único
   estado que el camino partido agrega. Si se pierde, la firma no se puede
   reensamblar: `deadline` y `nonce` salen de ahí y de ningún otro lado.
   Guardarlo con la sesión de aprobación o devolverlo junto con la firma, las
   dos sirven; lo que no sirve es reconstruirlo, porque el nonce sería otro.
3. **El endpoint de aprobación tiene que mandar el MISMO `amount` que se
   firmó.** Es la trampa #1 de arriba y es la que más fácil se pisa en el
   metering de streams, donde cada delta es su propia orden y firma **su**
   delta, no `maxAmount`.
4. **`FEE_RECIPIENT()` sigue abierto para los releases que EM inicie por su
   cuenta.** El operador de base-sepolia
   (`0x7D092ec506B3D43EB87846F9c9739303785D7B2f`) contesta
   `0x34033041a5944b8f10f8e4d8496bfb84f1a293a8`. Con la decisión del dueño
   (firma el payer) esto deja de bloquear H2A/H2H, pero cualquier release que EM
   dispare solo necesita una llave que **sea** ese `FEE_RECIPIENT()` o el payer
   del escrow — cualquier otra es `unauthorized_role`. Heredado del handoff de
   2.86.0, sigue sin resolver.

### Lo que NO se hizo, a propósito

- **Sin tag y sin publicar.** El bump a 2.87.0 está en `package.json` y la
  entrada en `CHANGELOG.md`. Publicar es un tag y lo decide c0der.
- **No se tocó `x402-rs`** ni el SDK de Python. Python no necesita nada: su
  `build_lifecycle_auth` sigue siendo la forma correcta del lado del servidor, y
  el camino partido es de browser. Si algún día EM quiere armar el documento
  desde Python, ahí sí hay un `build_lifecycle_typed_data` que subir upstream —
  hoy no hace falta y no se inventó.
- **No se agregó recuperación local de la firma.** Argumentado en §1: rechazaría
  a las cuentas ERC-1271 que este SDK ya sirve.
- **No se agregó chequeo de ventana al camino pre-firmado.** Bajo el modo `off`
  del facilitador, un release con una orden vencida hoy funciona; fallar local
  sería romper algo que anda.
- **`package-lock.json` quedó como estaba** (dice `2.48.0` desde antes de esta
  sesión). CI corre `npm ci` y no lo mira; arreglarlo es otro cambio.
- **Fondos: cero.** No se firmó nada con una llave real ni se mandó una request
  viva; los tests usan la llave sintética de 32 bytes `0x11` del vector
  compartido, que nunca tuvo fondos.
