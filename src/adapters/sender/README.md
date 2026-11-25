# Entrega en Aula Virtual

`AulaVirtualSender` implementa `AssignmentSender`. El worker le pasa la orden inmutable y la ruta del PDF que ya verificó. El adaptador comprueba el origen, el periodo académico, la cuenta y la actividad. Carga el archivo y, si Moodle deja un borrador, lo envía para calificación y vuelve a inspeccionar el estado.

El ensamblaje registra el adaptador con `ASSIGNMENT_SENDER` cuando exista un navegador compatible. El constructor recibe `portalUrl`, `accountId` y `browser`. Usa la misma URL base del periodo y el mismo identificador de cuenta que en el adaptador de captura. La cuenta debe identificarse en la sesión visible.

## Contrato del navegador

- `openForSubmission` devuelve acceso a la actividad autorizada. `openForVerification` devuelve solo operaciones de lectura. Ambos garantizan una sesión separada para esa orden. La URL observada debe identificar la actividad incluso cuando el navegador muestra un formulario intermedio.
- `attachAndSave` recibe la ruta verificada, el nombre y el checksum del archivo. El proveedor debe disponer de los mismos bytes cuando el archivo vive en Docker y el navegador en el escritorio. Debe adjuntarlos usando el nombre autorizado.
- El adaptador confirma un envío propio cuando el portal muestra un único archivo que coincide con el nombre autorizado y el estado de entrega es final. Para reconciliar después de una interrupción, exige además que el checksum observado coincida. Sin esa evidencia, el estado sigue por verificar.
- Un borrador anterior con archivos requiere revisión. El adaptador conserva esos archivos. Ante una desconexión después de una acción capaz de modificar el portal, devuelve `needs_verification`. El worker consulta el estado en solo lectura.

La carga automática en el navegador integrado sigue pendiente de demostración. Las pruebas usan un navegador simulado y cubren borrador, sesión vencida, actividad incorrecta, evidencia final y desconexión. [Estados de entrega de Moodle](https://docs.moodle.org/en/Viewing_an_assignment) · [Capacidades del navegador integrado](https://learn.chatgpt.com/docs/browser#computer-use-in-the-browser)
