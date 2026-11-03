# H-6: Arras escrow en TypeScript

Rama: `0xultravioleta/c0-sdk-ts-near`. Base medida tras fetch: `origin/main` `2016c3e8429d719e8e0df514f1bc28c24af93211`. Version: **2.108.0**. No merge de PR, deploy ni publish. Sin Run de Orca.

## Hecho

- `uvd-x402-sdk/near` exporta `buildEscrowMsg`, `paymentIdPreimage`, `computePaymentId`, `createNearLocalSigner`, `signEscrowAuthorization`, constructor/validador del delegate y helpers `release`, `refund`, `reclaim`, `withdraw`, `withdrawFor`/`signEscrowLifecycle`.
- Firmante Ed25519 local (seed de 32 bytes o secreto NEAR de 64 bytes con public half comprobada). Hash NEP-366 directo; no NEP-413. Copia el digest y captura la red antes del callback. Sin RPC, lectura de llaves ni asignacion automatica de nonce.
- Autorizacion: una `ft_transfer_call`, token USDC de la red elegida, receiver interno igual al escrow, deposit 1 yocto, gas **38..100 TGas**. Ciclo de vida: una llamada al escrow, deposit 0; 3..30 TGas release/refund/reclaim, 29..50 withdraw/withdraw_for. Los limites vienen del Rust vigente de x402-rs y `/supported`, que supera el borrador de 30 TGas del plan.
- Se siguen las firmas reales: `withdraw({})`, `withdraw_for({account})`. El contrato v1 fija un token, no recibe `token` en retiros.
- Copia intacta de `arras/docs/vectores.json`: sha256 `fe81bfc72bd1e90a5afb86fb00eece59cbd78fde983eda397c797bf65351709b`. Tests fijan hash, V-1..V-3, msg, preimagen completa V-1, IDs de 32/42/43/44 y firma del wire con Node/OpenSSL.
- `AuthorizeFromBudget` es solo interfaz: ningun ABI ni vector v2 inventado.
- Guia `docs/near-escrow.md`, ejemplo offline `examples/near-escrow-agent.mjs`, changelog y version sincronizada con ambos campos del lock.
- `scripts/xlang/near-escrow-conformance.mjs` + agente Python comparan el bundle real con H-7: fixture, msg/preimagen/id, **21 delegates**, el registro `NEAR_ESCROW_CONTRACTS` y 5 rechazos previos a la firma. Comando opt-in (el job cross-language de CI sigue cubriendo ERC-8128/EVM); falla si el SDK de Python no trae el registro.
- `.gitleaks.toml` conserva reglas default y permite solo los dos identificadores publicos USDC, solo en fixture/guia. El control negativo de API key sintetica sigue fallando como debe.

## Verificacion

Node CI de PR: 20.20.2; Python 3.11.4; npm 10.9.2. Tests sin credenciales AWS ni perfil, con proxies `127.0.0.1:9`, NO_PROXY local. Node 23 del host no se toma como prueba de CI. En Windows npm.ps1 puede usar Node 23 aunque PATH elija Node 20: el runner y el hook usan un launcher local de npm sobre Node 20. `PYTHONIOENCODING=utf-8` evita el error cp1252 al imprimir el nombre del job de paridad.

Verificacion completa y tabla: cuerpo del PR #66. La suite medida en la entrega contenia **91 suites, 3425 tests verdes y 75 skips OWS**; **101 tests** eran del nuevo modulo escrow (124 tras la ronda 1, ver abajo). typecheck, lint, build, pack y ejemplo pasan. ERC-8128/EVM compara **512 checks**, y NEAR compara 3 vectores/21 delegates byte a byte. El pre-CI y escaneo se vuelven a correr sobre la base vigente antes del unico push.

### Rojos de base

`origin/main` 2016c3e, suite con Node 20: 89 suites verdes, **src/reputation/outbox.test.ts** roja por ABI local incompatible de better-sqlite3; 3273 tests verdes y 75 skips OWS. Se corrigio el binario local (sin cambios de codigo ni skip) y despues paso la suite completa. El paso dedicado `OWS native library loads` devuelve error por ausencia de `@open-wallet-standard/core-win32-x64-msvc`: es una limitacion de Windows; CI Linux lo debe verificar. No se debilita ese paso.

