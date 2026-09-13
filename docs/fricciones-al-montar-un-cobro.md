# Fricciones al montar un cobro con este SDK

> Salidas de montar un gateway x402 completo de cero: Lambda que responde 402, panel de
> pago en el navegador, WebMCP y MCP remoto. Todo lo de acá **costó una iteración de
> depuración**, y ninguna se detecta leyendo el README.
>
> Fecha: 2026-09-05. Contra `uvd-x402-sdk` 2.80.0 → 2.81.0.

Cada punto trae el síntoma exacto, por qué es difícil de ver, y qué cambiaría en el SDK.
Ordenados por cuánto tiempo costaron.

---

## 1. `accepts` sale con dos formatos de monto en la misma respuesta

**Síntoma.** El 402 anuncia `10000` en la primera red y `0.01` en las otras cuatro. El mismo
recurso a dos precios según la red que elija el comprador.

**Por qué pasa.** `create402Response` convierte el requisito primario a entero atómico con
`buildPaymentRequirements`, pero las entradas de `options.accepts` pasan por
`buildRequirementFromAcceptance`, que **no convierte**. Quien escribe el servidor pasa
dólares en los dos lados, porque es lo natural, y solo uno se convierte.

**Por qué es difícil de ver.** El 402 se ve bien: todas las entradas tienen su campo, el
JSON es válido, y la primera red, que suele ser la que uno prueba, está correcta.

**Qué cambiaría.** Que `buildRequirementFromAcceptance` aplique la misma conversión que el
primario. Si eso rompe compatibilidad, al menos que `create402Response` avise cuando las
entradas de `accepts` tienen montos con punto decimal mientras el primario salió en atómico.

---

## 2. La red primaria se duplica si también está en `accepts`

**Síntoma.** El 402 anuncia cinco redes y salen seis entradas, con la primera repetida.

**Por qué pasa.** `create402Response` emite el primario **más** todo lo de `accepts`. Lo
natural es armar el arreglo completo de redes y pasarlo entero, junto con `chainName` de la
primera.

**Qué cambiaría.** Deduplicar por red al construir el arreglo anunciado. Nadie quiere
anunciar la misma red dos veces, así que no hay caso de uso que se pierda.

**Mientras tanto:** pasar `accepts.slice(1)` y la primera como `chainName`.

---

## 3. El 402 habla CAIP-2 y `connect()` habla nombres

**Síntoma.** `Unsupported chain: eip155:8453` al intentar pagar, con Base perfectamente
soportada.

**Por qué pasa.** El facilitador nombra las redes en CAIP-2, que es lo correcto, y el 402 las
devuelve así. `X402Client.connect()` hace `getChainByName()`, que espera `base`. Un panel que
toma la red del `accepts` y se la pasa a `connect()` falla siempre.

**Por qué es difícil de ver.** El error dice "unsupported" y manda a revisar la lista de
cadenas soportadas, donde Base está. La pista real es el formato del identificador.

**Qué cambiaría.** Que `connect()` y `switchChain()` acepten CAIP-2 además del nombre. La
traducción ya existe: `resolveChain`, que este SDK exporta desde `react/picker`. Debería
estar aplicada en la puerta de entrada, no ser tarea del consumidor.

---

## 4. `connected` es true antes de que exista el firmante

**Síntoma.** El panel muestra la dirección de la billetera y, al pagar, `createPayment`
responde `Wallet not connected`.

**Por qué pasa.** `X402Provider` actualiza su estado con los eventos del proveedor inyectado,
incluido `accountChanged`, que la extensión dispara sola al cargar la página. Pero
`connectedAddress` dentro del cliente solo se setea al pasar por `connect()`. Entonces
`isConnected` puede ser true con el cliente sin firmante.

**Por qué es difícil de ver.** El estado de React y el mensaje de error se contradicen en
pantalla, y lo natural es sospechar de la extensión.

**Qué cambiaría.** Cualquiera de estas tres, y con una alcanza:

- Que `createPayment` conecte sola si no hay firmante, en vez de lanzar.
- Que `WalletState.connected` refleje el firmante y no solo la cuenta visible.
- Que el README diga, donde muestra `usePayment`, que `connect()` hay que llamarlo igual.

**Mientras tanto:** llamar a `connect()` siempre antes de pagar. Con la cuenta ya autorizada
no abre popup, así que no cuesta nada.

---

## 5. Un `X402Provider` por componente son varios clientes

