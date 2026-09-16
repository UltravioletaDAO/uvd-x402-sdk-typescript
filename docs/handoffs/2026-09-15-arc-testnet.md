> Historical testnet-only handoff. Superseded on 2026-09-16 by [Arc mainnet/testnet integration](../networks/arc.md); statements below about mainnet being unavailable no longer apply.

# Arc testnet en el SDK de TypeScript

**Fecha:** 2026-09-15. **Versión:** 2.92.0. **Base:** `919d580` (2.91.0).

Arc es la cadena de Circle donde la stablecoin **es** el activo nativo de gas.
Entra como una red EVM más — `eip155:5042002`, `exact` con autorizaciones
EIP-3009 directas sobre USDC — y no necesita proveedor nuevo ni SDK adicional.
Lo único que Arc trae y ninguna otra red de este registro tenía es que **el mismo
saldo se lee con dos precisiones distintas**.

## Lo entregado

| Qué | Dónde |
|---|---|
| Entrada `arc-testnet` en el registro | `src/chains/index.ts` |
| Par `arc-testnet` ↔ `eip155:5042002` | `src/types/index.ts` (`CAIP2_IDENTIFIERS`, y su inverso `CAIP2_TO_CHAIN`) |
| Lista por default del cliente | sale sola de `x402.enabled: true` → `getEnabledChains()`, `getEVMChainIds()`, `NetworkPicker` |
| Tests | `src/arc-testnet.test.ts`, 16 tests |
| Conteos en prosa | `README.md`, `package.json`, `src/index.ts`, cabecera de `src/chains/index.ts` |
| Changelog | `CHANGELOG.md` |

Parámetros de la entrada:

| Campo | Valor |
|---|---|
| `chainId` / `chainIdHex` | `5042002` / `0x4cef52` |
| USDC | `0x3600000000000000000000000000000000000000` |
| Decimales del pago | **6** (interfaz ERC-20) |
| Dominio EIP-712 | `{ name: "USDC", version: "2" }` — `USDC`, **no** `USD Coin` |
| `nativeCurrency` | USDC, **18** decimales (solo gas) |
| RPC / explorer | `https://rpc.testnet.arc.io` / `https://testnet.arcscan.app` |
| Fee payer | ninguno propio: las redes EVM comparten el firmante EVM |

## La trampa: un saldo, dos precisiones

```
nativo   (eth_getBalance, fees EIP-1559)          18 decimales   → gas
ERC-20   (balanceOf, transferWithAuthorization)    6 decimales   → pagos
vista ERC-20 = floor(nativo / 10^12)
```

Un pago x402 es una autorización EIP-3009 firmada **contra la interfaz ERC-20**,
así que su `value` va siempre en 6. Poner 18 —el número que la documentación de
gas de Arc imprime al lado de "USDC nativo"— no rompe nada de forma visible:
firma una autorización perfectamente válida por **10^12 veces** el precio.
`$0.01` saldría como `10000000000000000` unidades, o sea diez mil millones de
USDC.

`src/arc-testnet.test.ts` no se conforma con afirmar que dice 6: **monta el
estado malo**. `withDecimalsTrap()` parchea el registro con `decimals: 18` y mide
lo que efectivamente se firmaría, `10_000_000_000_000_000n` contra `10_000n`, y
comprueba el cociente `10^12`. Con 18 puesto en el registro se ponen en rojo
**seis tests en cuatro superficies independientes**: el registro, la firma
EIP-3009 real, `generatePaymentOptions` y `buildPaymentRequirements`.

Detalle que costó un intento: el parche tiene que ir **al registro global**, no a
un `ChainConfig` clonado. `EVMProvider.signPayment(paymentInfo, chainConfig)`
resuelve el token con `getTokenConfig(chainConfig.name, tokenType)` — la tabla
global — e **ignora los `tokens` del config que recibió**. Una trampa armada con
un clon local no mide nada y pasa en verde. Eso vale también como aviso para
quien use `customChains`: hoy no llega al camino de firma.

