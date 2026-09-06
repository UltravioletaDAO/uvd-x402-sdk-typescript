# El SDK de TypeScript ya firma `release` y `refundInEscrow`

**Fecha:** 2026-09-06 · **Rama:** `0xultravioleta/ts-lifecycle` · **Versión:** 2.86.0 (sin publicar, sin tag)
**Facilitador medido:** `https://facilitator.ultravioletadao.xyz` — `escrowLifecycleAuth: "log"`
**Fuente de verdad del formato:** `x402-rs`, `src/payment_operator/lifecycle_auth.rs` (PR #21), solo lectura
**Gemelo Python:** `uvd-x402-sdk-python` 0.78.0, `build_lifecycle_auth` — paridad **byte a byte**, medida en las dos direcciones

---

## QUÉ / POR QUÉ / RIESGO

**QUÉ:** `buildLifecycleAuth()` produce la orden EIP-712 que el facilitador
verifica para `release` y `refundInEscrow`, y `releaseViaFacilitator()` /
`refundViaFacilitator()` aceptan un `lifecycleSigner` opcional que la cuelga de
`payload.lifecycleAuth`.

**POR QUÉ:** las dos acciones mueven plata que **ya** está depositada, así que
ninguna lleva firma ERC-3009 — no queda transferencia que autorizar. Eso dejaba
sin responder *quién tiene derecho a pedir el movimiento*, y la respuesta de
hecho era "el que llame". El 2026-08-30 un tercero lo sondeó: cinco llamadas con
`paymentInfo` fabricado, dos minadas, gas gastado.

**RIESGO:** que un llamador que hoy funciona deje de funcionar. Acotado por
construcción: `lifecycleSigner` es opcional en las tres capas y por default no
existe; sin él el pedido sale byte por byte igual que antes. El test que lo fija
no compara claves sino el **body entero**
(`src/backend/lifecycle-wiring.test.ts:85`, `release sends the exact body it
sent before lifecycle orders existed`).

---

## 1. Lo que se agregó

`src/lifecycle-auth.ts` (nuevo, +470 líneas):

| símbolo | qué es |
|---|---|
| `buildLifecycleAuth({action, paymentInfo, payer, amount, chainId, wallet, deadline?, nonce?, now?})` | firma y devuelve `{signer, deadline, nonce, signature}` |
| `buildLifecycleTypedData(...)` | el documento EIP-712 en crudo — la costura que espeja a Python |
| `wagmiLifecycleSigner(walletClient, address?)` | el camino del browser (ver §5) |
| `LIFECYCLE_ORDER_TYPES` | los dos structs, en el orden exacto de `lifecycle_auth.rs:73-99` |
| `LIFECYCLE_DOMAIN_NAME` / `_VERSION` | `"x402 escrow lifecycle"` / `"1"` |
| `LIFECYCLE_MAX_DEADLINE_SECS` = 900 | el techo del facilitador (`lifecycle_auth.rs:64`) |
| `LIFECYCLE_DEFAULT_DEADLINE_SECS` = 600 | lo que firmamos por default |
| `LIFECYCLE_ACTIONS` | `['release', 'refundInEscrow']` |

`src/backend/index.ts` — `releaseViaFacilitator` (`:6473`) y
`refundViaFacilitator` (`:6637`) toman un tercer argumento
`options?: LifecycleAuthOptions` (`:5763`).

**El firmante se inyecta.** El SDK no sale a buscar una clave al entorno: recibe
cualquier objeto con `getAddress()` + `signTypedData()`, lo que satisfacen
`EnvKeyAdapter` y `OWSWalletAdapter` estructuralmente, y `wagmiLifecycleSigner`
para el browser.

---

## 2. La política, que es la del facilitador

| acción | firmantes aceptados |
|---|---|
| `release` | el payer; el dueño del operador (`FEE_RECIPIENT()`, leído on-chain) |
| `refundInEscrow` | el receiver; el dueño del operador; el payer, pero solo pasado `authorizationExpiry` |

El receiver **nunca** puede hacer `release` (auto-pagarse es justo lo que el
escrow existe para impedir) y el payer **nunca** puede refundear antes del
vencimiento (eso es el chargeback). El SDK **no** aplica esta tabla — la aplica
el facilitador (`lifecycle_auth.rs:352-367`, `local_role`); acá está para que el
integrador sepa con cuál llave firmar.

### Las tres trampas, cada una un rechazo que el llamador no puede ver

1. **`salt` es `bytes32` en el wire y `uint256` en la firma.** El facilitador lo
   convierte con `U256::from_be_bytes` (`types.rs:288`). En TypeScript la trampa
   tiene una vuelta extra: `ethers` acepta un hex string con `0x` y lo lee como
   el mismo entero, pero un hex **sin** `0x` lo lee como decimal — otro digest y
   un `bad_signature` mudo. `saltToBigInt` (`src/lifecycle-auth.ts:231`) lo
   normaliza siempre.
2. **El `amount` firmado es el enviado.** Firmar `maxAmount` y mandar un parcial
   es una orden que no verifica — y el parcial es el caso normal de un stream,
   que emite una orden y un nonce por delta.
3. **El `deadline` tiene techo de 900 s.** El default firma `now + 600`: firmar
   los 900 exactos hace que un reloj del facilitador cinco segundos atrasado
   decida el veredicto (`deadline_too_far`).

---

## 3. Verificación contra el facilitador VIVO, en `log`

`GET /settle` → `{"endpoint":"/settle",...,"escrowLifecycleAuth":"log"}`

**Sin fondos y sin gas, por construcción.** Red de prueba (base-sepolia) y
`tokenCollector` deliberadamente inválido: en `execute_release_flow`
(`operator.rs:473-476`) el orden es `for_network → get_evm_provider →
lifecycle_auth::gate → execute_release`, y lo primero que hace `execute_release`
es `validate_addresses` (`operator.rs:754`), que revienta con ese collector. El
gate corre y registra su veredicto; la request muere antes de que se arme una
sola transacción. La clave se generó en el proceso y nunca se imprimió ni se
guardó. Script: `scripts/live/lifecycle-live-check.mjs`.

Log de `/ecs/facilitator-production` (región **us-east-2**), verbatim:

```
2026-09-06T15:47:17.670539Z  INFO … lifecycle_auth: escrow lifecycle order accepted
  action="release" network=base-sepolia mode="log" verdict="ok"
  signer=Some(0xa10e880431dd1619ecd7bf5a09d5126c539da4c8)
  operator=0x7d092ec506b3d43eb87846f9c9739303785d7b2f
  payer=0xa10e880431dd1619ecd7bf5a09d5126c539da4c8
  receiver=0x2222222222222222222222222222222222222222

2026-09-06T15:47:17.787630Z  WARN … lifecycle_auth: escrow lifecycle order NOT authorized
  action="release" verdict="unauthorized_role"
  signer=Some(0xa10e880431dd1619ecd7bf5a09d5126c539da4c8)
  payer=0x1111111111111111111111111111111111111111

2026-09-06T15:47:17.861967Z  WARN … lifecycle_auth: escrow lifecycle order NOT authorized
  action="release" verdict="missing" signer=None
```

Las tres murieron en `validate_addresses` (`token_collector mismatch:
client=0x…dead`). **Cero eventos con transacción en toda la ventana** —
verificado sobre los 140 eventos de `15:47:00Z–15:49:20Z`.

El tercer caso es el que importa para la compatibilidad: **una request sin
`lifecycleAuth` sigue llegando y comportándose igual**, con el gate registrando
`missing` en vez de rechazarla. Eso es lo que `log` significa, y es lo que hay
que confirmar antes de mover el facilitador a `enforce`.

---

## 4. Los tests

### Paridad byte a byte con Python

`src/lifecycle-auth.test.ts:227`, `produces the exact signature Python fixed for
this vector`. El vector vive en `src/lifecycle-auth.vectors.json` y es el mismo
que Python fija en `test_vector_fijado_para_el_gemelo_typescript`:

```
digest      0x3dbd8a90a80785131a198a685f9f7400b1bf9a48d998e3aa1853abae56921918
signature   0x78fe143886ee329e235cd7735e948f50ecd2ef32b20a4c88c46767cdd63b33ca
              77553f16c73adacf754e34b2cc988137fd77b843649d990c9a1a5001b28a13a71c
```

El pin duro es el type string: está **tecleado a mano** en el test desde el
orden de campos del `.rs` (`src/lifecycle-auth.test.ts:66`), no derivado de
`LIFECYCLE_ORDER_TYPES`. Derivado, el test solo probaría que el SDK coincide
consigo mismo.

Los cinco veredictos del facilitador se ejercitan contra un **oráculo local**
que reimplementa `pre_evaluate` + `local_role` (`src/lifecycle-auth.test.ts:170`),
que es una segunda implementación a propósito.

### Rojo, y mutantes

Suite: **609 passed** (era 575). Rojo previo: sin `src/lifecycle-auth.ts` el
archivo no colecciona — `Failed to load url ./lifecycle-auth`.

Ese rojo prueba que la API no existía, no que cada assert discrimine. Así que se
corrieron **13 mutantes**, uno por vez. Los 13 murieron:

| se rompió a propósito | test que se puso rojo |
|---|---|
| campos de `PaymentInfo` reordenados (payer ↔ receiver) | 8 tests, incluido el de paridad |
| nombre del dominio EIP-712 cambiado | 4 tests |
| `salt` firmado como hex string crudo | `signs salt as the uint256 integer` |
| nonce por default fijo | `the default nonce is fresh per order` |
| sin techo de deadline | `a deadline past the 900 s ceiling never gets signed` |
| sin chequeo de deadline vencida | `an expired deadline never gets signed at all` |
| default pegado al techo (900 s) | `the default deadline leaves headroom` |
| `paymentInfo` incompleto completado por default | `refuses an incomplete paymentInfo` |
| acción no validada | `refuses an unknown action` |
| wagmi firma con otro `primaryType` | `the wallet client receives a primaryType` |
| wagmi firma sin cuenta conectada | `refuses a disconnected wallet client` |
| `release` firma `maxAmount` y no el monto enviado | (ver abajo) |
| `refundInEscrow` firma la acción `release` | `signs its own action, not release` |

**El mutante del `amount` sobrevivió a la primera corrida** y ese es el hallazgo
del día: en el vector de Python `amount === maxAmount === 1000000`, así que
firmar el equivocado es indistinguible. Un SDK que firmara `maxAmount` habría
pasado la paridad byte a byte y habría fallado **todo settle parcial** — o sea,
todo stream. Se agregó `the signed amount is the amount SENT, not maxAmount`
(`src/lifecycle-auth.test.ts:512`, con `amount = 250000`), y con él el mutante
muere. **El vector de Python no cubre este caso; convendría agregarlo allá.**

### Conformidad cruzada

`node scripts/xlang/cross-language-conformance.mjs` con `UVD_X402_PY_ROOT`
apuntando a un extracto de solo lectura del `origin/main` de Python →

```
CROSS-LANGUAGE CONFORMANCE PASSED — 390 checks across 8 phases.
  ...
  4 escrow lifecycle orders both SDKs signed, compared signature byte to byte.
```

**La fase 8 es nueva y es de este encargo.** Las fases 1-7 son ERC-8128 y
precios: **ninguna toca escrow**, así que un TypeScript que firmara un struct
distinto del de Python habría dejado los 367 checks previos en verde mientras
toda orden que emitiera era rechazada. La fase 8 hace que los dos runtimes
firmen las mismas cuatro órdenes **en vivo, cada uno en su proceso**, y compara
las firmas entre sí **y** contra el vector que fija `lifecycle_auth.rs`. Los
cuatro casos están elegidos para que ningún campo firmado quede sin cubrir: el
vector fijado, un parcial (`amount ≠ maxAmount`), la otra acción, y otro
`chainId`.

Verificada discriminante: con `minFeeBps`/`maxFeeBps` intercambiados en el TS,
la fase 8 da **5 checks en rojo** y nombra las dos firmas.

---

## 5. El camino del browser — el payer firma, el marketplace transporta

El dueño decidió que la orden la firma **el payer**, no EM ni el tesoro. En
H2A/H2H el publisher firma en su browser con el mismo adaptador con que firmó el
pago, y EM la transporta. `wagmiLifecycleSigner` existe por una razón concreta:
**el dominio de ciclo de vida no tiene `verifyingContract`**, y el tipo
`WalletClient` de este SDK (`src/adapters/wagmi.ts:41-55`) lo exige — un
frontend que pasara ese dominio no compilaría.

```tsx
import { useWalletClient, useAccount } from 'wagmi';
import { buildLifecycleAuth, wagmiLifecycleSigner } from 'uvd-x402-sdk';

function ApproveButton({ task }) {
  const { data: walletClient } = useWalletClient();
  const { address } = useAccount();

  async function approve() {
    // El publisher (payer) firma en su propia wallet. La clave nunca sale de ahí.
    const lifecycleAuth = await buildLifecycleAuth({
      action: 'release',
      paymentInfo: task.paymentInfo,   // el MISMO que el backend va a enviar
      payer: address,                  // payload.payer
      amount: task.bountyAtomic,       // el MISMO que payload.amount
      chainId: task.chainId,
      wallet: wagmiLifecycleSigner(walletClient),
    });

    // EM solo lo transporta: lo cuelga de payload.lifecycleAuth en su /settle.
    await fetch(`/api/tasks/${task.id}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lifecycleAuth }),
    });
  }

  return <button onClick={approve}>Aprobar y liberar</button>;
}
```

**Tres cosas que el frontend tiene que respetar, o la orden no verifica:**

1. El `paymentInfo`, el `payer` y el `amount` firmados tienen que ser **los que
   el backend envía**. Si EM recalcula cualquiera de los tres antes de mandar el
   `/settle`, es `bad_signature`.
2. La orden vive **600 segundos**. Si el usuario firma y el backend la manda
   veinte minutos después, es `expired`. Firmar en el momento de enviar.
3. Un nonce por orden. `buildLifecycleAuth` genera uno fresco solo; no
   reutilizarlo entre reintentos, porque el facilitador lo consume al aceptar y
   el segundo intento sería `replayed`.

---

## Para c0der

### La API nueva

```ts
import { buildLifecycleAuth, EnvKeyAdapter } from 'uvd-x402-sdk';

