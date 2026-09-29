# Scripts de Publicación

## Cómo se publica hoy

El SDK se publica solo por **trusted publishing (OIDC)**, sin token de npm, y cada publicación
espera la aprobación del dueño:

> c0der dispara `.github/workflows/publish.yml` en `main` con la versión
> (`gh workflow run publish.yml --ref main -f version=X.Y.Z`) → el dueño aprueba en **Review
> deployments** (environment `npm`) → el workflow publica por OIDC, con provenance.

La versión tiene que estar ya en `package.json` de `main`: el job `check` falla si no coincide. El
tag `vX.Y.Z` se sigue creando (con su GitHub Release), pero ya **no dispara nada**: `publish.yml`
no corre con push, tags, releases ni merges. El paso a paso está en `.claude/commands/publish.md`.

## publish-npm.sh (flujo anterior)

> **Ya no publica.** Este script es del flujo en que el release `vX.Y.Z` disparaba la publicación
> con un token de npm. Sigue subiendo la versión y creando el release, pero el tag ya no dispara
> nada: la corrida que mira en el paso 8 no es una publicación, y el paso 9 no va a encontrar la
> versión en npm hasta que se dispare `publish.yml` y el dueño lo apruebe, como se describe arriba.

Script que maneja el flujo anterior de publicación a npm:

### Lo que hace:

1. ✅ Verifica que estés en la rama `main`
2. ✅ Verifica que no haya cambios sin commitear
3. ✅ Verifica que estés al día con `origin/main`
4. ✅ Te pregunta qué tipo de versión publicar (patch/minor/major)
5. ✅ Actualiza automáticamente `package.json` con la nueva versión
6. ✅ Commitea y empuja el cambio de versión
7. ✅ Crea un GitHub Release con release notes automáticas
8. ✅ Monitorea el workflow de GitHub Actions
9. ✅ Verifica que la publicación en npm fue exitosa

### Uso:

#### Opción 1: Comando npm (recomendado)

```bash
npm run release
```

#### Opción 2: Ejecutar directamente

```bash
bash scripts/publish-npm.sh
```

#### Opción 3: Desde cualquier parte del repo

```bash
./scripts/publish-npm.sh
```

### Tipos de versión:

- **patch (x.x.X)** - Para bug fixes, cambios menores
  - Ejemplo: 2.22.0 → 2.22.1

- **minor (x.X.0)** - Para nuevas features, cambios compatibles
  - Ejemplo: 2.22.0 → 2.23.0

- **major (X.0.0)** - Para breaking changes
  - Ejemplo: 2.22.0 → 3.0.0

### Requisitos:

- `git` configurado con permisos de push
- `gh` CLI autenticado (`gh auth login`)
- `node` instalado
- Estar en la rama `main`
- No tener cambios sin commitear

### Ejemplo de ejecución:

```bash
$ npm run release

=== UVD x402 SDK - Publicador Automático a npm ===

Versión actual: 2.22.0
Commits sin push: 0

¿Qué tipo de versión quieres publicar?
1) patch (x.x.X) - Bug fixes
2) minor (x.X.0) - New features
3) major (X.0.0) - Breaking changes
Opción [1-3]: 2

Nueva versión: 2.23.0
¿Continuar? [y/N]: y

Actualizando package.json...
Commiteando cambios...
Empujando a origin...
Creando GitHub release v2.23.0...
Release creado: https://github.com/UltravioletaDAO/uvd-x402-sdk-typescript/releases/tag/v2.23.0

Esperando workflow de publicación...
Workflow ID: 21810493197

Verificando publicación en npm...

✓ Publicación exitosa
✓ uvd-x402-sdk@2.23.0 está disponible en npm

Instalar con: npm install uvd-x402-sdk@2.23.0

=== Proceso completado ===
```

### Solución de problemas:

#### El workflow falla

Si el workflow de GitHub Actions falla, el script te dará el link para revisar los logs. Las causas comunes son:

- Tests fallando (corregir antes de publicar)
- Build errors (revisar typescript/lint errors)

#### "You cannot publish over previously published versions"

Esto significa que alguien ya publicó esa versión. El script automáticamente evita esto al calcular la siguiente versión disponible.

#### "tag v2.X.Y exists locally but has not been pushed"

Hay un tag local huérfano. Solucionarlo:

```bash
git tag -d v2.X.Y  # Borrar tag local
git fetch --tags   # Sincronizar tags remotos
npm run release    # Reintentar
```

### Notas:

- El script genera release notes automáticamente basándose en los commits desde el último tag
- Si no hay tags previos, usa los últimos 10 commits
- El workflow puede tardar ~45 segundos en completarse
- npm puede tardar 1-2 minutos adicionales en propagar la nueva versión globalmente
