# Desarrollo con Docker

Instala Docker con el complemento Docker Compose. Desde la raíz del repositorio ejecuta:

```bash
docker compose up -d --build --wait
docker compose ps
docker compose exec app node --version
docker compose exec app npm --version
```

Compose arranca un contenedor de desarrollo con Node.js y npm y un contenedor con PostgreSQL. El código se monta desde el repositorio para que los cambios del editor se reflejen en el contenedor. Las dependencias npm, los PDF y la base de datos tienen volúmenes propios. PostgreSQL se usa dentro de la red de Compose.

## Programar y probar

Para preparar una sesión de captura desde Codex y actualizar el panel automáticamente, sigue la [guía de captura asistida](demo-captura-asistida.md). Los comandos de esta sección sirven para probar el piloto simulado.

El contenedor `app` queda listo para ejecutar los comandos del proyecto:

```bash
docker compose exec app npm ci
docker compose exec app npm run db:migrate
docker compose exec app npm run build
docker compose exec app npm test
docker compose exec app npm run test:integration
docker compose exec -e AULA_CAPTURE_MODE= -e DEMO_MODE=true app npm run start:dev
```

Repite `npm ci` dentro del contenedor cuando cambie el lockfile. La suite de integración usa su propia base de datos temporal. Para abrir una terminal de trabajo, usa `docker compose exec app sh`.

Abre [el panel](http://127.0.0.1:3000/). Pulsa **Buscar tareas** dos veces y comprueba que aparece una sola **Práctica de prueba**. Ábrela, carga un PDF y pulsa **Autorizar y entregar**. La pantalla debe mostrar **Entrega simulada confirmada**. El simulador usa una cuenta separada y una actividad ficticia.

La aplicación lee `DATABASE_URL` para conectarse a `db:5432`, `UPLOAD_DIR` para guardar los PDF y `HOST` y `PORT` para escuchar en `0.0.0.0:3000` dentro del contenedor. Si el puerto del equipo está ocupado, arranca Compose con `APP_PORT=3001 docker compose up -d --build --wait` y abre `http://127.0.0.1:3001/`. Los simuladores solo se activan con `NODE_ENV=development` y `DEMO_MODE=true`.

## Detener el entorno

```bash
docker compose down
```

Los volúmenes conservan la base de datos, los PDF y las dependencias al recrear los contenedores. El usuario y la contraseña predeterminados son para el entorno de desarrollo local.

El navegador integrado del agente se ejecuta en su aplicación de escritorio. Los contenedores cubren las dependencias del proyecto. Los adaptadores visuales se prueban con simuladores dentro del entorno de desarrollo y con el navegador real desde el escritorio.
