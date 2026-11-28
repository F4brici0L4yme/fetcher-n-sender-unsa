# Sesión personal de Aula Virtual

Esta instalación es **local y personal**, con una cuenta activa a la vez. No es un servicio multiusuario y no debe publicarse directamente en Internet.

## Conectar y trabajar

1. Inicia Docker siguiendo [Desarrollo con Docker](desarrollo-docker.md).
2. En el panel, selecciona **Conectar sesión** e introduce el correo que aparece en tu perfil de Aula Virtual. Este dato identifica la cuenta; **no es una contraseña**.
3. Abre el navegador de conexión protegido indicado por el panel e inicia sesión manualmente. El programa no escribe ni guarda tu contraseña.
4. El adaptador consulta el perfil de Moodle y compara el correo observado con el solicitado. Si no coincide, no permite capturas ni entregas. El navegador visible se cierra al terminar o después de cinco minutos.
5. Las búsquedas y entregas autorizadas posteriores usan Chromium en segundo plano. Una redirección al login marca la sesión como vencida y requiere reconexión.

El portal se toma de `AULA_PORTAL_URL`, incluido su periodo; no existe una lista de años permitidos. La captura recorre los enlaces de cursos, actividades y paginación del portal configurado, con límites de 150 páginas, 50 cursos y 500 actividades. Superar un límite falla la búsqueda completa: no se presenta un lote parcial como completo. Los plazos que no se pueden interpretar permanecen sin fecha.

## Entrega del PDF

El panel conserva una autorización asociada a una cuenta, actividad y versión concreta del PDF. El adaptador abre únicamente esa actividad, lee el PDF autorizado, verifica SHA-256 y adjunta **esos mismos bytes** con el nombre original. No busca archivos por su cuenta.

No reemplaza archivos o borradores que ya existan en Moodle. Después de guardar, comprueba la actividad, el archivo y el estado antes de enviar para calificación. Solo el estado explícito de entrega enviada confirma una operación. Los errores después de una posible escritura externa dejan el trabajo en `needs_verification`, sin reenvío automático.

Si Moodle exige una declaración personal de autoría, el adaptador no la acepta por el estudiante: deja la entrega por verificar y el estudiante debe completar esa declaración en Moodle. Una revisión posterior de una entrega existente sin hash verificable tampoco se marca como confirmada únicamente por coincidencia del nombre.

## Cambiar de cuenta

Selecciona **Desconectar** antes de iniciar otra cuenta. Desconectar cancela búsquedas pendientes y autorizaciones de entrega aún no ejecutadas de esa cuenta, y elimina su perfil de navegador local. No borra sus notas, tareas, PDFs ni historial confirmado. No se permite desconectar mientras una entrega está en ejecución.

Cada correo normalizado y portal genera un identificador opaco distinto bajo el espacio configurado por `AULA_ACCOUNT_ID`. Los datos de otra cuenta no se reutilizan. Los datos importados previamente bajo el alias legado no se reasignan automáticamente a un correo nuevo.

## Protección de la sesión

- Perfiles en un volumen fuera del repositorio, con directorios `0700` y archivos creados bajo `umask 077`.
- Las cookies de sesión de Moodle pueden desaparecer al cerrar Chromium aunque se use un perfil persistente. El adaptador conserva adicionalmente una instantánea **solo de cookies aplicables al portal**, con permisos `0600`, y la restaura al abrirlo. No exporta cookies de otros sitios ni del navegador Orca.
- Se rechazan rutas de perfil con enlaces simbólicos y rutas de archivos no válidas. El archivo PDF se abre sin seguir enlaces simbólicos y se verifica antes de adjuntarlo.
- Chromium usa su sandbox. El programa no añade `--no-sandbox` ni expone un puerto de depuración remota.
- Una exclusión en memoria serializa login/captura/entrega. Un bloqueo PostgreSQL durante la vida de la instancia impide dos procesos personales sobre la misma base de datos. Si se pierde el bloqueo por fallo de conexión, se cierra el contexto y se requiere reiniciar la aplicación.
- Esto es **protección local por permisos**, no cifrado de disco. El usuario administrador del equipo o alguien con acceso al daemon de Docker puede leer los volúmenes. Para proteger un equipo apagado, utiliza cifrado del disco del sistema y protege sus copias de seguridad.

Nunca copies perfiles, instantáneas de cookies, PDFs reales ni contraseñas en Git, fixtures, capturas de pantalla o logs.

## Verificación y límites

Las pruebas usan Chromium real con un Moodle sintético y una base de datos temporal. No envían archivos a DUTIC real. Cubren identidad incorrecta, vencimiento, aislamiento, exclusión de instancias, cancelación al desconectar, persistencia de cookies y envío de bytes/nombre autorizados.

Los selectores reconocen formularios estándar de Moodle en español e inglés. Un tema distinto, un perfil sin correo visible, SSO adicional, archivos existentes o una confirmación ambigua pueden requerir intervención. Las pruebas sintéticas no demuestran compatibilidad con cada instalación real: valida con una actividad de prueba y autorización explícita antes de usar entregas reales.