### Auto-refutacion

**47/47 mutaciones matadas**, revertidas; sin timeout. Cubren tipos y exactitud numerica, overflow/signo, formato/casing/espacios/Unicode, llaves, identidad/token/receiver/nonce/height, accion unica, args, deposit y gas, lista de metodos y args, IDs, monto positivo, Borsh LE, dominio NEP-366, deposit cero del ciclo, version canonica y mutacion de contexto/digest por el firmante. La tabla M1..M47 queda en el cuerpo del PR.

Sobrevivientes iniciales: el prefijo de llave y la red desconocida en lifecycle motivaron negativos adicionales, y despues murieron. El reemplazo inicial de full-match por RegExp.test sin trim era equivalente en Node y se reemplazo por una mutacion real de normalizacion con trim, matada. Dos rondas del **mismo unico refutador** `gpt-6.1-sol`/`xhigh` no encontraron P1/P2 adicionales. Tokens: herramienta no los expone; no se inventa total. Limite: no hay SignedDelegateAction dorado producido por near-primitives; se reviso contra la fuente Rust, se verifica con OpenSSL y se compara realmente con Python.

## Integracion y pendiente

`git merge-tree --write-tree HEAD origin/main`: sin conflicto. Otro PR abierto del repo: **#65** (`feat/nano-provider-bound`), comprobado mediante `origin/pr-65`; merge-tree tambien limpio (exit 0). H-7 es otro repo y el resto de los seis frentes no modifica este worktree. No se hizo merge de ninguna rama.

No existe `~/.near-credentials/testnet` ni se proporciono una llave local de desarrollo: **no se hizo recorrido vivo testnet**. La guia describe authorize→release→withdraw y authorize→refund. `/supported` medido 2026-11-02 anuncia escrow solo en near:testnet, y desde la ronda 1 el SDK no firma escrow en mainnet hasta que el registro tenga esa fila. Pendientes: pruebas vivas con cuenta local, v2/presupuesto con vectores del worker Arras v2, activacion mainnet, merge y publish por c0der despues del merge. Sin preguntas pendientes sobre la ABI v1.

## Ronda 1 (refutador de c0der, sobre d85118a)

- **Registro por red.** `NEAR_ESCROW_CONTRACTS` congelado: `near:testnet` = `arras-v1b-1101.testnet`, `near:mainnet` vacio. La autorizacion y los cinco metodos del ciclo de vida rechazan cualquier otro `escrowContract` antes de llamar al firmante. Las opciones se leen una sola vez, asi que el contrato que se valida es el que se firma. La fila de mainnet entra en una version nueva cuando exista el contrato de mainnet.
- **Techo del nonce.** Se rechaza `nonce >= maxBlockHeight * 10^6` (NEAR responde siempre `DelegateActionNonceTooLarge`). El vencimiento contra la altura actual sigue siendo del facilitador, que tiene RPC.
- **Tests con literales.** Gas de autorizacion 38..100 TGas escrito a mano (min-1, min, max, max+1, default); tabla de los cinco metodos con 3..30 y 29..50 TGas en los cuatro bordes mas default igual al tope; un argumento de mas rechazado en cada metodo. Las cuatro mutaciones que sobrevivian (piso de `withdraw_for`, `NEAR_ESCROW_MIN_GAS`, tope de `reclaim`, `reclaim` con `amount`) ahora caen.
- **Paridad.** El arnes firma los 21 delegates en testnet con el contrato del registro (el vector de mainnet conserva su msg, preimagen e ID) y compara ademas el registro y 5 rechazos en los dos runtimes. El PR de Python H-7 (#78) se integro sin registro: hasta que el SDK de Python lo traiga, el arnes falla al leer `NEAR_ESCROW_CONTRACTS`, que es lo correcto porque la politica todavia no es la misma.
- README fechado; este handoff ya no remite a archivos locales.
