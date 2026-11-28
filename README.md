# Fetcher & Sender UNSA

Panel web personal en ejecución local para sincronizar tareas de Aula Virtual UNSA (DUTIC), gestionar notas personales, autorizar entregas de archivos PDF con comprobante visual y conectar asistentes de IA mediante un servidor MCP aislado dentro de Docker.

## Requisitos previos

- **Docker Engine** o **Docker Desktop** con soporte para **Docker Compose**.
- **Node.js** (opcional): requerido únicamente si usas el lanzador multiplataforma `npm run up` para detección automática de puertos libres en `127.0.0.1`. También puedes iniciar directamente con `docker compose`.

## Inicio rápido (Windows, macOS y Linux)

### 1. Configura tu archivo `.env`

Crea tu configuración local a partir de `.env.example` sin sobrescribir un archivo existente:

**Linux / macOS:**

```bash
cp -n .env.example .env
```

**Windows (PowerShell):**

```powershell
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
```

Abre `.env` y verifica que `AULA_PORTAL_URL` apunte al período académico vigente (por ejemplo `https://aulavirtual.unsa.edu.pe/2026B/` o el período correspondiente a tu semestre).

### 2. Levanta los contenedores

Tienes dos opciones equivalentes:

**Opción A — Imagen publicada en GHCR (inicio rápido sin compilar localmente):**

La configuración de `compose.yaml` usa por defecto `ghcr.io/f4brici0l4yme/fetcher-n-sender-unsa:latest` (configurable con `APP_IMAGE`).

```bash
docker compose pull
npm run up -- --no-build
```

Si no tienes Node.js en tu equipo anfitrión, puedes arrancar directamente con Docker Compose:

```bash
docker compose pull
docker compose up -d --no-build --wait
```

**Opción B — Compilación local con `npm run up`:**

```bash
npm run up
```

El lanzador multiplataforma (`scripts/start-local.mjs`, compatible con PowerShell, CMD, macOS y Linux) verifica Docker, detecta puertos libres en `127.0.0.1` a partir de `APP_PORT` (`3000`) y `LOGIN_VIEWER_PORT` (`6080`), crea la carpeta sandbox `./entregas`, espera a que el servicio pase su verificación de salud HTTP y actualiza `.runtime-panel-url`.

> **Modo sandbox por defecto vs. desarrollo local:** `compose.yaml` ejecuta directamente la imagen aislada con su compilación preconstruida (`/workspace/dist`) sin montar el código fuente del equipo anfitrión. Si estás desarrollando cambios locales sobre el repositorio, usa el archivo de sobrecarga `compose.dev.yaml`:
>
> ```bash
> docker compose -f compose.yaml -f compose.dev.yaml up -d --wait
> ```

### 3. Conecta tu sesión en `/sesion`

1. Abre la URL del panel que muestra la consola (por defecto `http://127.0.0.1:3000/sesion`).
2. Comprueba que el **Portal configurado (`AULA_PORTAL_URL`)** corresponda a tu período académico actual.
3. Ingresa el correo de tu perfil institucional y pulsa **Conectar sesión**.
4. Abre el visor local temporal usando la contraseña temporal mostrada en pantalla (protege solo el visor local; no es tu contraseña de Aula Virtual) e inicia sesión directamente en el portal oficial.
5. Una vez verificada la sesión, el visor se cierra automáticamente y las sincronizaciones continúan en segundo plano.

### 4. Sincronización y entrega de PDFs

- El panel lista tus tareas sincronizadas y notas personales en `http://127.0.0.1:3000/`.
- Para entregar un trabajo, abre la tarea, adjunta el archivo PDF y autoriza explícitamente el envío. Al confirmarse, la aplicación guarda una captura de comprobante visual.

## Conexión de asistentes de IA (MCP)

El servidor MCP corre integrado dentro del contenedor Docker sin depender de rutas ni binarios del equipo anfitrión.

### Streamable HTTP (Recomendado)

Apunta tu cliente MCP a la URL loopback activa (consulta `/agente` si se asignó otro puerto):

```json
{
  "mcpServers": {
    "aula-virtual-unsa": {
      "url": "http://127.0.0.1:3000/mcp"
    }
  }
}
```

### STDIO (para clientes solo-STDIO)

```json
{
  "mcpServers": {
    "aula-virtual-unsa": {
      "command": "docker",
      "args": ["compose", "exec", "-T", "app", "node", "dist/adapters/mcp/stdio.js"]
    }
  }
}
```

> El modo STDIO requiere que el cliente ejecute `docker compose` desde la raíz del repositorio (o indique el archivo Compose con `-f`). Por esa razón se recomienda Streamable HTTP siempre que tu cliente lo soporte.

## Privacidad y aislamiento

- **Uso estrictamente local y monousuario:** tanto el panel como el visor temporal y el endpoint `/mcp` escuchan únicamente en `127.0.0.1` y bloquean orígenes externos. No expongas estos puertos a la red ni a Internet.
- **Sin datos personales en Git ni en la imagen Docker:** `.env`, perfiles del navegador, cookies, PDFs, comprobantes y `.runtime-panel-url` permanecen fuera de la imagen y del control de versiones.
- **Volúmenes privados por instalación:** cada equipo crea sus propios volúmenes locales (`postgres_data`, `uploads`, `sessions`) y una carpeta sandbox en solo lectura (`./entregas` montada en `/inbox`) para entregas mediante MCP.
- **Detener sin perder datos:** ejecuta `docker compose down` (evita `-v` salvo que quieras borrar completamente tus volúmenes locales).

## Documentación adicional

- [Guía de desarrollo y operación con Docker](docs/desarrollo-docker.md)
- [Conexión de asistentes de IA mediante MCP en Docker](docs/harness-mcp.md)
- [Detalles de sesión personal persistente](docs/sesion-personal.md)
- [Demo de captura asistida](docs/demo-captura-asistida.md)
