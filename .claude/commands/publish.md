# Publish to npm

Publica una versión del SDK (`uvd-x402-sdk`) a npm.

Se publica solo por **trusted publishing (OIDC)**: el workflow no usa ningún token de npm, y cada
publicación espera la aprobación del dueño. El flujo es:

> c0der dispara `publish.yml` en `main` con la versión → el dueño aprueba en **Review
> deployments** → el workflow publica por OIDC, con provenance.

El tag `vX.Y.Z` se sigue creando, pero ya **no dispara nada**: `publish.yml` no corre con push,
tags, releases ni merges.

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

6. **Crear el tag y el release**
   - Sobre el commit que publicó la corrida: `gh run view <run-id> --json headSha -q .headSha`
   - `gh release create vX.Y.Z --target <headSha> --title vX.Y.Z --notes "<cambios>"`
   - Release notes desde los commits desde el último tag

## Manejo de errores:

- `check` falla por la versión → `main` no tiene la versión pedida; no re-disparar con otra
- `check` no corre (skipped) → el workflow se disparó desde otra rama; dispararlo en `main`
- `publish` aborta con "cannot publish with OIDC" → el npm del runner es menor que 11.5.1
- `npm publish` falla con `ENEEDAUTH`, 401 o 404 → npmjs.com no tiene este repo y `publish.yml`
  como trusted publisher del paquete; lo configura el dueño en npmjs.com, no se arregla desde el repo
- Nunca agregar un token de npm al workflow ni a los secretos: `src/publish-workflow.test.ts` falla
  si `publish.yml` lee secretos, tiene otro disparador, da `id-token: write` fuera del job que
  publica, pierde `environment: npm` o el chequeo de `main`

## Notas importantes:

- NUNCA disparar `publish.yml` sin que la versión esté en `main`
- El tag y el release son registro: se crean después de publicar y no publican nada
- `scripts/publish-npm.sh` (`npm run release`) es del flujo anterior: sube la versión y crea el
  release, pero ya no publica (ver `scripts/README.md`)
