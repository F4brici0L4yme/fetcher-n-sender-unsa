# 04 · Entrega en Aula Virtual

**Rama** `feat/aula-sender`  
**Archivos a tu cargo** `src/adapters/sender/`, incluidas sus pruebas y fixtures.

## Qué entregas

Un adaptador para que el agente visual adjunte el PDF autorizado a la actividad correcta y verifique la entrega en Aula Virtual. Usa el navegador integrado acordado con el responsable 02. El sistema inicia la operación a partir de la autorización del estudiante en el panel.

## Instrucciones para tu agente

1. Parte del SHA común. Implementa `AssignmentSender.submit(order)` y `AssignmentSender.verify(order)` según el [contrato del núcleo](01-nucleo-y-persistencia.md#contratos-compartidos). Usa la identidad de la actividad, la cuenta y la ruta del PDF suministradas por la aplicación. Ante una discrepancia o una sesión vencida, devuelve un error antes de modificar el portal.
2. Valida primero la carga automática en una actividad de prueba. Reproduce la navegación y el gesto de adjuntar en el mismo navegador integrado que usará el piloto. Comprueba si el entorno ofrece una interfaz de carga que permita seleccionar el archivo desde el turno visual. La prueba se acepta cuando el agente adjunta el PDF correcto sin que el estudiante seleccione el archivo manualmente. Si la capacidad no está disponible, devuelve el bloqueo explícito y deja operativas las pruebas con simuladores.
3. Para ejecutar, abre la actividad autorizada y verifica cuenta, identidad y estado. Adjunta el PDF con el nombre previsto. Completa las acciones de guardado y envío para calificación que requiera esa pantalla y comprueba el estado final. Una carga guardada como borrador todavía no confirma una entrega.
4. Devuelve `confirmed` con evidencia atribuible al PDF autorizado. Si el portal rechaza la acción sin modificación, devuelve `failed`. Si se interrumpe un paso que pudo modificar la entrega, devuelve `needs_verification`. En `verify`, solo consulta la actividad y compara el resultado con la orden original. Conserva el estado incierto si el portal no muestra evidencia suficiente para atribuir la entrega al intento.

## Aceptación y coordinación

Prueba una actividad cerrada, sesión vencida, cuenta incorrecta, actividad incorrecta, borrador, entrega confirmada y conexión perdida después de una acción que pudo enviar. La verificación posterior a un fallo incierto debe operar en modo lectura.

Con el responsable 02, documenta qué capacidad del navegador usaste para cargar y qué texto o referencia demuestra el resultado final. Ejecuta `npm run build` y `npm test`. Envía al responsable 01 el nombre del adaptador, las condiciones de ejecución y cómo reproducir la prueba. La carga y la entrega reales se verifican en una actividad de prueba autorizada.

[Estados de entrega en Moodle](https://docs.moodle.org/26/en/Viewing_an_assignment) · [Capacidades del navegador integrado](https://learn.chatgpt.com/docs/browser#computer-use-in-the-browser)
