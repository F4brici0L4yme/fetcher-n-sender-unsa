# Ejecutar el programa personal con Docker

El programa está diseñado para **una persona en su propio equipo**, con una cuenta académica activa por vez. El panel y el navegador de login solo se publican en `127.0.0.1`; no es un servicio multiusuario ni debe exponerse directamente a Internet.

## Primer inicio

Instala Docker Engine o Docker Desktop con Docker Compose. Desde la raíz del repositorio:

**1. Crea tu `.env` local (solo si todavía no existe; no reemplaces tu configuración anterior):**

En Linux / macOS:

```bash
cp -n .env.example .env
```

En Windows (PowerShell):

```powershell
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
```

**2. Inicia los servicios (compilación local o imagen publicada en GHCR):**

```bash
# Opción A (imagen precompilada en GHCR: ghcr.io/f4brici0l4yme/fetcher-n-sender-unsa:latest)
docker compose pull
npm run up -- --no-build

# Opción B (compilación local recomendada para desarrollo; detecta puertos libres y actualiza .runtime-panel-url)
npm run up

# Alternativa manual directa con Docker Compose
docker compose up -d --build --wait
docker compose logs -f app
```

`npm run up` ejecuta el lanzador multiplataforma `scripts/start-local.mjs` (compatible con Windows PowerShell/CMD, macOS y Linux; `sh scripts/start-local.sh` delega en el mismo script por compatibilidad). Parte de `APP_PORT` (`3000`) y `LOGIN_VIEWER_PORT` (`6080`) definidos en `.env` o en tus variables de entorno. Si otro proceso ya ocupa alguno de esos puertos en `127.0.0.1`, selecciona automáticamente el siguiente puerto libre (por ejemplo `3001` y `6081`), exporta `APP_PUBLIC_URL` hacia Compose, crea la carpeta sandbox `./entregas` y publica el servidor MCP integrado dentro del contenedor en `http://127.0.0.1:<APP_PORT>/mcp`.

Al completar el arranque saludable (`--wait`), `npm run up` escribe la URL loopback activa en `.runtime-panel-url` (con permisos `0600` en sistemas POSIX e ignorado por Git) para que las herramientas locales MCP y CLI descubran automáticamente el puerto en uso. Si quieres usar otra etiqueta de imagen en GHCR, define `APP_IMAGE` en tu entorno o `.env`.