`nativeCurrency.decimals: 18` queda, y queda a propósito: es lo que necesita
`wallet_addEthereumChain`, es el único lugar del SDK que lo lee, y nunca toca
`parseUnits`. Los dos números viven pegados en el mismo objeto para que el test
pueda fijar los dos.

## Pre-CI local (el CI del repo está apagado)

Entorno **nuevo**: `rm -rf node_modules dist` + `npm ci` desde el lockfile.
Node v25.4.0, npm 11.7.0.

| Job | Comando | Resultado |
|---|---|---|
| typecheck | `npm run typecheck` (`tsc --noEmit`) | ✅ PASS |
| suite | `npm run test:run` (`vitest run`) | ✅ PASS — **42 archivos, 717 tests** |
| lint | `npm run lint` (`eslint src --ext .ts,.tsx`) | ✅ PASS, 0 findings |
| build | `npm run build` (`tsup`) | ✅ PASS, ESM + CJS + DTS |
| vectores | `npm run vectors:check` | ✅ PASS |
| conformidad TS↔Py | `npm run test:xlang` | ✅ PASS — **430 checks en 8 fases** |

El gate `test:xlang` necesita el checkout del SDK de Python al lado; se corrió
contra la rama `0xultravioleta/sdk-py-arc`, que es la que trae Arc del otro lado.
En un worktree de Orca no está al lado, así que va por env:
`UVD_X402_PY_ROOT=/…/uvd-x402-sdk-python/sdk-py-arc npm run test:xlang`. Sin esa
variable el gate **falla** (no se saltea) — es a propósito: un runtime ausente
significa que las dos implementaciones quedaron sin contrastar.

### Ronda 2 — lockfile

`package-lock.json` había quedado en `2.91.0` con `package.json` ya en `2.92.0`.
Esa misma deriva la había cerrado 2.91.0 (919d580) y esta rama la reabría. Se
sincronizó como lo hace el repo, con npm regenerando el lock
(`npm install --package-lock-only`), no a mano: el diff son **exactamente** los
dos campos `version` (raíz y `packages.""`), sin movimiento de dependencias,
porque 2.92.0 no agrega ninguna. Es la misma forma que el hunk de versión de
919d580.

Los seis gates de arriba se volvieron a correr enteros sobre `node_modules`
reinstalado desde el lock ya sincronizado, y todos siguen en verde. Además:

| Job | Comando | Resultado |
|---|---|---|
| install limpio | `rm -rf node_modules && npm ci` | ✅ PASS desde cero, y **deja el lock intacto** (`git diff` del lock vacío después de correr) |
| empaquetado | `npm pack --dry-run` | ✅ PASS — `uvd-x402-sdk-2.92.0.tgz`, 153 archivos, 2.5 MB |

Sin deriva entre `package.json` y el lock: los dos dicen `2.92.0`, y el tarball
que sale de `npm pack` también.

Demostración del criterio 2 (el test se pone rojo con 18), corrida y revertida:

```
× registers USDC at the ERC-20 precision …        → expected 18 to be 6
× prices a dollar amount into the accepts array…  → accepts difiere
× builds payment requirements at 6 decimals…      → expected '10000000000000000' to be '10000'
× signs a $0.01 authorization for 10000 units…    → expected '10000000000000000' to be '10000'
× shows what 18 would actually charge…            → expected 10000000000000000n to be 10000n
× never lets the native gas precision reach…      → expected 18 to be 6
Tests  6 failed | 10 passed (16)
```

## Paridad con el SDK de Python

Coinciden, y se resolvieron por separado: `chain_id` 5042002, USDC
`0x3600…0000`, 6 decimales, dominio `USDC`/`2`, `eip155:5042002`, EURC fuera, y
el mismo conteo **26**. La conformidad cruzada pasa entre las dos ramas.

Una diferencia estructural, **ninguna peor que la otra**: Python guarda el 18
nativo en `extra_config` (fuera del camino de pago por construcción, no lo lee
nadie); TypeScript lo guarda en `nativeCurrency`, que es un campo obligatorio de
`ChainConfig` y que **sí** se usa, en `wallet_addEthereumChain`. En TS no se
puede replicar el enfoque de Python sin dejar la red sin los parámetros que el
wallet necesita para agregarla. Por eso acá el 18 está expuesto y por eso el test
lo fija junto al 6, en vez de esconderlo.

