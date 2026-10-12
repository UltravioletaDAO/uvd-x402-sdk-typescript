# Publish to npm

Publica una versión del SDK (`uvd-x402-sdk`) a npm.

Se publica solo por **trusted publishing (OIDC)**: el workflow no usa ningún token de npm, y cada
publicación espera la aprobación del dueño. El flujo es:

> c0der dispara `publish.yml` en `main` con la versión → el dueño aprueba en **Review
> deployments** → el workflow publica por OIDC, con provenance → el job `tag` crea el tag anotado
> `vX.Y.Z` en el commit que publicó.

El tag lo crea el workflow y **no dispara nada**: `publish.yml` no corre con push, tags, releases
ni merges.

## Proceso:

1. **Verificar que la versión está lista**
   - La versión ya está en `package.json` de `origin/main` (llega con su PR, junto con su sección del
     CHANGELOG): `git fetch origin && git show origin/main:package.json | grep '"version"'`
   - Esa versión no existe en npm: `npm view uvd-x402-sdk@X.Y.Z version` no devuelve nada
   - El CI de `main` está verde

2. **Disparar el workflow**
   - `gh workflow run publish.yml --ref main -f version=X.Y.Z`
   - El job `check` ("Check version and tests") corre solo en `main` y falla si `X.Y.Z` no es la
     versión de `package.json`; después corre typecheck, tests, lint, build y `npm pack --dry-run`

3. **Pedir la aprobación**
   - El job `publish` queda esperando en el environment `npm`
   - Avisar al dueño con el link de la corrida: Actions → la corrida → **Review deployments** →
     `npm` → Approve. Solo el dueño lo aprueba; no hay otro camino

4. **Monitorear**
   - `gh run list --workflow publish.yml --limit 1` para el run ID
   - `gh run watch <run-id> --exit-status`; si falla, mostrar el link a los logs

5. **Verificar npm**
   - `npm view uvd-x402-sdk version` coincide con `X.Y.Z` (puede tardar 1-2 minutos en propagarse)

6. **Verificar el tag**
   - El job `tag` ("Tag the published version") corre solo si `publish` terminó bien. Comprueba que
     npm tenga `uvd-x402-sdk@X.Y.Z` con `gitHead` igual al commit de la corrida (espera hasta ~75 s
     a que el registro la muestre) y crea el tag anotado `vX.Y.Z` en ese commit
     (`scripts/tag-release.mjs`, por la API, con el token del job). No hay que crearlo a mano
   - El commit del tag es el de la corrida:
     `gh api repos/UltravioletaDAO/uvd-x402-sdk-typescript/commits/vX.Y.Z --jq .sha` igual a
     `gh run view <run-id> --json headSha -q .headSha`

7. **Crear el release** (opcional, sobre el tag que ya existe)
   - `gh release create vX.Y.Z --verify-tag --title vX.Y.Z --notes "<cambios>"`
   - Release notes desde los commits desde el tag anterior

## Manejo de errores:

- `check` falla por la versión → `main` no tiene la versión pedida; no re-disparar con otra
- `check` no corre (skipped) → el workflow se disparó desde otra rama; dispararlo en `main`
- `publish` aborta con "cannot publish with OIDC" → el npm del runner es menor que 11.5.1
- `tag` falla con "already points to <otro SHA>" → `vX.Y.Z` ya existía en otro commit (creado a
  mano, o por `scripts/publish-npm.sh` antes de que `main` avanzara). npm ya tiene la versión: no
  re-publicar. El tag no se movió; decidir con el dueño cuál commit es el bueno antes de tocarlo
- `tag` falla con "npm does not have" → el registro no mostró la versión en ~75 s, o `publish`
  no la publicó aunque terminó en verde. Mirar `npm view uvd-x402-sdk@X.Y.Z gitHead`: si ya está y
  es el commit de la corrida, "Re-run failed jobs"; si no está, no hay nada que taggear
- `tag` falla con "from commit <otro SHA>" → npm tiene la versión publicada desde otro commit. No
  se taggea; decidir con el dueño
- `tag` falla por la API (HTTP 5xx, red) → "Re-run failed jobs" en la corrida: repite solo `tag`,
  sin otra aprobación, y si el tag ya quedó en el commit correcto pasa sin escribir
- `tag` falla con HTTP 403 ("Resource not accessible by integration") o 422 por una regla del repo
  → re-correrlo da lo mismo. Crear el tag a mano sobre el commit de la corrida
  (`gh release create vX.Y.Z --target <headSha> ...`, como antes de este job) y avisar al dueño
- npm ya tiene la versión pero `publish` terminó en rojo (p. ej. un timeout después de subirla) →
  `tag` quedó skipped y re-correr `publish` falla porque la versión ya existe. Crear el tag a mano
  sobre `<headSha>`, igual que en el caso anterior
- `npm publish` falla con `ENEEDAUTH`, 401 o 404 → npmjs.com no tiene este repo y `publish.yml`
  como trusted publisher del paquete; lo configura el dueño en npmjs.com, no se arregla desde el repo
- Nunca agregar un token de npm al workflow ni a los secretos: `src/publish-workflow.test.ts` falla
  si `publish.yml` lee secretos, tiene otro disparador, da `id-token: write` fuera del job que
  publica, pierde `environment: npm` o el chequeo de `main`; también si el job `tag` deja de
  esperar a `publish`, corre aunque `publish` falle, si `npm publish` o el tag pueden fallar sin
  que el job falle (`|| true`, `continue-on-error`, otro `shell`, un `if`), o si `contents: write`
  aparece fuera de él

## Notas importantes:

- NUNCA disparar `publish.yml` sin que la versión esté en `main`
- El tag y el release son registro: se crean después de publicar y no publican nada. El tag lo
  crea el workflow; el release, si se quiere, se crea a mano sobre ese tag
- `scripts/publish-npm.sh` (`npm run release`) es del flujo anterior: sube la versión y crea el
  release, pero ya no publica (ver `scripts/README.md`)
