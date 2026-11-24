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

El contenedor `app` queda listo para ejecutar comandos. Cuando el commit base incluya `package.json` y `package-lock.json`, usa:

```bash
docker compose exec app npm ci
docker compose exec app npm run build
docker compose exec app npm test
docker compose exec app npm run start:dev
```

Repite `npm ci` dentro del contenedor cuando cambie el lockfile. El responsable del commit base debe versionar `package-lock.json` y definir `build`, `test` y `start:dev`. Para abrir una terminal de trabajo, usa `docker compose exec app sh`.

La aplicación lee `DATABASE_URL` para conectarse a `db:5432`, `UPLOAD_DIR` para guardar los PDF y `HOST` y `PORT` para escuchar en `0.0.0.0:3000` dentro del contenedor. Al iniciar NestJS, el panel queda disponible en `http://127.0.0.1:3000` desde el equipo. Si ese puerto está ocupado, arranca Compose con `APP_PORT=3001 docker compose up -d --build --wait` y abre el puerto 3001.

## Detener el entorno

```bash
docker compose down
```

Los volúmenes conservan la base de datos, los PDF y las dependencias al recrear los contenedores. El usuario y la contraseña predeterminados son para el entorno de desarrollo local.

El navegador integrado del agente se ejecuta en su aplicación de escritorio. Los contenedores cubren las dependencias del proyecto. Los adaptadores visuales se prueban con simuladores dentro del entorno de desarrollo y con el navegador real desde el escritorio.
