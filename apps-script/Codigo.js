// ============================================================
//  Dashboard Maristas 2027 — Google Apps Script (proxy Odoo)
//  Credenciales en Propiedades del script (NO en este archivo)
// ============================================================
//  Configurar en: Apps Script → Configuración del proyecto →
//  Propiedades del script → agregar ODOO_URL, ODOO_DB,
//  ODOO_USER y ODOO_KEY.
// ============================================================

let _CFG = null;

function CFG() {
  if (_CFG) return _CFG;
  const p = PropertiesService.getScriptProperties();
  const cfg = {
    url:  p.getProperty("ODOO_URL"),
    db:   p.getProperty("ODOO_DB"),
    user: p.getProperty("ODOO_USER"),
    key:  p.getProperty("ODOO_KEY")
  };
  const faltan = Object.keys(cfg).filter(k => !cfg[k]);
  if (faltan.length) {
    throw new Error(
      "Faltan propiedades del script: " + faltan.join(", ").toUpperCase() +
      ". Configuralas en Configuración del proyecto → Propiedades del script."
    );
  }
  _CFG = cfg;
  return cfg;
}

// ------------------------------------------------------------
//  Punto de entrada HTTP GET
// ------------------------------------------------------------
function doGet(e) {
  try {
    const data = obtenerDatos();
    const output = ContentService.createTextOutput(JSON.stringify({ ok: true, data }));
    output.setMimeType(ContentService.MimeType.JSON);
    return output;
  } catch (err) {
    const output = ContentService.createTextOutput(JSON.stringify({ ok: false, error: err.message }));
    output.setMimeType(ContentService.MimeType.JSON);
    return output;
  }
}

// ------------------------------------------------------------
//  XML-RPC helper
// ------------------------------------------------------------
function xmlrpcCall(endpoint, methodName, params) {
  const paramsXml = params.map(valueToXml).join("\n");
  const body = `<?xml version="1.0"?>
<methodCall>
  <methodName>${methodName}</methodName>
  <params>${paramsXml}</params>
</methodCall>`;

  const resp = UrlFetchApp.fetch(CFG().url + endpoint, {
    method:      "post",
    contentType: "text/xml",
    payload:     body,
    muteHttpExceptions: true
  });

  return parseXmlrpcResponse(resp.getContentText());
}

function valueToXml(val) {
  if (typeof val === "string")  return `<param><value><string>${escXml(val)}</string></value></param>`;
  if (typeof val === "number")  return `<param><value><int>${val}</int></value></param>`;
  if (typeof val === "boolean") return `<param><value><boolean>${val ? 1 : 0}</boolean></value></param>`;
  if (Array.isArray(val)) {
    const items = val.map(v => `<value>${innerValueToXml(v)}</value>`).join("");
    return `<param><value><array><data>${items}</data></array></value></param>`;
  }
  if (typeof val === "object" && val !== null) {
    const members = Object.entries(val).map(([k, v]) =>
      `<member><name>${escXml(k)}</name><value>${innerValueToXml(v)}</value></member>`
    ).join("");
    return `<param><value><struct>${members}</struct></value></param>`;
  }
  return `<param><value><string></string></value></param>`;
}

function innerValueToXml(val) {
  if (typeof val === "string")  return `<string>${escXml(val)}</string>`;
  if (typeof val === "number")  return `<int>${val}</int>`;
  if (typeof val === "boolean") return `<boolean>${val ? 1 : 0}</boolean>`;
  if (Array.isArray(val)) {
    const items = val.map(v => `<value>${innerValueToXml(v)}</value>`).join("");
    return `<array><data>${items}</data></array>`;
  }
  if (typeof val === "object" && val !== null) {
    const members = Object.entries(val).map(([k, v]) =>
      `<member><name>${escXml(k)}</name><value>${innerValueToXml(v)}</value></member>`
    ).join("");
    return `<struct>${members}</struct>`;
  }
  return `<string></string>`;
}

function escXml(s) {
  return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}

function parseXmlrpcResponse(text) {
  const doc   = XmlService.parse(text);
  const root  = doc.getRootElement();
  const fault = root.getChild("fault");
  if (fault) throw new Error("XML-RPC fault: " + JSON.stringify(xmlNodeToJs(fault.getChild("value"))));
  const params = root.getChild("params");
  if (!params) throw new Error("Respuesta inesperada: " + text.substring(0, 200));
  return xmlNodeToJs(params.getChild("param").getChild("value"));
}

function xmlNodeToJs(valueNode) {
  if (!valueNode) return null;
  const children = valueNode.getChildren();
  if (children.length === 0) return valueNode.getText();
  const typeNode = children[0];
  const tag      = typeNode.getName();
  if (tag === "string")  return typeNode.getText();
  if (tag === "int" || tag === "i4" || tag === "i8") return parseInt(typeNode.getText(), 10);
  if (tag === "double")  return parseFloat(typeNode.getText());
  if (tag === "boolean") return typeNode.getText().trim() === "1";
  if (tag === "nil")     return null;
  if (tag === "array") {
    const data = typeNode.getChild("data");
    return data ? data.getChildren("value").map(xmlNodeToJs) : [];
  }
  if (tag === "struct") {
    const obj = {};
    typeNode.getChildren("member").forEach(m => {
      obj[m.getChild("name").getText()] = xmlNodeToJs(m.getChild("value"));
    });
    return obj;
  }
  return typeNode.getText();
}

