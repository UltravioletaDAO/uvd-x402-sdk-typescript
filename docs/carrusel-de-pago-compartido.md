# Un carrusel de pago para todo el stack

> **QUÉ:** un componente de selección de red y pago que vive en `uvd-x402-sdk/react` y que
> meshrelay, 402milly, describe.net y los sitios nuevos consumen en vez de mantener el suyo.
> **POR QUÉ:** hoy hay **tres** implementaciones divergentes, 3.718 líneas sumadas, y ninguna
> cubre las 21 redes que el facilitador ya liquida.
> **RIESGO si no se hace:** cada red nueva del facilitador hay que cablearla tres veces, y las
> lecciones que costaron caro en un repo no llegan a los otros.

Fecha del inventario: 2026-09-05. Todo número de acá sale de un comando que está escrito al lado.

---

## 1. Lo que el facilitador soporta hoy, medido

```bash
curl -s https://facilitator.ultravioletadao.xyz/supported
# 150 kinds. Agrupando por `networkAliases` para no contar dos veces `base` y `eip155:8453`:
# 39 redes canónicas = 21 mainnet + 18 testnet
```

**Las 21 de mainnet, y todas aceptan el scheme `exact`**, que es el que usa un cobro normal:

| Familia | Redes | Cuántas |
|---|---|---:|
| EVM | arbitrum, avalanche, base, bsc, celo, ethereum, hyperevm, monad, optimism, polygon, scroll, skale-base, unichain | 13 |
| SVM | solana, fogo | 2 |
| Otras | algorand, near, robinhood, stellar, sui, xrpl | 6 |

Nueve de ellas aceptan además `escrow` y `commerce`: arbitrum, avalanche, base, celo, ethereum,
monad, optimism, polygon y skale-base. El resto solo `exact`.

**Ninguno de los tres carruseles actuales llega a 21.** El más grande cubre 14.

> Corrección del 2026-09-05: la primera versión de este documento decía que meshrelay tenía dos
> redes, porque eso dice el comentario de cabecera de su componente. El comentario quedó viejo:
> `web/src/lib/networks.ts` declara **13**. El componente siempre renderizó `NETWORK_LIST` entera.
> Se cuenta con `grep -c "^\s*'\?[a-z-]*'\?: {" web/src/lib/networks.ts`, no leyendo comentarios.

## 2. Los tres carruseles que ya existen

| Dónde | Archivos | Líneas | Redes | Qué hace bien |
|---|---|---:|---:|---|
| **describe.net** | `site/dn-pay.js`, `pay.js`, `chains.js` | 2.024 | 14 | La arquitectura. Una sola barra para toda la página, con cola de recursos y estado de wallet compartido |
| **402milly** | `ChainSelector.tsx`, `config/chains.ts`, `hooks/useNetworkBalances.ts` | 1.594 | 10 | Los datos. Ficha por cadena con su USDC, y saldos en vivo |
| **meshrelay** | `components/NetworkSelector/NetworkSelector.tsx` | 100 | 13 | La accesibilidad. `role="radiogroup"`, `aria-checked` vivo, navegación por flechas según WAI-ARIA |

Los tres resuelven el mismo problema tres veces. Ninguno es el bueno; el bueno es la unión.

## 3. El SDK ya tiene el motor

`src/react/index.tsx` exporta `X402Provider`, `useX402`, `useBalance`, `usePayment`,
`useChains` y `useNetworkBalances`. **La lógica está.** Lo que no existe es un solo componente
visual que la consuma, y por eso cada proyecto dibujó el suyo.

Esto hace el trabajo mucho más chico de lo que parece: **el PR agrega la cara, no el motor.**

Y la tabla tampoco falta. `src/chains/index.ts` ya declara **las 21 redes de mainnet**, con su
USDC, su explorador y su `x402.enabled`; la única apagada es `bsc`. Contado así:

```bash
grep -c "chainId:" src/chains/index.ts   # 27 entradas, mainnet + testnets
```

O sea que el componente no necesita datos nuevos: cruza el `accepts` del 402 contra
`useChains()` y ya.

## 4. Las tres lecciones que no se pueden perder

Salen de `dn-pay.js`, que es el que más lejos llegó, y están comentadas ahí mismo.

**El `accepted` se manda verbatim, por referencia.** Reconstruir ese objeto aunque salga idéntico
campo por campo es cómo un pago válido termina rechazado (`dn-pay.js:485`, `:581`). El componente
lo pasa tal cual llegó del 402; no lo normaliza, no lo clona, no lo reordena.

**Una sola tabla de redes.** En describe.net vivía una tabla propia de 14 redes que se borró
cuando `chains.js` pasó a ser la única (`dn-pay.js:60-70`). En el SDK esa tabla es `useChains()`,
alimentada por `/supported` del facilitador. **Ningún consumidor vuelve a escribir la lista.**

