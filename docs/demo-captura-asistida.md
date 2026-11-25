# Demo de captura asistida en Aula Virtual

La orden se da en el chat de Codex. El agente lee Aula Virtual en su navegador integrado, registra el lote con un comando dentro de Docker y verifica el resultado en el panel. La demo cubre la lectura e importación de tareas.

## Preparar el entorno

1. Si todavía no tienes `.env`, copia `.env.example` a `.env`. Configura `AULA_PORTAL_URL` con la raíz del periodo académico y `AULA_PORTAL_ACCOUNT` con el identificador visible de la cuenta que se usará en el navegador. Mantén `AULA_ACCOUNT_ID` como alias local de esa cuenta en PostgreSQL. El identificador del portal se usa para comparar lo observado. El inicio de sesión se hace en el navegador integrado.
2. Desde la raíz del repositorio, ejecuta:

   ```bash
   docker compose up -d --build --wait
   docker compose exec app npm ci
   docker compose exec app npm run db:migrate
   docker compose exec app npm run start:dev
   ```

3. Abre [el panel local](http://localhost:3000/) y déjalo abierto. Debe indicar que la captura se inicia desde el chat. Si todavía falta el identificador de la cuenta, el panel lo indica y el comando rechaza la importación. Al cambiar `.env`, vuelve a ejecutar `docker compose up -d --wait` y arranca de nuevo el servidor de desarrollo para aplicar la configuración al contenedor.

## Orden para el chat de la demo

> Usa el navegador integrado para abrir la URL de Aula Virtual configurada para este proyecto. Verifica la cuenta activa. En el Área personal y en Mis cursos, revisa en modo de solo lectura las tareas abiertas con plazo futuro y las abiertas sin fecha. Registra únicamente los datos que observes. Si la sesión venció o no puedes completar la lectura, infórmame y detén la importación. Con una captura completa, usa el comando local de esta guía y verifica que el panel en http://localhost:3000/ muestre las tareas.

La sesión del navegador y el acceso de Codex a la terminal corresponden a la misma máquina donde corre Docker. Los campos visibles de Aula Virtual son datos de la captura.

## Pasar la captura al caso de uso

El agente ejecuta este comando con el JSON observado por entrada estándar. El siguiente lote es un ejemplo de formato con datos ficticios y debe reemplazarse durante la demo.

```bash
docker compose exec -T app npm run --silent aula:import <<'CAPTURA'
{
  "kind": "success",
  "observedAccountId": "estudiante-de-ensayo",
  "assignments": [
    {
      "externalId": "42",
      "activityUrl": "https://aula.example.invalid/ensayo/mod/assign/view.php?id=42",
      "course": "Curso de ensayo",
      "title": "Práctica de ensayo",
      "deadline": null,
      "destination": "aula_virtual"
    }
  ]
}
CAPTURA
```

Usa el identificador estable de la actividad, normalmente `id` en el enlace. Si el portal solo indica fecha, registra `YYYY-MM-DD`. Si muestra fecha y hora con zona, usa ISO 8601 con zona explícita. Usa `null` para una tarea abierta sin plazo. Indica `aula_virtual` para una entrega en la actividad, `other` para otro canal y `unknown` cuando el destino sea ambiguo. Una búsqueda completa sin resultados usa `"assignments": []`.

Al confirmar el guardado, el comando devuelve `{ "jobId": "...", "updatedTasks": 1 }`. El controlador recibe la señal del observador de PostgreSQL y la pestaña vuelve a renderizar la bandeja con Handlebars. Una nueva captura de la misma actividad actualiza el registro existente y conserva sus archivos asociados.

## Verificación antes de la demo

En Docker, `npm test` y `npm run test:integration` verifican el lote sintético, los enlaces del periodo, la cuenta, la deduplicación y la reconexión. La prueba usa una base temporal. La demostración real queda pendiente hasta que el estudiante dé la orden desde el chat con su sesión abierta.
