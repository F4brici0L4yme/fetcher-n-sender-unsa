# 03 · Panel web MVC

**Rama** `feat/web-panel`  
**Archivos a tu cargo** `src/adapters/web/`, incluidas sus pruebas.

Aplica la [guía de programación para agentes](../../AGENTS.md) durante toda la implementación.

## Qué entregas

Un panel web local para **Buscar tareas**, abrir una tarea, cargar el PDF terminado y **Entregar**. Las vistas muestran curso, título, plazo, destino, nombre del PDF y estado del trabajo. Las tareas sin fecha aparecen en su propia sección después de las próximas. Los estados visibles incluyen búsqueda en curso, PDF cargado, entrega confirmada, error y por verificar.

## Instrucciones para tu agente

1. Parte del SHA común y trabaja con los casos de uso simulados definidos por el [responsable 01](01-nucleo-y-persistencia.md#contratos-compartidos). Usa controladores NestJS, Express y vistas Handlebars. Valida los datos HTTP en el controlador, llama al caso de uso por inyección y prepara un modelo de vista. Usa los repositorios y el navegador a través de los casos de uso.
2. Implementa estos puntos de entrada. El panel conserva el identificador devuelto por cada trabajo y consulta su estado mientras está en curso. Usa la cuenta local configurada para las acciones del piloto.

   | Ruta | Acción |
   |---|---|
   | `GET /` | Ver bandeja y estado de la última búsqueda. |
   | `POST /busquedas` | Iniciar búsqueda y devolver el identificador de trabajo al panel. |
   | `GET /tareas/:taskId` | Ver actividad, plazo, destino, PDF vigente y estado de entrega. |
   | `POST /tareas/:taskId/pdf` | Recibir un único campo multipart `pdf` con límite de 20 MiB y llamar a `CargarPdf`. |
   | `POST /tareas/:taskId/entregas` | Recibir el `pdfId` que se mostró al estudiante y llamar a `SolicitarEntrega`. |
   | `GET /trabajos/:jobId` | Consultar el estado y el resumen del trabajo. |

3. Antes de habilitar **Entregar**, muestra la actividad y el archivo exacto que autorizará el estudiante. Para destino externo, ambiguo o sin PDF, muestra el motivo y deja la acción deshabilitada. Si el archivo cambió desde que se abrió la pantalla, actualiza los datos y vuelve a presentar el PDF que se autorizará. Cuando un intento queda por verificar, muestra el estado y evita ofrecer otro envío.
4. En la ficha, muestra los errores de carga junto al campo y conserva la información del último PDF válido. Muestra el diagnóstico breve de la búsqueda o entrega para que el usuario sepa si debe recuperar la sesión o revisar el aula.

## Aceptación y coordinación

El panel se abre en `/`. En desarrollo, `DEMO_MODE=true` activa los simuladores y deja `/__demo` como acceso anterior al mismo panel. Sigue la [guía Docker](../desarrollo-docker.md) para probarlo.

Prueba con casos de uso simulados el recorrido de búsqueda, carga y autorización. Cubre un PDF inválido, tarea sin fecha, destino no admitido, archivo desactualizado, doble clic y entrega por verificar. La autorización debe enviar al caso de uso el `pdfId` que la vista presentó.

Ejecuta `docker compose exec app npm run build` y `docker compose exec app npm test`. Indica al responsable 01 qué módulo exportas y qué dependencias inyecta. Mantén cambios de configuración raíz y ensamblaje en su rama.

[NestJS MVC](https://docs.nestjs.com/techniques/mvc)
