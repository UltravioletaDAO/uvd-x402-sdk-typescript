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
- `scripts/xlang/near-escrow-conformance.mjs` + agente Python comparan el bundle real con H-7: fixture, msg/preimagen/id y **21 delegates** identicos. Comando opt-in hasta que ambos PR se integren; no se rompe CI apuntandolo a Python main sin H-7.
- `.gitleaks.toml` conserva reglas default y permite solo los dos identificadores publicos USDC, solo en fixture/guia. El control negativo de API key sintetica sigue fallando como debe.

## Verificacion

Node CI de PR: 20.20.2; Python 3.11.4; npm 10.9.2. Tests sin credenciales AWS ni perfil, con proxies `127.0.0.1:9`, NO_PROXY local. Node 23 del host no se toma como prueba de CI. En Windows npm.ps1 puede usar Node 23 aunque PATH elija Node 20: el runner y el hook usan un launcher local de npm sobre Node 20. `PYTHONIOENCODING=utf-8` evita el error cp1252 al imprimir el nombre del job de paridad.

Verificacion completa, tabla y estado final del PR: ver `ENTREGA-c0der.md`/`ESTADO-c0der.md` locales. La suite medida despues del cambio contiene **91 suites, 3425 tests verdes y 75 skips OWS**; **101 tests** son del nuevo modulo escrow. typecheck, lint, build, pack y ejemplo pasan. ERC-8128/EVM compara **512 checks**, y NEAR compara 3 vectores/21 delegates byte a byte. El pre-CI y escaneo se vuelven a correr sobre la base vigente antes del unico push.

### Rojos de base

`origin/main` 2016c3e, suite con Node 20: 89 suites verdes, **src/reputation/outbox.test.ts** roja por ABI local incompatible de better-sqlite3; 3273 tests verdes y 75 skips OWS. Se corrigio el binario local (sin cambios de codigo ni skip) y despues paso la suite completa. El paso dedicado `OWS native library loads` devuelve error por ausencia de `@open-wallet-standard/core-win32-x64-msvc`: es una limitacion de Windows; CI Linux lo debe verificar. No se debilita ese paso.

### Auto-refutacion

**47/47 mutaciones matadas**, revertidas; sin timeout. Cubren tipos y exactitud numerica, overflow/signo, formato/casing/espacios/Unicode, llaves, identidad/token/receiver/nonce/height, accion unica, args, deposit y gas, lista de metodos y args, IDs, monto positivo, Borsh LE, dominio NEP-366, deposit cero del ciclo, version canonica y mutacion de contexto/digest por el firmante. La tabla M1..M47 queda en el PR y `mutations-c0der.md` local.

Sobrevivientes iniciales: el prefijo de llave y la red desconocida en lifecycle motivaron negativos adicionales, y despues murieron. El reemplazo inicial de full-match por RegExp.test sin trim era equivalente en Node y se reemplazo por una mutacion real de normalizacion con trim, matada. Dos rondas del **mismo unico refutador** `gpt-6.1-sol`/`xhigh` no encontraron P1/P2 adicionales. Tokens: herramienta no los expone; no se inventa total. Limite: no hay SignedDelegateAction dorado producido por near-primitives; se reviso contra la fuente Rust, se verifica con OpenSSL y se compara realmente con Python.

## Integracion y pendiente

`git merge-tree --write-tree HEAD origin/main`: sin conflicto. Otro PR abierto del repo: **#65** (`feat/nano-provider-bound`), comprobado mediante `origin/pr-65`; merge-tree tambien limpio (exit 0). H-7 es otro repo y el resto de los seis frentes no modifica este worktree. No se hizo merge de ninguna rama.

No existe `~/.near-credentials/testnet` ni se proporciono una llave local de desarrollo: **no se hizo recorrido vivo testnet**. La guia describe authorize→release→withdraw y authorize→refund. `/supported` medido 2026-11-02 anuncia escrow solo en near:testnet; la capacidad de firmar mainnet offline no anuncia un contrato desplegado. Pendientes: pruebas vivas con cuenta local, v2/presupuesto con vectores del worker Arras v2, activacion mainnet, refutador de c0der, merge y publish por c0der despues del merge. Sin preguntas pendientes sobre la ABI v1.
