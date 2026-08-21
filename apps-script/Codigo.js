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

// ============================================================
//  AUTENTICACIÓN — usuario y contraseña
// ============================================================
//  Los usuarios viven en una Google Sheet propia (se crea sola
//  la primera vez). Las contraseñas NO se guardan: se guarda un
//  hash con salt por usuario y un pepper del script.
//
//  Alta de usuarios: correr crearUsuariosDesdeOdoo() desde el
//  editor. Toma a los aportantes de Odoo —clientes, nunca
//  proveedores— y devuelve la lista de credenciales para
//  repartir. Cada uno cambia su contraseña al primer ingreso.
// ============================================================

const SESION_DIAS      = 30;     // duración de la sesión
const MAX_INTENTOS     = 8;      // intentos fallidos por usuario cada 15 min
const ITERACIONES_HASH = 1000;   // estiramiento del hash
const LARGO_MINIMO     = 8;      // largo mínimo de contraseña
const HOJA_USUARIOS    = "Usuarios";
const COLUMNAS = ["usuario","nombre","hash","salt","activo","debe_cambiar","creado","ultimo_acceso"];

// ------------------------------------------------------------
//  Secreto de firma y pepper (se genera solo la primera vez)
// ------------------------------------------------------------
//  OJO: si se borra AUTH_SECRET dejan de valer TODAS las
//  contraseñas y hay que restablecerlas una por una.
// ------------------------------------------------------------
function secreto() {
  const p = PropertiesService.getScriptProperties();
  let s = p.getProperty("AUTH_SECRET");
  if (!s) {
    s = Utilities.getUuid() + Utilities.getUuid();
    p.setProperty("AUTH_SECRET", s);
  }
  return s;
}

function hmac(texto) {
  return Utilities.base64EncodeWebSafe(
    Utilities.computeHmacSha256Signature(String(texto), secreto())
  );
}

