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

## Publicar cambios

Backend (`apps-script/Codigo.js`):

```bash
cd apps-script
clasp push
clasp deploy -i <DEPLOYMENT_ID> -d "descripción del cambio"
```

El `-i <DEPLOYMENT_ID>` actualiza la implementación existente y **mantiene la URL**.
Sin ese flag se crea una URL nueva y hay que tocar `index.html`.

Frontend (`index.html`):

```bash
git add -A && git commit -m "..." && git push
```

GitHub Pages se actualiza solo en ~1 minuto.

## Notas de Odoo

- Versión: Odoo 19 (SaaS). Los nombres de campo cambian entre versiones.
- `account.payment` **no** tiene campo `ref` en v19.
- URL de facturas de proveedor: `/odoo/vendor-bills/{id}` (sin `/accounting/`).
- La meta se calcula como cantidad de aportantes × Bs. 3.200 (`APORTE_POR_PERSONA` en `index.html`).
