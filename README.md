# Dashboard Fiesta Maristas 2027

Estado financiero de la fiesta de 25 años (Promoción 2002), alimentado en vivo desde Odoo.

- **Público:** https://matiashm85.github.io/marista2027/
- **Frontend:** `index.html` (GitHub Pages, raíz del repo)
- **Backend:** `apps-script/Codigo.js` (Google Apps Script, proxy XML-RPC a Odoo)

## Credenciales

**Nunca** van en el código. Se configuran una sola vez en
Apps Script → Configuración del proyecto → Propiedades del script:

| Propiedad    | Valor                          |
|--------------|--------------------------------|
| `ODOO_URL`   | `https://marista2002.odoo.com` |
| `ODOO_DB`    | `marista2002`                  |
| `ODOO_USER`  | tu email de Odoo               |
| `ODOO_KEY`   | API key de Odoo                |

Estas dos se generan solas, no hay que crearlas a mano:

| Propiedad     | Para qué sirve                                                      |
|---------------|---------------------------------------------------------------------|
| `AUTH_SECRET` | Firma de sesiones y pepper de las contraseñas                        |
| `HOJA_ID`     | ID de la planilla de usuarios                                        |

> ⚠️ Si se borra `AUTH_SECRET` dejan de valer **todas las contraseñas** y hay
> que restablecerlas una por una. No la toques.

## Acceso

Usuario y contraseña. Los usuarios viven en una Google Sheet aparte
(«Usuarios · Dashboard Maristas 2027»), que se crea sola la primera vez.

Las contraseñas no se guardan: se guarda un hash SHA-256 con un salt distinto
por usuario más el pepper del script, repetido 20.000 veces para encarecer la
fuerza bruta. Ni la planilla ni los logs ven la contraseña.

El SHA-256 está implementado a mano en `Codigo.js` en vez de usar
`Utilities.computeHmacSha256Signature`. No es capricho: cada llamada a
`Utilities` cruza a Java y, estirando el hash miles de veces, una sola
contraseña tardaba **un minuto**. En JavaScript puro son milisegundos.
Si tocás `sha256Hex`, verificá contra una implementación de referencia:
un bit de diferencia deja afuera a todos los usuarios.

Al entrar, el usuario recibe un token firmado que dura 30 días en
`localStorage`. Máximo 8 intentos fallidos por usuario cada 15 minutos.

`doGet` ya no devuelve datos — todo pasa por `POST` con token.

### Dar de alta a la promoción

Desde el editor de Apps Script, elegir la función y darle a ejecutar:

| Función                        | Qué hace                                                        |
|--------------------------------|------------------------------------------------------------------|
| `autorizar()`                  | Concede permisos y dice dónde quedó la planilla. **Correr primero** |
| `crearUsuariosDesdeOdoo()`     | Crea un usuario por aportante y muestra las credenciales           |
| `crearUsuario(u, nombre, pass)`| Alta suelta. Sin `pass`, genera una al azar                        |
| `restablecerContrasena(u)`     | Para el que se la olvidó                                           |
| `regenerarTodasLasClaves()`    | Nuevas contraseñas para **todos**. Sólo si cambió el hash          |
| `desactivarUsuario(u)`         | Le corta el acceso sin borrarlo                                    |
| `activarUsuario(u)`            | Lo vuelve a habilitar                                              |
| `listarUsuarios()`             | Quién hay, quién entró y cuándo                                    |
| `diagnostico()`                | Mide cuánto tarda un hash en este entorno                          |
| `diagnosticoAdjuntos()`        | Lista qué comprobante tiene cargado cada gasto                     |

`crearUsuariosDesdeOdoo()` también repara filas a medio escribir: si una
corrida se cortó por tiempo y dejó a alguien sin `hash` ni `salt`, le genera
la contraseña que le faltaba en vez de saltearlo.

Las credenciales salen en el registro de ejecución (Ver → Registros).
Se reparten por WhatsApp; **el sistema no manda mails**.

`crearUsuariosDesdeOdoo()` toma a los aportantes de las facturas de cliente,
así que los proveedores nunca entran. Los usuarios salen del nombre
(«Ana Pérez» → `ana.perez`) y se pueden editar en la planilla. Correrlo de
nuevo sólo da de alta a los que falten, no duplica a nadie.

Todos entran con una contraseña generada y el sistema **les exige cambiarla**
en el primer ingreso antes de mostrarles nada.

### Administrar a mano

La planilla se puede editar directo. La columna `activo` en `NO` bloquea a
alguien; `debe_cambiar` en `SI` lo obliga a elegir contraseña nueva.
No toques `hash` ni `salt`: si querés cambiarle la contraseña a alguien,
usá `restablecerContrasena()`.

## Publicar cambios

**Orden:** primero el backend, después el frontend. En el medio hay ~1 minuto
en que el sitio queda caído, porque el HTML viejo llama por `GET` y el backend
nuevo ya sólo responde `POST`.

Backend (`apps-script/Codigo.js`):

```bash
cd apps-script
clasp push
clasp deploy -i <DEPLOYMENT_ID> -d "descripción del cambio"
```

La primera vez que se publica el login hay que **autorizar los permisos nuevos**:
abrir el editor de Apps Script, elegir la función `autorizar` y ejecutarla una vez.
Sin eso el script no puede tocar la planilla de usuarios y todo login falla.

El `-i <DEPLOYMENT_ID>` actualiza la implementación existente y **mantiene la URL**.
Sin ese flag se crea una URL nueva y hay que tocar `index.html`.

Frontend (`index.html`):

```bash
git add -A && git commit -m "..." && git push
```

GitHub Pages se actualiza solo en ~1 minuto.

## Comprobantes de gastos

Cada gasto muestra sus adjuntos de Odoo (`ir.attachment` con
`res_model = account.move`), no un enlace al registro: los compañeros no
tienen cuenta en Odoo, así que ese enlace no les servía de nada.

El archivo **no** se sirve desde Odoo. Va por la acción `adjunto` del backend,
que lo trae por XML-RPC y lo devuelve en base64; el navegador arma un `Blob` y
lo abre. Así el comprobante queda detrás del mismo login que el resto, sin
tener que exponer URLs públicas de Odoo.

Antes de leer el contenido se verifica que el adjunto cuelgue de una factura
de proveedor publicada. Sin esa comprobación, cualquiera con sesión podría
pedir por id cualquier archivo de la base (contratos, adjuntos de RRHH, lo que
haya). Los archivos de más de 8 MB se rechazan.

Si un gasto dice «sin comprobante», es que en Odoo no tiene nada adjunto.
`diagnosticoAdjuntos()` lista qué ve el script para cada factura.

## Notas de Odoo

- Versión: Odoo 19 (SaaS). Los nombres de campo cambian entre versiones.
- `account.payment` **no** tiene campo `ref` en v19.
- URL de facturas de proveedor: `/odoo/vendor-bills/{id}` (sin `/accounting/`).
- La meta se calcula como cantidad de aportantes × Bs. 3.200 (`APORTE_POR_PERSONA` en `index.html`).