const auth = await buildLifecycleAuth({
  action: 'release',             // o 'refundInEscrow'
  paymentInfo: piWire,           // el objeto camelCase que se ENVÍA
  payer: payerAddress,           // payload.payer, NO va adentro de paymentInfo
  amount: '1000000',             // el MISMO que payload.amount
  chainId: 8453,
  wallet: new EnvKeyAdapter(),   // inyectado; el SDK no lee el entorno
});
// -> payload.lifecycleAuth = auth
```

o, sin armar nada:

```ts
await client.releaseViaFacilitator(pi, undefined, { lifecycleSigner: adapter });
await client.refundViaFacilitator(pi, amount, { lifecycleSigner: adapter });
```

### Quiénes llaman `release`/`refundInEscrow` hoy y tendrían que firmar

Grep de solo lectura sobre `Z:/ultravioleta/dao/*` (excluyendo `node_modules`,
`dist` y los `.claude/worktrees` de agentes):

| dónde | qué hace hoy | qué le falta |
|---|---|---|
| `execution-market/mcp_server/integrations/x402/payment_dispatcher.py:2118` | arma el payload `action: "release"` **a mano**, sin el SDK | pasar un `lifecycle_signer` — o adoptar el SDK de Python, que ya lo hace |
| `execution-market/mcp_server/integrations/x402/payment_dispatcher.py:2562` | ídem, `action: "refundInEscrow"` | ídem |
| `execution-market/mcp_server/services/stream_metering.py:1006` | el settle **parcial** de streams, `action: "release"` | ídem — y acá es donde la trampa del `amount` muerde: una orden por delta, cada una firmando **su** delta, no `maxAmount` |
| `execution-market/dashboard/src/pages/TaskPage.tsx` | el publisher aprueba desde el browser | es el lugar del ejemplo de §5: acá firma el payer y EM transporta |
| `execution-market/dashboard/src/pages/DisputesPage.tsx` | el camino del refund desde el browser | ídem, con `action: 'refundInEscrow'` |

**Ningún consumidor TS del stack usa hoy `releaseViaFacilitator`/
`refundViaFacilitator` del SDK** — EM arma el JSON a mano en Python. Así que el
camino corto para EM es el SDK de Python (0.78.0, ya listo) en el backend, y
este SDK en el dashboard para que el payer firme. El worker `em-payer-signs` de
execution-market consume esta API; el formato de wire está en §5.

### El dato duro que sigue abierto (heredado del handoff de Python)

`FEE_RECIPIENT()` del operador de base-sepolia
(`0x7D092ec506B3D43EB87846F9c9739303785D7B2f`) responde
`0x34033041a5944b8f10f8e4d8496bfb84f1a293a8`. Si EM va a firmar con su propia
llave en vez de con la del payer, esa llave tiene que **ser** ese
`FEE_RECIPIENT()` o el payer del escrow. Cualquier otra da `unauthorized_role`,
que es justo el veredicto que quedó registrado arriba a las `15:47:17.787Z`.
Con la decisión del dueño (firma el payer) esto deja de ser bloqueante para
H2A/H2H, pero sigue siéndolo para cualquier release que EM inicie por su cuenta.

### Lo que NO se hizo, a propósito

- **Sin tag y sin publicar.** El bump a 2.86.0 está en `package.json` y la
  entrada en `CHANGELOG.md`; publicar es un tag y lo decide c0der.
- **No se tocó `x402-rs`.** Solo lectura, como pedía el encargo.
- **No se tocó el checkout de Python.** Está sucio y en otra rama (sesión del
  dueño); la conformidad cruzada corrió contra un `git archive` de su
  `origin/main` extraído al scratchpad, sin escribir una línea en ese repo.
- **Fondos: cero.** Ninguna de las tres requests vivas pudo producir una
  transacción, y está argumentado arriba por qué no.