// ------------------------------------------------------------
//  Autenticación
// ------------------------------------------------------------
function autenticar() {
  const c = CFG();
  const uid = xmlrpcCall("/xmlrpc/2/common", "authenticate", [c.db, c.user, c.key, {}]);
  if (!uid || uid === false || uid === 0) throw new Error("Autenticación fallida. uid=" + uid);
  return uid;
}

// ------------------------------------------------------------
//  Buscar registros genérico
// ------------------------------------------------------------
function buscar(uid, model, domain, fields, limit, order) {
  const c = CFG();
  const result = xmlrpcCall("/xmlrpc/2/object", "execute_kw", [
    c.db, uid, c.key,
    model, "search_read",
    [domain],
    { fields: fields, limit: limit || 500, order: order || "id desc" }
  ]);
  return Array.isArray(result) ? result : [];
}

// ------------------------------------------------------------
//  Obtiene todos los datos
// ------------------------------------------------------------
function obtenerDatos() {
  const c   = CFG();
  const uid = autenticar();

  // --- INGRESOS ---
  const rawIngresos = buscar(uid, "account.move",
    [["move_type","=","out_invoice"], ["state","=","posted"]],
    ["id","name","invoice_date","amount_total","partner_id","payment_state"],
    500, "invoice_date desc"
  );

  const mapaPartners = {};
  rawIngresos.forEach(f => {
    const partnerId  = Array.isArray(f.partner_id) ? f.partner_id[0] : 0;
    const partnerNom = Array.isArray(f.partner_id) ? f.partner_id[1] : "Sin nombre";
    if (!mapaPartners[partnerId]) {
      mapaPartners[partnerId] = { nombre: partnerNom, total: 0 };
    }
    mapaPartners[partnerId].total += f.amount_total || 0;
  });

  const aportes = Object.values(mapaPartners).sort((a, b) => b.total - a.total);
  const totalIngresos = aportes.reduce((s, p) => s + p.total, 0);

  // --- GASTOS ---
  const rawGastos = buscar(uid, "account.move",
    [["move_type","in",["in_invoice","in_receipt"]], ["state","=","posted"]],
    ["id","name","invoice_date","amount_total","amount_residual",
     "partner_id","payment_state","move_type","invoice_line_ids","payment_reference"],
    500, "invoice_date desc"
  );

  // Cuenta contable: primera línea de producto de cada factura
  const todosLineIds = [];
  rawGastos.forEach(f => {
    if (Array.isArray(f.invoice_line_ids)) {
      f.invoice_line_ids.forEach(id => todosLineIds.push(id));
    }
  });

  const mapaLineas = {};
  if (todosLineIds.length > 0) {
    const lineas = buscar(uid, "account.move.line",
      [["id","in",todosLineIds], ["display_type","=","product"]],
      ["id","account_id","name","move_id"],
      500, "id asc"
    );
    lineas.forEach(l => {
      const moveId = Array.isArray(l.move_id) ? l.move_id[0] : l.move_id;
      if (!mapaLineas[moveId]) {
        mapaLineas[moveId] = Array.isArray(l.account_id) ? l.account_id[1] : "";
      }
    });
  }

  const gastos = rawGastos.map(f => {
    const totalDoc  = f.amount_total    || 0;
    const saldoDoc  = f.amount_residual || 0;
    const pagadoDoc = Math.round((totalDoc - saldoDoc) * 100) / 100;
    const partner   = Array.isArray(f.partner_id) ? f.partner_id[1] : "Sin nombre";
    return {
      id:          f.id,
      nombre:      partner,
      comprobante: f.name,
      referencia:  f.payment_reference || "",
      cuenta:      mapaLineas[f.id] || "",
      fecha:       f.invoice_date || "",
      monto_total: totalDoc,
      pagado_acum: pagadoDoc,
      saldo:       saldoDoc,
      pagado_bool: f.payment_state === "paid" || f.payment_state === "in_payment",
      url:         c.url + "/odoo/vendor-bills/" + f.id
    };
  });

  // --- PAGOS DE PROVEEDOR ---
  const pagosProveedor = buscar(uid, "account.payment",
    [["payment_type","=","outbound"], ["state","=","posted"]],
    ["id","name","date","amount","partner_id"],
    500, "date desc"
  );

  const pagos = pagosProveedor.map(p => ({
    id:         p.id,
    nombre:     Array.isArray(p.partner_id) ? p.partner_id[1] : "Sin nombre",
    referencia: p.name || "",
    fecha:      p.date || "",
    monto:      p.amount || 0,
    url:        c.url + "/odoo/accounting/payments/" + p.id
  }));

  const totalGastos = gastos.reduce((s, g) => s + g.monto_total, 0);
  const totalPagado = gastos.reduce((s, g) => s + g.pagado_acum, 0);

  return {
    resumen: {
      total_ingresos:  totalIngresos,
      total_gastos:    totalGastos,
      total_pagado_gs: totalPagado,
      saldo_caja:      totalIngresos - totalPagado,
      cant_ingresos:   rawIngresos.length,
      cant_gastos:     gastos.length
    },
    grupos_ingresos: [
      { nombre: "Aportes de miembros", items: aportes }
    ],
    gastos,
    pagos,
    actualizado: new Date().toISOString()
  };
}
