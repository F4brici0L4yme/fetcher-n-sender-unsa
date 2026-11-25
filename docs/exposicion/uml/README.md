# Diagramas UML para la exposición

| Diagrama | Qué mostrar | Archivos |
|---|---|---|
| **Puertos y adaptadores** | El CLI y el panel entran por los casos de uso. Los adaptadores de salida implementan interfaces del núcleo. El enlace visual del worker con Aula Virtual sigue pendiente. | [PNG](01-puertos-y-adaptadores.png) · [PlantUML](01-puertos-y-adaptadores.puml) |
| **MVC** | El controlador consulta el modelo y Handlebars renderiza la bandeja que devuelve el servidor. | [PNG](02-modelo-vista-controlador.png) · [PlantUML](02-modelo-vista-controlador.puml) |
| **Repository** | El caso de uso depende de `AssignmentImportRepository`. PostgreSQL implementa el guardado y la consulta de revisión. | [PNG](03-repository.png) · [PlantUML](03-repository.puml) |
| **Observer** | La confirmación de la transacción produce una notificación. La pestaña recibe un evento SSE y solicita el HTML actualizado. | [PNG](04-observer.png) · [PlantUML](04-observer.puml) |

Para la exposición de cinco minutos, usa el diagrama de puertos y adaptadores como mapa y abre Observer al explicar por qué aparece la tarea sin recarga manual. Los otros dos diagramas acompañan los fragmentos de controladores y repositorios.

Para regenerar las imágenes desde la raíz del repositorio:

```bash
plantuml --check-before-run -tpng docs/exposicion/uml/*.puml
```
