#!/bin/bash
set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Get to repo root
cd "$(git rev-parse --show-toplevel)"

echo -e "${BLUE}=== UVD x402 SDK - Publicador Automático a npm ===${NC}\n"

# 1. Verificar que estamos en main
CURRENT_BRANCH=$(git branch --show-current)
if [ "$CURRENT_BRANCH" != "main" ]; then
    echo -e "${RED}Error: Debes estar en la rama 'main' para publicar${NC}"
    exit 1
fi

# 2. Verificar cambios sin commitear
if ! git diff-index --quiet HEAD --; then
    echo -e "${RED}Error: Hay cambios sin commitear${NC}"
    echo "Por favor commitea tus cambios primero"
    git status --short
    exit 1
fi

# 3. Fetch y verificar si estamos al día
echo -e "${YELLOW}Verificando estado con origin...${NC}"
git fetch origin

COMMITS_BEHIND=$(git rev-list --count HEAD..origin/main)
if [ "$COMMITS_BEHIND" -gt 0 ]; then
    echo -e "${RED}Error: Tu rama está $COMMITS_BEHIND commits detrás de origin/main${NC}"
    echo "Ejecuta: git pull origin main"
    exit 1
fi

COMMITS_AHEAD=$(git rev-list --count origin/main..HEAD)
CURRENT_VERSION=$(node -e "console.log(require('./package.json').version)")

echo -e "${GREEN}Versión actual: ${CURRENT_VERSION}${NC}"
echo -e "${BLUE}Commits sin push: ${COMMITS_AHEAD}${NC}\n"

# 4. Preguntar tipo de bump
echo "¿Qué tipo de versión quieres publicar?"
echo "1) patch (x.x.X) - Bug fixes"
echo "2) minor (x.X.0) - New features"
echo "3) major (X.0.0) - Breaking changes"
echo -n "Opción [1-3]: "
read -r BUMP_TYPE_NUM

case $BUMP_TYPE_NUM in
    1) BUMP_TYPE="patch" ;;
    2) BUMP_TYPE="minor" ;;
    3) BUMP_TYPE="major" ;;
    *)
        echo -e "${RED}Opción inválida${NC}"
        exit 1
        ;;
esac

# 5. Calcular nueva versión
IFS='.' read -r -a VERSION_PARTS <<< "$CURRENT_VERSION"
MAJOR="${VERSION_PARTS[0]}"
MINOR="${VERSION_PARTS[1]}"
PATCH="${VERSION_PARTS[2]}"

case $BUMP_TYPE in
    patch)
        PATCH=$((PATCH + 1))
        ;;
    minor)
        MINOR=$((MINOR + 1))
        PATCH=0
        ;;
    major)
        MAJOR=$((MAJOR + 1))
        MINOR=0
        PATCH=0
        ;;
esac

NEW_VERSION="${MAJOR}.${MINOR}.${PATCH}"

echo -e "\n${GREEN}Nueva versión: ${NEW_VERSION}${NC}"
echo -n "¿Continuar? [y/N]: "
read -r CONFIRM

if [ "$CONFIRM" != "y" ] && [ "$CONFIRM" != "Y" ]; then
    echo "Cancelado"
    exit 0
fi

# 6. Actualizar package.json
echo -e "\n${YELLOW}Actualizando package.json...${NC}"
node -e "
const fs = require('fs');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
pkg.version = '${NEW_VERSION}';
fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
"

# 7. Commit y push
echo -e "${YELLOW}Commiteando cambios...${NC}"
git add package.json
git commit -m "chore: bump version to ${NEW_VERSION}"

echo -e "${YELLOW}Empujando a origin...${NC}"
git push origin main

# 8. Crear release
echo -e "\n${YELLOW}Creando GitHub release v${NEW_VERSION}...${NC}"

# Generar release notes basado en commits recientes
LAST_TAG=$(git describe --tags --abbrev=0 2>/dev/null || echo "")
if [ -z "$LAST_TAG" ]; then
    # Si no hay tags previos, usar los últimos 10 commits
    RELEASE_NOTES=$(git log --oneline -10 --pretty=format:"- %s (%h)")
else
    # Commits desde el último tag
    RELEASE_NOTES=$(git log "${LAST_TAG}..HEAD" --oneline --pretty=format:"- %s (%h)")
fi

gh release create "v${NEW_VERSION}" \
    --title "v${NEW_VERSION}" \
    --notes "## Cambios

${RELEASE_NOTES}

---
🤖 Publicado automáticamente con [scripts/publish-npm.sh](https://github.com/UltravioletaDAO/uvd-x402-sdk-typescript/blob/main/scripts/publish-npm.sh)"

echo -e "${GREEN}Release creado: https://github.com/UltravioletaDAO/uvd-x402-sdk-typescript/releases/tag/v${NEW_VERSION}${NC}"

# 9. Esperar y monitorear workflow
echo -e "\n${YELLOW}Esperando workflow de publicación...${NC}"
sleep 10

RUN_ID=$(gh run list --limit 1 --json databaseId --jq '.[0].databaseId')
echo -e "${BLUE}Workflow ID: ${RUN_ID}${NC}\n"

# Monitorear workflow (timeout 5 minutos)
if ! timeout 300 gh run watch "$RUN_ID" --exit-status; then
    echo -e "\n${RED}El workflow falló o excedió el timeout${NC}"
    echo "Revisa los logs en: https://github.com/UltravioletaDAO/uvd-x402-sdk-typescript/actions/runs/${RUN_ID}"
    exit 1
fi

# 10. Verificar publicación en npm
echo -e "\n${YELLOW}Verificando publicación en npm...${NC}"
sleep 5

NPM_VERSION=$(npm view uvd-x402-sdk version 2>/dev/null || echo "error")

if [ "$NPM_VERSION" = "$NEW_VERSION" ]; then
    echo -e "\n${GREEN}✓ Publicación exitosa${NC}"
    echo -e "${GREEN}✓ uvd-x402-sdk@${NEW_VERSION} está disponible en npm${NC}"
    echo -e "\nInstalar con: ${BLUE}npm install uvd-x402-sdk@${NEW_VERSION}${NC}"
else
    echo -e "\n${YELLOW}Advertencia: npm muestra versión ${NPM_VERSION}, esperábamos ${NEW_VERSION}${NC}"
    echo "Puede tomar unos minutos en propagarse. Verifica manualmente:"
    echo "  npm view uvd-x402-sdk version"
fi

echo -e "\n${GREEN}=== Proceso completado ===${NC}"