Abre la URL mostrada al terminar (por defecto [http://127.0.0.1:3000/](http://127.0.0.1:3000/)). El contenedor verifica el lockfile, compila solo cuando falta `dist/bootstrap/main.js` o cuando se habilita `AUTO_BUILD=true`, aplica las migraciones y arranca el servidor. La primera construcción local descarga Chromium y puede tardar varios minutos; usar la imagen de GHCR evita esa descarga y compilación inicial.

Si conservas una configuración anterior de captura asistida, cambia **solo** `AULA_CAPTURE_MODE=browser` en tu `.env` para usar el navegador del contenedor. La URL `AULA_PORTAL_URL` debe apuntar al período académico vigente; no está limitada a un año específico. `AULA_ACCOUNT_ID` identifica esta instalación personal y no es una contraseña.

### Login y funcionamiento en segundo plano

1. Pulsa **Conectar sesión** en el panel e indica la identidad académica que vas a vincular.
2. Abre el visor local que presenta el panel y utiliza su contraseña temporal. Esa contraseña protege el visor, **no es tu contraseña de Aula Virtual**.
3. Escribe tus credenciales directamente en la página oficial de Aula Virtual mostrada dentro del visor. El programa no tiene un formulario para guardar contraseñas académicas.
4. Cuando el sistema comprueba la cuenta, cierra el navegador visible y el acceso al visor. Las capturas y entregas posteriores reutilizan el perfil en segundo plano.
5. Si la sesión vence, vuelve a conectar desde el panel. Para otra cuenta, desconecta primero y después vincula la nueva; las tareas y los PDF mantienen su cuenta propietaria.

Una entrega real requiere abrir la tarea, vincular el PDF correcto y autorizar explícitamente ese archivo. No pruebes entregas en actividades reales sin revisar esta autorización. La captura no realiza entregas.

## Archivos, datos y límites de seguridad

| Volumen | Contenido |
|---|---|
| `postgres_data` | Tareas, notas, trabajos y estado de conexión |
| `uploads` | PDF autorizables; no se sirven como directorio público |
| `sessions` | Perfiles de navegador aislados por cuenta |
| `node_modules` | Dependencias del proyecto (solo cuando se usa `compose.dev.yaml`) |

Los directorios de sesión y PDF se crean con permisos `0700`; el proceso utiliza `umask 077`. Esta protección local **no equivale a cifrado del disco**: el administrador del equipo, Docker y alguien con acceso al disco sin cifrar pueden leerlos. Usa cifrado de disco y protege las copias de seguridad si necesitas protección frente a ese riesgo. Nunca copies perfiles, cookies, archivos de sesión ni `.env` a Git o a un chat.

Chromium se ejecuta con un usuario no privilegiado. Compose utiliza el [perfil seccomp recomendado por Playwright](https://github.com/microsoft/playwright/blob/v1.65.1/utils/docker/seccomp_profile.json), que permite crear los espacios de nombres necesarios para el sandbox sin desactivar seccomp. El archivo versionado es `docker/chromium-seccomp.json` (SHA-256 `cc3e61cabda6bbc1e53e54d27ba4d55a9d3be829b6dd1a596f4a7b31b1cc7849`). No uses `--privileged`, `seccomp=unconfined` ni `--no-sandbox` para ocultar un error del sistema anfitrión. Si su política de seguridad impide el sandbox, el navegador debe fallar de forma explícita hasta que un administrador configure un entorno compatible.

El visor no está abierto permanentemente: la aplicación inicia x11vnc/websockify únicamente durante el login y los detiene al terminar. No hay un puerto VNC directo publicado; el puerto web del visor también está limitado al equipo local. No compartas ese puerto mediante túneles ni lo publiques en una red. El escritorio no monta ni accede al servidor gráfico de tu equipo.

## Comandos de desarrollo y prueba

De forma predeterminada, `compose.yaml` ejecuta la imagen aislada con su compilación incluida (`/workspace/dist`) sin montar el código fuente del equipo anfitrión. Para desarrollo local activo con código montado desde el repositorio y recompilación automática (`AUTO_BUILD=true`), agrega `compose.dev.yaml`:

```bash
docker compose -f compose.yaml -f compose.dev.yaml up -d --wait
```

Ejecuta npm **dentro de Docker**:

```bash
docker compose -f compose.yaml -f compose.dev.yaml exec -T app npm test
docker compose -f compose.yaml -f compose.dev.yaml exec -T app npm run test:integration
```

Las pruebas de integración usan bases de datos temporales. Las pruebas de navegador deben utilizar un Moodle sintético, nunca sesiones académicas reales. No ejecutes varios `npm run build` simultáneamente: Nest limpia `dist/` al compilar.

Para arrancar solo las dependencias y trabajar manualmente, sin que el arranque aplique migraciones:

```bash
docker compose up -d db
docker compose run --rm --service-ports app sleep infinity
# Desde otra terminal, usa docker exec <nombre-del-contenedor> ...
```

El punto de entrada ejecuta literalmente cualquier comando explícito distinto de `app`; ese modo no inicia Xvfb, compila ni migra automáticamente. Para el modo simulado o asistido consulta la [guía de captura asistida](demo-captura-asistida.md); no inicies otro servidor en el puerto del servidor que ya está funcionando.

### Configuración local

| Variable | Uso |
|---|---|
| `AULA_CAPTURE_MODE` | `browser` para sesión persistente; `assisted` conserva la importación desde el chat |
| `AULA_PORTAL_URL` | Origen HTTPS y ruta del período académico |
| `AULA_ACCOUNT_ID` | Espacio de nombres de la instalación personal |
| `APP_PORT` | Puerto del panel en el equipo, predeterminado `3000` |
| `LOGIN_VIEWER_PORT` | Puerto local del visor, predeterminado `6080` |
| `APP_PUBLIC_URL` | URL loopback activa del panel (`http://127.0.0.1:<APP_PORT>`); `npm run up` la define automáticamente |
| `MCP_INBOX_DIR` | Carpeta sandbox en solo lectura dentro del contenedor (`/inbox`, montada desde `./entregas`) para PDFs del MCP |
| `SESSION_DIR` | Dentro del contenedor: `/sessions` |
| `UPLOAD_DIR` | Dentro del contenedor: `/data/uploads` |
| `PROOF_DIR` | Dentro del contenedor: `/data/uploads/proofs` (capturas PNG de entregas confirmadas) |
| `APP_IMAGE` | Imagen Docker usada por `app` (predeterminada `ghcr.io/f4brici0l4yme/fetcher-n-sender-unsa:latest`) |
| `AUTO_BUILD` | Si es `true`, recompila `dist/` al arrancar el contenedor aunque ya exista `dist/bootstrap/main.js` (predeterminado `false`) |
| `AULA_AUTO_SYNC_INTERVAL_SECONDS` | Intervalo de sincronización automática en segundo plano (predeterminado `180`; `0` desactiva) |

PostgreSQL no publica un puerto en el equipo; la aplicación lo usa dentro de la red de Compose. La contraseña predeterminada de PostgreSQL es solo para esta instalación local. Cambiarla después de crear el volumen no cambia automáticamente la contraseña de la base ya existente.

Si cambias los puertos, recrea el servicio con `docker compose up -d`. No publiques el panel cambiando `127.0.0.1` por `0.0.0.0`.

## Detener y conservar los datos

```bash
docker compose down
```

Los volúmenes sobreviven a la recreación de contenedores. **No uses `docker compose down -v` salvo que quieras borrar todos los datos de esa instalación.** Desconectar una cuenta desde el panel es distinto de borrar la base de datos o los PDF.