Python además dejó escrito en el código que midió en vivo
`balanceOf(a) == eth_getBalance(a) // 10**12` sobre 11 direcciones de un bloque
concreto, y el `DOMAIN_SEPARATOR()` recalculado. Es mejor evidencia que la que
tiene este lado, que la toma del plan; no cambia ningún valor.

## Mediciones propias que difieren de lo que estaba escrito

1. **Los conteos en prosa cuentan redes HABILITADAS, no entradas del registro.**
   El registro tiene 26 entradas antes de Arc y decía 25. No era deriva: BSC está
   registrada con `enabled: false` (el USDC Binance-Peg no implementa ERC-3009) y
   por eso nunca sumó. Lo mismo con EVM: 16 entradas, 15 habilitadas. Con Arc
   quedan **26 habilitadas / 16 EVM**. Ese criterio no estaba escrito en ningún
   lado y ahora sí, en la cabecera del registro, que es donde se lo busca.
2. **`getFacilitatorAddress()` devuelve la dirección de MAINNET para las
   testnets EVM.** `FACILITATOR_ADDRESSES` tiene una entrada `evm-testnet`, pero
   el fallback por familia va a `FACILITATOR_ADDRESSES.evm` sin mirar si la red
   es testnet. Es preexistente y ya afecta a `skale-base-sepolia` y
   `robinhood-testnet`; Arc entra al mismo comportamiento. **No se tocó** — la
   tabla de fee payers estaba explícitamente fuera de alcance — y el test fija la
   conducta actual para que un arreglo futuro sea deliberado. Ficha completa, con
   archivo, línea y alcance, en *Defectos preexistentes que esta rama hereda, no
   causa*.
3. **`buildPaymentRequirements()` no emite `extra`.** El dominio EIP-712 de Arc
   es `USDC`/`2` y no el `USD Coin` habitual, así que quien arme los requisitos a
   mano tiene que mandarlo en `extra`. Es el mismo trato que ya tiene Robinhood,
   documentado en el README, y no se cambió para no alterar la conducta de todas
   las redes de golpe.
4. **El comentario de `NetworkPicker.tsx` dice "21 mainnet networks"; el registro
   tiene 20 mainnets habilitadas.** El comentario habla de lo que liquida el
   facilitador, no de este registro, así que puede ser correcto en su propio
   marco. No se tocó. Arc es testnet y no mueve ese número.

## Defectos preexistentes que esta rama hereda, no causa

No se tocan acá: arreglarlos cambia conducta de redes que esta rama no agrega, y
el arreglo tiene que ser deliberado y con su propia prueba. Quedan como filas
para que se puedan seguir.

| Defecto | Dónde | Alcance hoy | Estado en esta rama |
|---|---|---|---|
| `getFacilitatorAddress()` devuelve el fee payer de **MAINNET** para toda testnet EVM: el fallback por familia va a `FACILITATOR_ADDRESSES.evm` y nunca consulta la entrada `evm-testnet`, que existe y queda muerta | `src/facilitator.ts:163` (fallback), `:44` (`evm-testnet` sin uso) | `skale-base-sepolia`, `robinhood-testnet` y ahora `arc-testnet` — las tres testnets EVM del registro | Preexistente: `src/facilitator.ts` no se modificó acá (último cambio, 5d0fed7, muy anterior a esta rama). `src/arc-testnet.test.ts:286-296` **fija la conducta actual**, no la correcta: afirma que Arc recibe `FACILITATOR_ADDRESSES.evm`. Ese test es el que se va a poner en rojo cuando alguien arregle el fallback, y ese rojo es la señal esperada, no una regresión |

## Lo que queda

**Para cerrar testnet:**

