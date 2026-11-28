# Conexión de asistentes de IA mediante MCP en Docker

El servidor MCP viene integrado **dentro de la propia imagen Docker**, funcionando como un entorno aislado (sandbox) que no depende de rutas del equipo anfitrión, ni requiere instalar Node.js fuera de Docker, ni guarda credenciales o sesiones dentro de la imagen.

Cualquier persona que ejecute el contenedor obtiene su propio espacio limpio con volúmenes locales propios.

---

## Flujo en 3 pasos

1. **Inicia el contenedor local** con `npm run up` (o `docker compose up -d --build --wait`).
   Si el puerto `3000` ya está ocupado en `127.0.0.1`, `npm run up` elige automáticamente un puerto libre y muestra el endpoint activo.
2. **Conecta tu propia sesión en el panel** (`/sesion`): inicia sesión una sola vez en Aula Virtual UNSA. La sesión persiste en tu volumen privado local de Docker (`sessions`), nunca dentro de la imagen ni en Git.
3. **Conecta tu cliente de IA al MCP del contenedor** usando la URL local `http://127.0.0.1:<PUERTO>/mcp` (o el puente STDIO dentro de Docker) y pídele que liste tus tareas o suba tus PDFs.

---

## Métodos de conexión

### 1. MCP por HTTP integrado en Docker (Recomendado)

Funciona directamente contra el contenedor sin depender de rutas de carpetas ni binarios en tu computadora:

```json
{
  "mcpServers": {
    "aula-virtual-unsa": {
      "url": "http://127.0.0.1:3000/mcp"
    }
  }
}
```

> Si iniciaste otra instancia en otro puerto (por ejemplo `3001`), reemplaza el puerto por el que aparece en el indicador **Endpoint MCP local** de `/agente`.

### 2. MCP STDIO dentro de Docker (para clientes solo-STDIO)

Ejecuta el servidor STDIO directamente dentro del contenedor `app` sin exponer rutas de tu equipo (el parámetro `-T` desactiva la asignación de pseudo-TTY para preservar el flujo JSON-RPC por entrada/salida estándar):

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

> **Nota sobre el directorio de trabajo (CWD):** `docker compose exec` necesita ejecutarse con la raíz de este repositorio como directorio de trabajo actual (o pasar explícitamente `-f <ruta-al-compose.yaml>`). Siempre que tu cliente lo soporte, **se recomienda usar Streamable HTTP (`http://127.0.0.1:<PUERTO>/mcp`)**, ya que funciona independientemente del directorio actual y sin depender del CLI local de Docker.

### 3. API HTTP local en loopback

```bash
curl -s http://127.0.0.1:3000/api/agente/estado
curl -s "http://127.0.0.1:3000/api/agente/tareas?q=laboratorio%208%20de%20mn"

curl -s -X POST http://127.0.0.1:3000/api/agente/entregas \
  -F "pdf=@./entregas/Lab08.pdf;type=application/pdf" \
  -F "instruction=subeme el laboratorio 8 de mn" \
  -F "source=ai-mcp" \
  -F "executeIfAllowed=true"
```

---

## Cómo entregar PDFs sin exponer tu sistema de archivos

El servidor MCP dentro de Docker nunca accede a tu carpeta personal de usuario ni a tu sistema de archivos real. Tienes dos formas limpias y aisladas de entregar un PDF:

1. **Directamente desde el chat (`pdfBase64` + `fileName`):** adjuntas el PDF en tu chat o le pides a tu asistente que envíe el contenido del PDF codificado en Base64 a `aula_deliver_pdf`. Funciona incluso ejecutando la imagen Docker de forma independiente sin montar carpetas.
2. **Carpeta sandbox `entregas/` (`/inbox` en solo lectura dentro de Docker):** colocas tus PDFs en `./entregas/` (por ejemplo `./entregas/mn/Lab08.pdf`, ignorada por Git) y tu asistente usa `aula_find_local_pdfs` o `aula_deliver_pdf` dentro de ese espacio aislado.

---

## Herramientas MCP disponibles (9)

| Herramienta | Propósito |
|---|---|
| `aula_status` | Estado de la sesión persistente, política activa (`confirm_in_panel` / `direct_on_exact_match`), sincronización automática y contadores. |
| `aula_list_tasks` | Lista tareas sincronizadas; con `query` clasifica coincidencias sobre títulos y siglas de cursos reales de DUTIC. |
| `aula_sync_tasks` | Dispara una sincronización inmediata de tareas con Aula Virtual. |
| `aula_find_local_pdfs` | Busca PDFs válidos dentro de la carpeta aislada `entregas/` (`/inbox`), omitiendo ocultos y enlaces simbólicos. |
| `aula_deliver_pdf` | Prepara o ejecuta una entrega aceptando `pdfBase64` + `fileName` o una ruta dentro de `/inbox`, respetando la política activa y devolviendo captura PNG inline al confirmarse. |
| `aula_check_job` | Consulta el estado de un trabajo de sincronización o entrega y devuelve su comprobante PNG si existe. |
| `aula_discard_delivery` | Elimina un intento de entrega fallido o en estado `Por verificar` para volver a intentar limpiamente con el mismo PDF u otro nuevo. |
| `aula_list_notes` | Lista tus notas personales sincronizadas con la agenda. |
| `aula_create_note` | Crea una nota personal con prioridad (`alta`, `media`, `baja`) y fecha opcional. |

---

## Políticas y seguridad

- **`confirm_in_panel` (por defecto):** el agente prepara la tarea y valida el PDF; tú apruebas con 1 clic en `/agente` o `/`.
- **`direct_on_exact_match`:** ejecuta directamente solo cuando tanto el archivo como la tarea coinciden sin ambigüedad (nunca adivina ante números o cursos distintos).
- **Solo loopback + protección de origen:** el endpoint `POST /mcp` y la API `/api/agente/*` solo aceptan peticiones locales (`127.0.0.1`, `localhost`, `[::1]`) y bloquean orígenes externos.
- **Sin datos personales en la imagen:** `.dockerignore` excluye `.env`, sesiones, cargas y `entregas/`; cada despliegue crea sus propios volúmenes privados.
