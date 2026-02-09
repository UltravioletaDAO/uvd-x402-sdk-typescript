# Publish to npm

Automatiza el proceso completo de publicación del SDK a npm.

## Proceso:

1. **Verificar estado del repositorio**
   - Verificar que estamos en rama `main`
   - Verificar que no hay cambios sin commitear
   - Verificar que estamos al día con `origin/main`
   - Mostrar la versión actual y commits pendientes

2. **Determinar nueva versión**
   - Preguntarle al usuario qué tipo de bump quiere (patch/minor/major)
   - Calcular la nueva versión basándose en la actual
   - Mostrar claramente: versión actual → nueva versión
   - Pedir confirmación antes de proceder

3. **Actualizar versión**
   - Editar `package.json` con la nueva versión
   - Commitear el cambio con mensaje: `chore: bump version to X.Y.Z`
   - Push a `origin/main`

4. **Crear GitHub Release**
   - Generar release notes basándose en commits desde el último tag
   - Si no hay tags previos, usar los últimos 5-10 commits
   - Crear release con `gh release create vX.Y.Z`
   - Incluir enlace al release en el output

5. **Monitorear publicación**
   - Esperar ~10 segundos para que el workflow inicie
   - Obtener el run ID del workflow más reciente
   - Monitorear con `gh run watch <run-id> --exit-status`
   - Si falla, mostrar link a los logs

6. **Verificar npm**
   - Esperar 5 segundos adicionales
   - Ejecutar `npm view uvd-x402-sdk version`
   - Confirmar que la versión publicada coincide con la esperada
   - Mostrar mensaje de éxito con instrucción de instalación

## Output esperado:

```
✅ Verificación completada
   - Rama: main
   - Versión actual: 2.22.0
   - Commits sin push: 0

📦 Nueva versión: 2.23.0 (minor bump)
   Cambios incluidos:
   - feat: add USDT0 support on Monad (c4e4dcf)
   - fix: add clientAddresses param to getReputation() (f4e2d9f)

🚀 Release creado: https://github.com/UltravioletaDAO/uvd-x402-sdk-typescript/releases/tag/v2.23.0

⏳ Workflow ejecutando... (run ID: 21810493197)
✅ Workflow completado en 42s

✅ uvd-x402-sdk@2.23.0 publicado exitosamente en npm
   npm install uvd-x402-sdk@2.23.0
```

## Manejo de errores:

- Si hay cambios sin commitear → abortar con mensaje claro
- Si no estamos en main → abortar
- Si estamos detrás de origin/main → abortar y sugerir pull
- Si el workflow falla → mostrar link a logs de GitHub Actions
- Si npm no muestra la versión esperada → advertir que puede tardar en propagarse

## Notas importantes:

- NUNCA bumpar la versión si ya hay commits sin push (deben incluir el bump)
- SIEMPRE pedir confirmación antes de crear el release
- SIEMPRE verificar que el tag git apunte al commit correcto (lección aprendida)
- Si un tag ya existe localmente pero no en remote, borrarlo antes de crear el release
- Usar `gh release create` con `--title` y `--notes`, NO especificar commit manualmente
