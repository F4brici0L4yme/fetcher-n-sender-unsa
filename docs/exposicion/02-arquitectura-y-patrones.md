# Expositor 2 · Arquitectura y patrones

**Tiempo total: 2 min 15 s · Del 2:45 al 5:00**

Deja preparados tres archivos en el editor. Usa los nombres de las funciones para señalar los fragmentos durante la exposición. Abre los [diagramas UML](uml/README.md) para acompañar la explicación.

| Tiempo | Qué mostrar y decir |
|---|---|
| **2:45–3:25 · MVC** | Abre [`panel.controller.ts`](../../src/adapters/web/controllers/panel.controller.ts) y muestra `index()`. «El **Modelo** vive en los casos de uso y los datos persistidos. El **Controlador** NestJS recibe `GET /`, consulta `ListarTareas` y prepara los grupos. La **Vista** Handlebars renderiza lo que el controlador le entrega». |
| **3:25–4:05 · Puertos, adaptadores y Repository** | Abre [`assignment-import.ts`](../../src/core/application/assignment-import.ts) y muestra `ImportarTareasObservadas`. «El comando valida la captura y llama al caso de uso. El caso de uso depende del puerto `AssignmentImportRepository`. Su implementación con PostgreSQL guarda las tareas. Si la misma actividad vuelve a llegar, actualiza el registro existente por cuenta e identificador externo». |
| **4:05–4:45 · Observer** | Abre [`repositories.ts`](../../src/adapters/persistence/repositories.ts) y muestra `recordImport()` y `pg_notify`. «El repositorio guarda la tarea y el trabajo en una transacción. Al confirmar el guardado, PostgreSQL notifica al observador mediante `LISTEN`. El controlador avisa a la pestaña por **Server-Sent Events** y la página pide otra vez `GET /`. Por eso vimos el cambio sin tocar el botón de recargar». |
| **4:45–5:00 · Cierre** | Vuelve al panel con la tarea visible. «La orden entró por Codex, el caso de uso persistió la tarea y MVC presentó el resultado. La señal del observador solo lleva una revisión. La vista vuelve al controlador para obtener los datos». |

## Recorrido completo

```text
Chat de Codex → Aula Virtual → comando aula:import
  → caso de uso → repositorio PostgreSQL → COMMIT
  → LISTEN/NOTIFY → controlador SSE → nueva petición GET / → vista Handlebars
```

Si preguntan desde dónde escucha la vista, abre [`panel.js`](../../src/adapters/web/public/panel.js). `EventSource` escucha `/eventos/tareas`. El código compara la revisión del evento con la que quedó en el HTML y solo solicita otra vez la página cuando ambas difieren.
