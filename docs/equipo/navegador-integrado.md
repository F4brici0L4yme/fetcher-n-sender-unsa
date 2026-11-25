# Pendientes del navegador integrado

El panel, la cola y los adaptadores de captura y entrega se pueden probar juntos con un navegador simulado. Antes de usar una cuenta académica hay dos pruebas de integración con el navegador real pendientes.

| Prueba pendiente | Evidencia para cerrarla |
|---|---|
| **02 · Despacho desde el panel** | Un clic en **Buscar tareas** inicia un turno visual en la sesión de escritorio correcta sin enviar otro mensaje. El turno lee una actividad de prueba con la cuenta esperada y el mismo trabajo la registra en PostgreSQL. |
| **04 · Carga y confirmación** | Tras pulsar **Autorizar y entregar**, el navegador adjunta el PDF exacto sin que el estudiante abra un selector. El agente observa el estado final y registra la evidencia. Si se interrumpe la conexión, la reconciliación consulta en solo lectura y mantiene el estado por verificar cuando la evidencia no identifica el PDF. |

La interfaz pública de App Server documenta el inicio de turnos. Queda por identificar y demostrar una forma admitida de dar al turno acceso al navegador integrado de escritorio. Los enlaces `codex://new` rellenan el compositor y requieren un envío manual. La documentación del navegador integrado también indica una limitación en la automatización de cargas. [App Server](https://learn.chatgpt.com/docs/app-server) · [Enlaces de escritorio](https://learn.chatgpt.com/docs/app/commands#deep-links) · [Navegador integrado](https://learn.chatgpt.com/docs/browser#computer-use-in-the-browser)

Cuando exista un proveedor compatible, conéctalo desde el ensamblaje usando `ASSIGNMENT_FETCHER` y `ASSIGNMENT_SENDER`. Usa la misma cuenta y URL base del periodo para ambos. El proveedor de entrega debe poder leer los bytes autorizados desde Docker con el nombre correcto. La prueba real se hace con una actividad de prueba y la orden de entrega explícita.

## Cómo probar mientras tanto

Sigue la [guía Docker](../desarrollo-docker.md) y arranca el panel con `DEMO_MODE=true`. El panel marca las operaciones como simuladas. La base de datos y los PDF usan los volúmenes del proyecto. Fuera del modo de prueba, la captura informa que el navegador aún no está configurado.
