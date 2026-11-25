# Expositor 1 · Demo en vivo

**Tiempo total: 2 min 45 s · Del 0:00 al 2:45**

## Antes de exponer

- Ten abiertas la bandeja en [localhost:3000](http://localhost:3000/) y la sesión autenticada de Aula Virtual en el navegador de Codex. Deja el chat listo para pegar el prompt.
- Reemplaza `[URL_DE_LA_ACTIVIDAD]` en el prompt por el enlace de la tarea que usarás en la demo.
- Comprueba que la bandeja dice «No hay tareas próximas». Si alguien repite la importación durante un ensayo, vuelve a limpiar solo los datos de la cuenta de la demo antes de presentar.
- Mantén visible la misma pestaña de la bandeja desde antes de dar la orden. Así el público verá que la tarea aparece sin pulsar recargar.

## Guion

| Tiempo | Qué mostrar y decir |
|---|---|
| **0:00–0:20** | Muestra la bandeja vacía. «Vamos a traer una tarea de Aula Virtual al panel local con una orden en el chat». |
| **0:20–1:30** | Pega el prompt. Mientras corre, explica que el agente abre la actividad en el navegador integrado y lee el título, el curso y el cierre. Con esos datos prepara un lote y lo pasa por entrada estándar al comando `aula:import` dentro de Docker. |
| **1:30–2:30** | Vuelve a mirar la pestaña que dejaste abierta, sin recargarla. Señala la actividad en **Próximas**, su curso y su fecha de cierre. Si la terminal queda a la vista, muestra `updatedTasks: 1` como recibo del guardado. |
| **2:30–2:45** | «El panel ya muestra una tarea que estaba en Aula Virtual. Ahora veremos cómo esa lectura pasa por el código y cómo la vista se entera del cambio». Pasa al segundo expositor. |

## Prompt para pegar en este chat

```text
Haz la demo en vivo de captura asistida. Mantén abierto http://localhost:3000/ desde antes de importar. Usa tu navegador integrado con mi sesión de Aula Virtual y lee solo esta actividad: [URL_DE_LA_ACTIVIDAD]. Verifica la cuenta activa y extrae de la página el identificador, título, curso, enlace, fecha de cierre y destino.

Importa esa única tarea con docker compose exec -T app npm run --silent aula:import, usando el JSON por entrada estándar según docs/demo-captura-asistida.md. Después verifica en la misma pestaña del panel que aparezca en Próximas sin recargarla manualmente. Dime qué tarea apareció y cuál es su plazo. Si la sesión requiere iniciar sesión, avísame antes de importar.
```