**Síntoma.** Se conecta la billetera en un panel de la página y el otro sigue sin firmante,
aunque muestre la misma dirección.

**Por qué pasa.** `X402Provider` hace `useState(() => new X402Client(config))`. Dos
proveedores son dos clientes. Y los dos ven la misma cuenta porque la extensión se la cuenta
a los dos, así que el síntoma se disfraza.

**Qué cambiaría.** Avisar en el JSDoc de `X402Provider` que va **uno por aplicación**. Y
considerar que `useX402` avise en desarrollo cuando detecta más de un proveedor montado.

---

## 6. El hash de la liquidación viene bajo tres nombres

**Síntoma.** El recibo sale sin hash aunque el pago liquidó.

**Por qué pasa.** Según la red y la versión, el campo llega como `transaction`, `txHash` o
`transactionHash`.

**Qué cambiaría.** Que `SettleResponse` exponga uno normalizado, dejando los tres crudos
para quien los quiera. Hoy cada consumidor escribe el mismo `??` encadenado, y el que se
olvida de uno reporta como no confirmado un pago que sí ocurrió.

---

## 7. La lógica de "no me contestó" es privada

**Síntoma.** Se responde 402 a un comprador cuyo pago sigue vivo, y paga dos veces.

**Por qué pasa.** El facilitador devuelve inválido tanto para un pago rechazado como para un
veredicto que nunca emitió. Distinguirlos es lo que separa un cobro correcto de uno que
duplica cargos, y la función que lo resuelve, `respondUnavailable`, **es privada y atada a
Express**.

**Qué cambiaría.** Exportar un helper agnóstico de framework, del tipo:

```ts
const veredicto = classifyVerify(verifyResponse);
// { kind: 'valid' } | { kind: 'rejected', reason } | { kind: 'unavailable', retryAfter }
```

Es la regla más cara de este protocolo y hoy cada servidor la reimplementa leyendo el código
del SDK. El que no la reimplemente cobra dos veces y se entera por el comprador.

---

## 8. No hay un adaptador para funciones serverless

El SDK trae middleware de Express y de Hono. Un despliegue en Lambda con Function URL, que es
de lo más barato para esto, obliga a escribir a mano: leer el header, verificar, clasificar
el veredicto, reclamar idempotencia, liquidar, buscar el hash y armar la respuesta. Son unas
cien líneas que van a ser casi idénticas en todos lados.

**Qué cambiaría.** Un `createPaymentGate({ resolvePrice, payTo, networks })` que devuelva una
función `(request) => Response`, sin depender de framework. Los adaptadores de Express y Hono
pasarían a ser envoltorios de eso.

---

## 10. `pay()` manda dos headers y el preflight lo esconde

Desde 2.81 `usePayment().pay()` devuelve `headers: { "X-PAYMENT", "PAYMENT-SIGNATURE" }`. Un
consumidor hace `...firmado.headers` y manda los dos, y una Function URL cuyo `allow_headers`
solo tiene `x-payment` contesta el preflight sin `Access-Control-Allow-Headers`: el navegador
corta con `TypeError: Failed to fetch` antes de invocar la función. El 402 inicial (sin header
custom) carga bien, el log del gateway queda vacío y la métrica `Invocations` no se mueve.
Se vio el 2026-09-09 en el primer cobro real de un consumidor.

**Qué cambiaría.** Que `X402_CORS_HEADERS` (ya existe en `backend`) sea lo que el README
recomienda copiar al Terraform, con `payment-signature` y `retry-after` incluidos, y que la
sección de CORS diga en una línea que son **dos** headers.

---

## 11. Un rechazo del facilitador no deja rastro, y la firma vence en 60 segundos

`FacilitatorClient.verify()` devuelve `{ isValid: false, invalidReason }` y ahí termina: si el
consumidor no escribe `invalidReason` a su log, CloudWatch muestra START/END/REPORT y nada más,
y el front dice "no se pudo completar". Fue exactamente lo que pasó con un pago firmado desde
la billetera: cero rastro, motivo desconocido, y hubo que redesplegar solo para poder ver.

Sumado a eso, `createEVMPayment` firma con `validBefore = now + 60 s` fuera de Base (300 s en
Base) y no es configurable desde `PaymentInfo`. El facilitador exige 6 s de gracia, así que la
persona tiene ~54 s entre que aparece la billetera y que firma. En móvil, con una billetera
que abre lenta, eso produce un `expired` que parece un bug.