- **Orden de merge: el facilitador primero. Lo decide c0der, no esta rama.**
  Arc entra con `enabled: true`, así que cae sola en la lista por default del
  cliente (`getEnabledChains()`, `getEVMChainIds()`, `NetworkPicker`) **desde el
  momento en que este SDK se publique**. Si este SDK sale antes que la rama del
  facilitador, la ventana entre ambos merges es real: el cliente ofrece Arc, el
  usuario la elige, firma una autorización EIP-3009 válida, y el pago falla del
  lado del **facilitador** — que todavía no anuncia Arc en `/supported` — con
  toda la pinta de ser un bug del SDK. No es un defecto de este código: es una
  consecuencia de publicar en el orden inverso. Mergear la rama del facilitador
  primero cierra la ventana; publicar este SDK primero la abre. La alternativa,
  si el orden tuviera que invertirse, es entrar con `enabled: false` y hacer un
  segundo cambio de una línea cuando el facilitador esté — pero eso es decisión
  de c0der y esta rama **no** la toma.
- Un E2E real: cliente → vendedor → facilitador → recibo en Arc, con cuentas
  financiadas por el faucet. Nada de lo entregado acá firmó un pago válido ni
  movió fondos; los tests firman con una llave generada en memoria por corrida.
- **Cuidado con los E2E sobre Anvil:** Arc siembra en génesis una dirección
  **bloqueada** conocida, el índice 1 del mnemónico público de Foundry, donde
  toda transferencia revierte. Un E2E que tome cuentas de Anvil en orden puede
  caer justo ahí y parecer un bug del facilitador. Para pruebas que dependan del
  runtime, Arc Foundry / `arc-anvil` con `--network arc`, o testnet; Anvil
  genérico no reproduce esas reglas.
- **El RPC de Arc responde 403 a un User-Agent por default.** Un cliente que no
  mande uno propio va a parecer que la red no responde, no que falta soporte. Si
  algún día este SDK habla directo con el RPC de Arc, tiene que mandar UA.

**Para mainnet:**

- **No hay mainnet que agregar todavía.** La lista de contratos de Circle sigue
  marcando estas direcciones como testnet y no publica direcciones de mainnet. No
  inferir parámetros de los archivos de génesis del repo del nodo.
- Cuando se publique: revalidar chain id, contratos, dominios EIP-712, mínimos de
  gas, RPC, explorer y contratos auxiliares **antes** de anunciarla, y sumar la
  entrada como mainnet (eso sí mueve el conteo de mainnets, que hoy Arc no toca).

**Fuera de alcance, con motivo:**

- **EURC** (`0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a`, dominio `EURC`/`2`)
  existe en la misma cadena y queda sin registrar hasta pasar su propio E2E:
  cotiza en euros, y tratar un precio en dólares como conversión 1:1 sería
  inventar un tipo de cambio. El registro ya sabe negarse a eso (`usdPegged`).
- **EIP-6492**: el validador universal de firmas que usa este stack **no tiene
  código desplegado en Arc**. La ruta está bloqueada por ausencia, no por
  configuración, y el rechazo tiene que ser explícito y determinista donde se
  implemente. Wallets EOA no dependen de eso; EIP-1271 necesita su propia prueba
  positiva con una wallet ya desplegada.
- **Circle Gateway / Nanopayments** también anuncia `exact` en Arc, pero firma
  contra otro dominio (`GatewayWalletBatched`/`1`, verificador Gateway Wallet) y
  liquida por lotes. Agregar Arc **no** hace compatibles esas autorizaciones: una
  firma Gateway tiene que rechazarse en la ruta directa aunque comparta `scheme`
  y red.
- **USYC** queda afuera: tiene características de participación con rendimiento y
  acceso condicionado; necesita otro análisis de unidades y elegibilidad.
- **ERC-8004 y escrow no se habilitan** por haber agregado la red. `Erc8004Network`
  no incluye Arc: no hay registros desplegados ahí.

**Nota de screening, por si alguien toca ese camino:** Arc tiene los
precompilados `CallFrom` con memo y `Multicall3From`, que **preservan
`msg.sender`**. Circle avisa que un screening que no los contemple es evadible.
Este cambio no toca ningún camino de screening; queda anotado para quien lo haga.
