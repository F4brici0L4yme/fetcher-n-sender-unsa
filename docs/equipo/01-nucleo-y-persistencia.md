# 01 · Núcleo y persistencia

**Rama** `feat/core-persistence`  
**Archivos a tu cargo** `src/core/`, `src/adapters/persistence/`, `src/bootstrap/` y configuración raíz.

## Flujo del piloto

1. El estudiante pulsa **Buscar tareas**. Un agente visual examina Aula Virtual y la aplicación guarda las tareas próximas en PostgreSQL.
2. El estudiante abre una tarea y carga el PDF terminado. El panel enseña el nombre del archivo y la actividad de destino.
3. Al pulsar **Entregar**, el estudiante autoriza ese PDF para esa actividad. El agente lo envía y verifica en el aula el resultado que verá el estudiante en el panel.

El piloto es local, monousuario y opera en Aula Virtual. Las búsquedas se inician desde el panel. La generación de documentos y los demás canales quedan para la versión ampliada.

## Base común antes de repartir las ramas

Prepara el primer commit de `main` con Node.js, TypeScript estricto, NestJS, Express, Handlebars, Drizzle y PostgreSQL. Incluye los tipos y puertos de abajo, los tokens de inyección de Nest, casos de uso y adaptadores simulados para que cada compañero pueda ejecutar su parte. Expón scripts raíz `npm run build` y `npm test`. Comparte el SHA de esa base con los cuatro compañeros. Cada rama empieza en ese commit. Los cambios a contratos o dependencias raíz se coordinan contigo y entran primero en un PR pequeño.

## Contratos compartidos

Los tipos del dominio viven en `src/core/domain/`. Las interfaces de entrada y salida viven en `src/core/application/ports/`. Usa tipos de TypeScript sin dependencias en Nest, HTTP, Drizzle o Codex. Inyecta los adaptadores por constructor en el ensamblaje de `src/bootstrap/`.

| Contrato | Datos mínimos y responsabilidad |
|---|---|
| `BuscarTareas(accountId)` | Encola una búsqueda a demanda y devuelve `{ jobId }`. El worker usa `AssignmentFetcher` y persiste la captura validada. |
| `AssignmentFetcher.fetch({ jobId, accountId })` | Devuelve una lista de `CapturedAssignment` o un resultado tipado de sesión vencida, integración no disponible o error. Un resultado vacío exitoso es válido. |
| `CapturedAssignment` | `externalId`, `course`, `title`, `activityUrl`, `deadline`, `destination`. El plazo es `null`, una fecha local `YYYY-MM-DD`, o un instante ISO 8601 con zona. El destino es `aula_virtual`, `other` o `unknown`. |
| `ListarTareas(accountId)` / `VerTarea(accountId, taskId)` | Devuelven tareas de la cuenta con curso, título, plazo, destino, PDF vigente y estado de entrega. Ordenan por plazo ascendente y muestran al final las tareas abiertas sin fecha. |
| `CargarPdf({ accountId, taskId, originalName, content })` | Valida un PDF no vacío de hasta 20 MiB. Guarda una copia inmutable y devuelve `{ pdfId, originalName, sha256 }`. El almacén local usa claves internas. |
| `SolicitarEntrega({ accountId, taskId, pdfId })` | Valida que el PDF es el actualmente mostrado y el destino es Aula Virtual. Fija la cuenta, actividad y archivo autorizados, encola un intento y devuelve `{ jobId }`. Una acción duplicada devuelve el trabajo existente. |
| `AssignmentSender.submit(order)` / `AssignmentSender.verify(order)` | Reciben la orden fijada por la aplicación. `submit` puede modificar el aula. `verify` consulta el estado con solo lectura. Ambos devuelven un resultado tipado con estado y evidencia. |
| `ConsultarTrabajo(accountId, jobId)` | Devuelve `{ jobId, kind, state, summary }`. La búsqueda usa `queued`, `running`, `completed` y `failed`. La entrega usa `authorized`, `running`, `confirmed`, `failed` y `needs_verification`. |

La orden de entrega contiene `jobId`, `accountId`, `externalId`, `activityUrl`, `pdfId`, `originalName` y `sha256`. Al ejecutar el puerto, el worker añade `localFilePath`, una ruta controlada por la aplicación. El resultado del sender usa `confirmed`, `failed` o `needs_verification`. La evidencia mínima es la URL de actividad, el estado visible y la referencia del portal si aparece. Acepta `confirmed` solo con evidencia atribuible al intento.

## Implementación de tu rama

- Implementa repositorios para tareas, PDF y trabajos. Usa una restricción única por cuenta e identificador externo. Guarda fechas con hora como instantes y conserva las fechas sin hora. Para el filtro de próximos, usa la hora actual para instantes y el día local en `America/Lima` para fechas sin hora.
- Valida datos observados antes de persistirlos. Actualiza campos por clave externa y conserva los PDF e intentos al resincronizar. Mantén el último PDF válido si falla una nueva carga. Controla el acceso al directorio y comprueba el checksum antes de enviar.
- Persiste el intento y la orden fijada en la misma transacción. Reclama trabajos de forma atómica y serializa el uso del navegador por cuenta. Una búsqueda interrumpida puede recuperarse. Una entrega interrumpida en ejecución pasa a `needs_verification`. Coordina la reconciliación con el sender y evita repetir un envío incierto.
- Ensambla los adaptadores de tus compañeros desde `src/bootstrap/`. Registra errores por trabajo sin guardar credenciales, datos completos del navegador ni contenido de los PDF en logs.

## Aceptación e instrucciones para tu agente

Prueba dos capturas con el mismo identificador, una fecha sin hora, un PDF inválido, una segunda carga durante un intento ya autorizado, un doble clic de entrega y un reinicio con un envío interrumpido. Verifica que un destino externo o ambiguo impide encolar la entrega. Usa PostgreSQL en al menos una prueba de integración de deduplicación y de persistencia de la orden.

Pide a tu agente que trabaje solo en los archivos a tu cargo, conserve los contratos acordados, ejecute build y pruebas y describa en el PR cómo reproducirlos. Integra con simuladores hasta que captura y entrega pasen las dos pruebas reales del navegador. Cierra el piloto con una entrega autorizada en una actividad de prueba.

[Captura](02-captura-aula-virtual.md) · [Panel](03-panel-web.md) · [Entrega](04-entrega-aula-virtual.md)
