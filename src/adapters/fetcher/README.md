# Captura de Aula Virtual (02)

`AulaVirtualFetcher` implementa `AssignmentFetcher`. Al recibir `fetch({ jobId, accountId })`, invoca `VisualCaptureRunner.capture` una vez y exige una lectura de solo consulta (`readOnly: true`) del origen HTTPS configurado. El resultado debe incluir la cuenta observada y los datos de las actividades. El adaptador rechaza otra cuenta, URLs fuera del portal, campos inválidos y plazos mal formados. Conserva actividades futuras y abiertas sin fecha; mantiene `other` y `unknown` sin inferir el destino.

`VisualCaptureRunner` es la frontera con el agente visual. Todavía **no hay una implementación real de ese corredor**: el repositorio no ofrece una interfaz comprobada que, desde el clic del panel, inicie un turno con acceso al navegador integrado y devuelva una captura estructurada. No se debe sustituir esa prueba por un enlace `codex://new`, un turno sin navegador o una lista simulada. Mientras no exista un corredor verificado, construye el adaptador con `runner: null`; devuelve `unavailable` y el núcleo informa que la integración no está configurada.

Para integrarlo, el responsable 01 debe inyectar el corredor en `src/bootstrap/core.module.ts` usando `ASSIGNMENT_FETCHER`. Antes de activarlo hay que comprobar, en una cuenta y un portal de prueba autorizados, que un clic inicia el turno visual sin segundo mensaje, que el turno usa únicamente la cuenta y origen esperados, y que una actividad observada llega a PostgreSQL. El corredor debe limitarse a lectura y devolver `session_expired`, `unavailable` o `failed` cuando corresponda; nunca convertir esos casos en una lista vacía.

Prueba reproducible sin cuenta real: `npm run build && node --test dist/adapters/fetcher/aula-virtual.test.js`. La prueba del navegador real sigue pendiente.