**Nadie hace `wallet_addEthereumChain`.** Se pide cambiar de red, no agregarla
(`dn-pay.js:32-33`). Agregar redes al monedero de alguien sin pedirlo es hostil y además falla
distinto en cada monedero.

Y una cuarta, de forma: **una red sin ficha no revienta la interfaz**, se muestra cruda
(`dn-pay.js:75`). Con 21 redes y contando, eso deja de ser cortesía y pasa a ser necesario.

## 5. La API, que son dos componentes y no uno

La primera versión de esto era un solo componente que elegía red **y** pagaba. Meterlo en
meshrelay lo rompió en el primer minuto: su selector es un input controlado al lado de un botón
que es el que paga. Un sitio que ya tiene su flujo de cobro necesita el selector solo.

```tsx
// El que elige. Props con la forma del NetworkSelector de meshrelay, para que adoptarlo
// sea cambiar un import y no reescribir la pantalla.
<NetworkPicker
  value={network}
  onChange={setNetwork}
  networks={accepts.map(a => a.network)}  // omitir = todo lo que el SDK trae habilitado
  disabled={paying}
  label="Pay from"
  hint="Your wallet signs a USDC transfer."
/>

// El que elige y paga. Envuelve al de arriba. Para quien arranca de cero.
<PaymentMethodPicker
  accepts={accepts}        // el array del 402, VERBATIM
  payment={{ amount, recipients }}
  onPaid={receipt => {}}
/>
```

`layout` existe porque un sitio con trece redes quiere el segmentado y uno que ofrece las
veintiuna quiere el carrusel, y esa es una diferencia de presentación, no de lógica.

## 6. Qué entra en la primera versión

**Se habilita de verdad lo que el navegador puede firmar hoy:**

- **Las 13 EVM**, por monedero inyectado. Es el camino ya probado en los tres repos.
- **Solana**, por Phantom. El SDK ya trae proveedor SVM.

**Se muestran, deshabilitadas y con el motivo a la vista, las 7 restantes**: fogo, algorand,
near, robinhood, stellar, sui, xrpl. Aparecen porque el facilitador las liquida; están apagadas
porque falta el puente del monedero en el navegador. Mostrarlas apagadas es honesto y además
documenta solo el trabajo que falta.

## 7. Backlog, que es la otra mitad del encargo

| # | Qué | Dónde | Por qué está bloqueado |
|---|---|---|---|
| 1 | `X402Client.connect()` revienta con `networkType: 'solana'` | SDK | Bloquea Solana, que es la que más se pide después de las EVM |
| 2 | Puente de monedero para stellar, sui, xrpl, near, algorand | SDK | Cada familia tiene su monedero y su forma de firmar |
| 3 | `asegurarRed()` está encerrada en el IIFE de `pay.js` y describe.net la duplicó a regañadientes | SDK | Debe salir del SDK, no de cada repo |
| 4 | El middleware lee la red del nivel superior del header y puede romper con el payload estricto v2 | SDK | Se descubre con el primer cliente que no escribimos nosotros |
| 5 | Escrow: tope de 100 USD por depósito, y comisión de operador al 13% contra un tope firmado de 8% | Facilitador | Medido sobre `escrow-preauth.ts` y `backend/index.ts` |
| 6 | `release` y `refundInEscrow` figuran sin firma requerida en el OpenAPI | Facilitador | Es el hallazgo más grave abierto |
| 7 | Los tres repos borran su carrusel y consumen el del SDK | meshrelay, 402milly, describe.net | Después de publicar |
| 8 | ~~El entrypoint `react` arrastra `ethers` a quien solo quiere el selector~~ **RESUELTO 2026-09-05** | SDK | Existe `uvd-x402-sdk/react/picker`: 30,8 kB y sus únicos imports son `react` y `react/jsx-runtime`, contra 64,5 kB de `react` que sí trae `ethers`. **Corrección de la premisa:** este punto nació afirmando una regresión de 407 kB en meshrelay que nunca existió. El chunk medía 406,93 kB **antes** de tocar nada y 406,18 después: es donde su bundler agrupa el camino de pago, y el nombre del archivo no dice qué lo llena. La línea base se midió tarde, que es el error. Ya no bloquea publicar |

Los puntos 5 y 6 no son de este componente, pero viven acá porque son del mismo rail y alguien
los tiene que estar mirando.

## 8. Cuándo está listo

1. `npm run build` del SDK pasa y el paquete exporta `PaymentMethodPicker`.
2. Un cuento renderiza el componente con las 21 redes: 14 operables, 7 visibles y apagadas con
   su motivo.
3. Un pago real en mainnet por una EVM y otro por Solana, cada uno con su hash.
4. Al menos **uno** de los tres repos borró su carrusel y usa este. Sin eso no es compartido,
   es un cuarto carrusel.

El punto 4 es el que de verdad cierra el trabajo. Los otros tres son condiciones para llegar.