// Comparación que no corta al primer byte distinto
function comparaSegura(a, b) {
  a = String(a); b = String(b);
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

// ------------------------------------------------------------
//  Hash de contraseña: salt por usuario + pepper del script,
//  repetido ITERACIONES_HASH veces para encarecer la fuerza bruta
// ------------------------------------------------------------
function hashContrasena(contrasena, salt) {
  let acc = String(salt) + ":" + String(contrasena);
  for (let i = 0; i < ITERACIONES_HASH; i++) acc = hmac(acc);
  return acc;
}

function validarContrasena(valor) {
  const c = String(valor || "");
  if (c.length < LARGO_MINIMO) {
    throw new Error("La contraseña tiene que tener al menos " + LARGO_MINIMO + " caracteres.");
  }
  return c;
}

function contrasenaAlAzar() {
  const abc = "abcdefghjkmnpqrstuvwxyz23456789";  // sin l/i/o/0/1 para que no se confundan
  const hex = Utilities.getUuid().replace(/-/g, "");
  let s = "";
  for (let i = 0; i < 10; i++) s += abc[parseInt(hex.substr(i * 2, 2), 16) % abc.length];
  return s;
}

// ------------------------------------------------------------
//  Límite de intentos (ventana deslizante en CacheService)
// ------------------------------------------------------------
function limitar(clave, max, segundos, mensaje) {
  const cache = CacheService.getScriptCache();
  const n = parseInt(cache.get("lim:" + clave) || "0", 10) + 1;
  cache.put("lim:" + clave, String(n), segundos);
  if (n > max) throw new Error(mensaje);
}

function limpiarLimite(clave) {
  CacheService.getScriptCache().remove("lim:" + clave);
}

// ------------------------------------------------------------
//  Planilla de usuarios
// ------------------------------------------------------------
function libro() {
  const p = PropertiesService.getScriptProperties();
  const id = p.getProperty("HOJA_ID");
  if (id) {
    try { return SpreadsheetApp.openById(id); }
    catch (e) { /* la borraron o no hay acceso: creamos una nueva */ }
  }
  const ss = SpreadsheetApp.create("Usuarios · Dashboard Maristas 2027");
  p.setProperty("HOJA_ID", ss.getId());
  return ss;
}

let _hoja = null;

function hojaUsuarios() {
  if (_hoja) return _hoja;
  const ss = libro();
  let h = ss.getSheetByName(HOJA_USUARIOS);
  if (!h) {
    h = ss.insertSheet(HOJA_USUARIOS);
    h.appendRow(COLUMNAS);
    h.setFrozenRows(1);
    h.getRange(1, 1, 1, COLUMNAS.length).setFontWeight("bold");
  }
  _hoja = h;
  return h;
}

function leerUsuarios() {
  const filas = hojaUsuarios().getDataRange().getValues();
  if (filas.length < 2) return [];
  const cab = filas[0].map(c => String(c).trim().toLowerCase());
  return filas.slice(1)
    .map((fila, i) => {
      const o = { _fila: i + 2 };
      cab.forEach((c, j) => { o[c] = fila[j]; });
      return o;
    })
    .filter(u => String(u.usuario || "").trim() !== "");
}

function normalizarUsuario(valor) {
  return String(valor || "").trim().toLowerCase();
}

function buscarUsuario(usuario) {
  const clave = normalizarUsuario(usuario);
  if (!clave) return null;
  const encontrados = leerUsuarios().filter(u => normalizarUsuario(u.usuario) === clave);
  return encontrados.length ? encontrados[0] : null;
}

function esSi(valor) {
  const v = String(valor).trim().toUpperCase();
  return v === "SI" || v === "SÍ" || v === "TRUE" || v === "VERDADERO";
}

function guardarContrasena(fila, contrasena, debeCambiar) {
  const salt = Utilities.getUuid();
  const h = hojaUsuarios();
  h.getRange(fila, COLUMNAS.indexOf("hash") + 1).setValue(hashContrasena(contrasena, salt));
  h.getRange(fila, COLUMNAS.indexOf("salt") + 1).setValue(salt);
  h.getRange(fila, COLUMNAS.indexOf("debe_cambiar") + 1).setValue(debeCambiar ? "SI" : "NO");
}

// ------------------------------------------------------------
//  Ingreso
// ------------------------------------------------------------
function iniciarSesion(usuarioCrudo, contrasena) {
  const usuario = normalizarUsuario(usuarioCrudo);
  if (!usuario) throw new Error("Escribí tu usuario.");

  limitar("login:" + usuario, MAX_INTENTOS, 900,
    "Demasiados intentos fallidos. Esperá 15 minutos y volvé a probar.");

  const u = buscarUsuario(usuario);

  // Se calcula el hash aunque el usuario no exista, para que un
  // usuario inexistente no se delate por responder más rápido.
  const hashRecibido = hashContrasena(contrasena, u ? u.salt : "sin-usuario");
  const coincide = !!u && comparaSegura(hashRecibido, String(u.hash));

  if (!coincide) throw new Error("Usuario o contraseña incorrectos.");
  if (!esSi(u.activo)) throw new Error("Tu usuario está desactivado. Escribile a la comisión.");

  limpiarLimite("login:" + usuario);
  hojaUsuarios()
    .getRange(u._fila, COLUMNAS.indexOf("ultimo_acceso") + 1)
    .setValue(new Date());

  const debeCambiar = esSi(u.debe_cambiar);
  return {
    ok: true,
    token: emitirToken(usuario, debeCambiar),
    nombre: String(u.nombre || u.usuario),
    debe_cambiar: debeCambiar
  };
}

// ------------------------------------------------------------
//  Cambio de contraseña (el propio usuario)
// ------------------------------------------------------------
function cambiarContrasena(token, actual, nueva) {
  const s = sesion(token);
  const u = buscarUsuario(s.u);
  if (!u) throw new Error("SESION_INVALIDA");

  if (!comparaSegura(hashContrasena(actual, u.salt), String(u.hash))) {
    throw new Error("La contraseña actual no coincide.");
  }
  validarContrasena(nueva);
  if (String(nueva) === String(actual)) {
    throw new Error("La contraseña nueva tiene que ser distinta de la actual.");
  }

  guardarContrasena(u._fila, nueva, false);
  return { ok: true, token: emitirToken(s.u, false), nombre: String(u.nombre || u.usuario) };
}

// ------------------------------------------------------------
//  Token de sesión: payload.firma  (HMAC-SHA256)
//  c=1 marca que todavía debe cambiar la contraseña inicial
// ------------------------------------------------------------
function emitirToken(usuario, debeCambiar) {
  const payload = Utilities.base64EncodeWebSafe(JSON.stringify({
    u: usuario,
    c: debeCambiar ? 1 : 0,
    exp: Date.now() + SESION_DIAS * 24 * 60 * 60 * 1000
  }));
  return payload + "." + hmac(payload);
}

function sesion(token) {
  const partes = String(token || "").split(".");
  if (partes.length !== 2) throw new Error("SESION_INVALIDA");
  if (!comparaSegura(hmac(partes[0]), partes[1])) throw new Error("SESION_INVALIDA");

  const payload = JSON.parse(
    Utilities.newBlob(Utilities.base64DecodeWebSafe(partes[0])).getDataAsString()
  );
  if (!payload.exp || Date.now() > payload.exp) throw new Error("SESION_EXPIRADA");
  return payload;
}

// ============================================================
//  ADMINISTRACIÓN — correr a mano desde el editor
// ============================================================

// Aportantes de Odoo: clientes con factura publicada.
// Los proveedores viven en in_invoice y nunca entran acá.
function aportantes() {
  const uid = autenticar();
  const facturas = buscar(uid, "account.move",
    [["move_type","=","out_invoice"], ["state","=","posted"]],
    ["partner_id"], 500, "id desc"
  );
  const vistos = {};
  facturas.forEach(f => {
    if (Array.isArray(f.partner_id)) vistos[f.partner_id[0]] = f.partner_id[1];
  });
  return Object.keys(vistos).map(id => ({ id: Number(id), nombre: String(vistos[id]) }));
}

function usuarioDesdeNombre(nombre, tomados) {
  let base = String(nombre).toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")   // saca tildes y diéresis
    .replace(/[^a-z0-9\s]/g, " ")
    .trim().split(/\s+/).slice(0, 2).join(".");
  if (!base) base = "usuario";
  let u = base, n = 2;
  while (tomados.indexOf(u) !== -1) u = base + (n++);
  tomados.push(u);
  return u;
}

// Crea un usuario suelto. Si no se pasa contraseña, genera una.
function crearUsuario(usuario, nombre, contrasena) {
  const clave = normalizarUsuario(usuario);
  if (!clave) throw new Error("Falta el usuario.");
  if (buscarUsuario(clave)) throw new Error("Ya existe el usuario " + clave);

  const generada = !contrasena;
  const pass = contrasena ? validarContrasena(contrasena) : contrasenaAlAzar();

  const h = hojaUsuarios();
  h.appendRow([clave, nombre || clave, "", "", "SI", generada ? "SI" : "NO", new Date(), ""]);
  guardarContrasena(h.getLastRow(), pass, generada);

  Logger.log("Usuario: " + clave + "   Contraseña: " + pass);
  return { usuario: clave, contrasena: pass };
}

// Da de alta a todos los aportantes de Odoo que falten y
// devuelve las credenciales para repartir.
function crearUsuariosDesdeOdoo() {
  const existentes = leerUsuarios();
  const tomados    = existentes.map(u => normalizarUsuario(u.usuario));
  // Se saltea por NOMBRE, no por usuario generado: si no, al correrlo
  // dos veces le crearía "ana.perez2" a la misma Ana Pérez.
  const yaTienen = existentes.map(u => String(u.nombre || "").trim().toLowerCase());
  const nuevos = [];
  const h = hojaUsuarios();

  aportantes().forEach(p => {
    const clave = p.nombre.trim().toLowerCase();
    if (yaTienen.indexOf(clave) !== -1) return;

    const usuario = usuarioDesdeNombre(p.nombre, tomados);
    const pass    = contrasenaAlAzar();
    h.appendRow([usuario, p.nombre, "", "", "SI", "SI", new Date(), ""]);
    guardarContrasena(h.getLastRow(), pass, true);
    yaTienen.push(clave);
    nuevos.push({ nombre: p.nombre, usuario: usuario, contrasena: pass });
  });

  Logger.log(nuevos.length + " usuario(s) nuevo(s):\n" +
    nuevos.map(n => n.nombre + "  →  " + n.usuario + " / " + n.contrasena).join("\n"));
  return nuevos;
}

// Le da una contraseña nueva a alguien que la perdió.
function restablecerContrasena(usuario) {
  const u = buscarUsuario(usuario);
  if (!u) throw new Error("No existe el usuario " + usuario);
  const pass = contrasenaAlAzar();
  guardarContrasena(u._fila, pass, true);
  Logger.log("Usuario: " + normalizarUsuario(u.usuario) + "   Contraseña nueva: " + pass);
  return { usuario: normalizarUsuario(u.usuario), contrasena: pass };
}

function desactivarUsuario(usuario) {
  const u = buscarUsuario(usuario);
  if (!u) throw new Error("No existe el usuario " + usuario);
  hojaUsuarios().getRange(u._fila, COLUMNAS.indexOf("activo") + 1).setValue("NO");
  Logger.log("Desactivado: " + normalizarUsuario(u.usuario));
}

function activarUsuario(usuario) {
  const u = buscarUsuario(usuario);
  if (!u) throw new Error("No existe el usuario " + usuario);
  hojaUsuarios().getRange(u._fila, COLUMNAS.indexOf("activo") + 1).setValue("SI");
  Logger.log("Activado: " + normalizarUsuario(u.usuario));
}

// Lista sin mostrar hashes ni salts.
function listarUsuarios() {
  const filas = leerUsuarios().map(u =>
    normalizarUsuario(u.usuario) +
    "  |  " + String(u.nombre || "") +
    "  |  activo: " + (esSi(u.activo) ? "sí" : "no") +
    "  |  debe cambiar: " + (esSi(u.debe_cambiar) ? "sí" : "no") +
    "  |  último acceso: " + (u.ultimo_acceso || "nunca")
  );
  Logger.log(filas.length ? filas.join("\n") : "No hay usuarios cargados todavía.");
  return filas;
}

// Corré esto UNA VEZ desde el editor para autorizar los permisos
// y para saber dónde quedó la planilla de usuarios.
function autorizar() {
  const ss = libro();
  hojaUsuarios();
  Logger.log("Planilla de usuarios: " + ss.getUrl());
  return ss.getUrl();
}

// ============================================================
//  Puntos de entrada HTTP
// ============================================================
function respuestaJson(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// GET ya no entrega datos: todo pasa por POST con token.
function doGet() {
  return respuestaJson({
    ok: false,
    error: "Esta API requiere POST con un token de sesión."
  });
}

function doPost(e) {
  try {
    const req = JSON.parse((e && e.postData && e.postData.contents) || "{}");
    switch (req.accion) {
      case "login":
        return respuestaJson(iniciarSesion(req.usuario, req.contrasena));

      case "cambiar":
        return respuestaJson(cambiarContrasena(req.token, req.actual, req.nueva));

      case "datos": {
        const s = sesion(req.token);
        if (s.c) throw new Error("DEBE_CAMBIAR");
        return respuestaJson({ ok: true, usuario: s.u, data: obtenerDatos() });
      }

      default:
        throw new Error("Acción no reconocida.");
    }
  } catch (err) {
    return respuestaJson({ ok: false, error: err.message });
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
