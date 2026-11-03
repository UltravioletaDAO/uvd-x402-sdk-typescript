# c0-sdk-ts-near-mainnet - Arras v1 mainnet (2.110.0)

## Cambio

- near:mainnet registra solo v1.arras-escrow.near; testnet mantiene arras-v1b-1101.testnet. v2 no se habilita.
- Tests de autorizacion y release mainnet con lectura Borsh independiente, firma verificada por OpenSSL y payment ID coherente con el importe de V3.
- V2, destinos arbitrarios y contratos cruzados se rechazan antes de firmar, en autorizacion y los cinco metodos de lifecycle.
- buildArrasStorageDeposit consulta el mismo registro por red. Se prueban red desconocida, getters mutables, Unicode, mayusculas, espacios, saltos finales, prefijos 0x/0X, nulos y subcuentas/sufijos.
- Version sincronizada en package.json y package-lock.json; changelog y guia actualizados. Se corrige el comentario desactualizado del runner de conformidad testnet.

## Verificacion local

PowerShell, Node 20.20.2, npm 10.9.2. Python 3.11.14 para conformidad. Tests sin credenciales AWS, con AWS_SHARED_CREDENTIALS_FILE=NUL y HTTP(S)_PROXY=http://127.0.0.1:9, NO_PROXY=127.0.0.1,localhost. Red abierta solo para instalar dependencias.

| comprobacion | resultado |
|---|---|
| Instalacion limpia desde lockfile | npm ci --offline --no-audit --no-fund, OK; 836 paquetes |
| NEAR + release version | 312 passed |
| Suite completa | 3638 passed, 75 OWS skipped, 92 suites |
| Typecheck y ESLint del lock | OK |
| Build CJS/ESM/declaraciones | OK |
| npm pack --dry-run | OK, 2.110.0, 211 archivos |
| Vectores TS/Python | OK, ambas copias identicas |
| Conformidad TS/Python del CI | 512 checks / 9 fases, OK |
| NEAR golden-flow TS/Python | OK: 3 NEP-413, 2 exact, 3 storage, 11 eventos |
| preci.py --ejecutar | verde: typecheck y lint; tabla integra en PR |
| Gitleaks 8.30.1, diff de tres puntos | 0 hallazgos |
| git diff --check | OK |

La conformidad del CI uso el checkout Python principal como fuente y el interprete del worker r2. No modifica Python. La paridad del registro mainnet NEAR queda al espejo del encargo: el checkout r2 aun tiene la fila mainnet vacia. El runner golden-flow paso usando la fuente del checkout near-kk; r2 aun no tiene near_exact. Se comprobo sin alterar ninguno de esos checkouts.

La primera instalacion limpia agoto el timeout de 300 s; una sola recuperacion offline, con limite de 900 s, termino en 3 minutos. Lockfile sin cambios; suite repetida despues de instalar, con el mismo resultado verde.

## Rojos de base

Antes de editar, HEAD=origin/main=a55578a, Node 20, CI=true y proxies cerrados:
node node_modules/vitest/vitest.mjs run --maxWorkers=4 --minWorkers=1

3546 tests verdes; dos suites no cargaron: src/adapters/ows.test.ts por ausencia de @open-wallet-standard/core-win32-x64-msvc y src/reputation/outbox.test.ts por SQLite de otro ABI. SQLite reconstruido con Node 20, sus tests pasan. La suite final deja CI sin definir para usar el skip Windows que el repo ya tiene: 75 tests OWS omitidos. El paso nativo OWS sigue requiriendo Linux/macOS. Sin cambios de workflow o de politica de skip, y sin fallos funcionales nuevos.

## Auto-refutacion

10/10 mutaciones abatidas por aserciones, cero supervivientes/timeouts; timeout de 120 s por comando. Arbol limpio antes de cada mutacion; git checkout por archivo y limpieza comprobada despues.

| ID | mutacion |
|---|---|
| M1 | vaciar mainnet |
| M2 | registrar v2 |
| M3 | eliminar guarda del registro al firmar |
| M4 | aceptar contratos de otra red al firmar |
| M5 | eliminar guarda del registro en storage |
| M6 | aceptar contratos de otra red en storage |
| M7 | eliminar snapshot de storage |
| M8 | hacer mutable la fila mainnet |
| M9 | hacer mutable el registro exterior |
| M10 | quitar guarda explicita de red en storage |

Un refutador adversarial gpt-6.1-sol/high: cero P1/P2; una observacion P3 del importe/payment ID del test positivo corregida y confirmada. Tokens reales no disponibles en el runtime; no se inventan estimaciones.

## Integracion y limites

Fetch y sincronizacion con origin/main: Already up to date, a55578a. Solapamiento package.json con PR #65: git merge-tree --write-tree HEAD origin/worker-pr-65, head c4878f2, exit 0 sin conflictos. No se incorpora esa rama.

Sin llamadas a produccion ni a la API de EM. Sin merge de PR, deploy, publish, cambios Python ni senales de Orca. C0der coordina refutador final, merge y eventual publicacion. Estado final del PR y CI en ENTREGA-c0der.md/ESTADO-c0der.md locales (no versionados).