**Qué cambiaría.** (1) Un `onVerdict`/log opcional en `FacilitatorClient` (o al menos un
`console.warn` por defecto en `createPaymentMiddleware`) con `invalidReason`, red, monto y
pagador. (2) `validityWindowSeconds` en `PaymentInfo` o en `X402Config`, con el 60/300 como
default. (3) Un mapa `invalidReason → texto para la persona` exportado, para que cada consumidor
no invente el suyo.

**Estado en 2.91.0.** El punto (2) quedó resuelto, con una diferencia: el campo se llama
`validitySeconds` (el nombre que ya usaba el adaptador de wagmi), vive en `PaymentInfo` y en
`X402ClientConfig`, y el default es **300 s en todas las redes**, no 60/300, porque 300 es el
`max_timeout_seconds` que publica el facilitador. (1) y (3) siguen abiertos.

---

## 12. Solana entra por import dinámico y rompe el bundle de Lambda

Desde 2.88 `index.mjs` hace `await import('@solana/web3.js')` y `await import('@solana/spl-token')`.
Un consumidor que empaqueta un handler con esbuild (Lambda, Cloudflare) muere en el build con un
stack trace cuyo tail es solo `Node.js v23…`; si el build corre encadenado con `terraform apply`,
este dice "0 changed" y la función vieja sigue en producción sin que nada avise.

**Qué cambiaría.** Que `backend` no importe el módulo que arrastra Solana, o que el `import()`
esté envuelto en `.catch()` para que esbuild lo deje pasar; y una línea en el README de `backend`:
"si empaquetás con esbuild, `@solana/web3.js` y `@solana/spl-token` van como `external`".

---

## 13. `usePayment().pay()` se queda con el `isConnected` del render anterior (arreglado en 2.90)

El hook cerraba el `useCallback` sobre `isConnected` del contexto. Un handler que hace
`await connect()` y enseguida `pay()` usa el `pay` que se creó cuando todavía no había
billetera: tira "Wallet not connected" y el segundo clic, ya re-renderizado, sí abre la
billetera. Con Rabby se ve exactamente así: primer clic, error; segundo clic, firma.

**Qué cambió.** `pay()` pregunta `client.getState().connected` en el momento de pagar. El
cliente es la fuente de verdad; el estado de React es una foto.

---

## 9. Lo que sí funcionó a la primera, y conviene no romper

Para que el balance sea justo:

- **`getEnabledChains()` ya trae las 21 redes de mainnet** con su USDC, decimales y
  explorador. No hubo que escribir ni una dirección de token a mano.
- **`FacilitatorClient` no necesita credenciales.** `baseUrl`, `timeout` y reintentos, nada
  más. Eso hace que un gateway x402 no guarde ningún secreto, que es una propiedad enorme y
  poco obvia.
- **Los reintentos con `safeToReplay`** ya vienen resueltos.
- **`escrow-preauth.ts` tiene sus límites escritos como constantes legibles**
  (`ESCROW_DEPOSIT_LIMIT_USD`, `OPERATOR_FEE_BPS`). Se pudo descartar escrow para un caso de
  uso en diez minutos leyendo el archivo, en vez de descubrirlo con dinero real.

---

## Resumen para quien priorice

| # | Fricción | Costo si no se arregla |
|---|---|---|
| 7 | La clasificación del veredicto es privada | **Cargos duplicados** |
| 1 | Dos formatos de monto en el mismo 402 | El mismo recurso a dos precios |
| 6 | Tres nombres para el hash | Pagos buenos reportados como no confirmados |
| 4 | `connected` sin firmante | El pago no arranca, con un error que apunta a otro lado |
| 3 | CAIP-2 contra nombre de cadena | El pago no arranca |
| 8 | Sin adaptador serverless | Cien líneas repetidas por proyecto |
| 2 | Red duplicada en `accepts` | Cosmético, pero se ve mal en el registro |
| 5 | Varios proveedores | Confuso y difícil de diagnosticar |
| 11 | Rechazo sin rastro y firma de 60 s | Un pago real falla y nadie sabe por qué |
| 13 | `pay()` con el `isConnected` viejo | El primer clic falla y el segundo firma |
| 10 | Dos headers y el preflight | "Failed to fetch" sin nada del lado del servidor |
| 12 | Solana por import dinámico | El bundle no compila y el deploy viejo sigue vivo |

Los tres primeros y la 11 cuestan dinero o confianza. Los demás cuestan tiempo.
