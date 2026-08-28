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
const ITERACIONES_HASH = 20000;  // estiramiento del hash (SHA-256 puro, barato)
const LARGO_MINIMO     = 8;      // largo mínimo de contraseña
const HOJA_USUARIOS    = "Usuarios";
const COLUMNAS = ["usuario","nombre","hash","salt","activo","debe_cambiar","creado","ultimo_acceso"];

// ------------------------------------------------------------
//  Secreto de firma y pepper (se genera solo la primera vez)
// ------------------------------------------------------------
//  OJO: si se borra AUTH_SECRET dejan de valer TODAS las
//  contraseñas y hay que restablecerlas una por una.
// ------------------------------------------------------------
let _secreto = null;

function secreto() {
  if (_secreto) return _secreto;          // sin esto se lee la propiedad
  const p = PropertiesService.getScriptProperties();   // en cada vuelta del bucle
  let s = p.getProperty("AUTH_SECRET");
  if (!s) {
    s = Utilities.getUuid() + Utilities.getUuid();
    p.setProperty("AUTH_SECRET", s);
  }
  _secreto = s;
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
//  SHA-256 en JavaScript puro
// ------------------------------------------------------------
//  Apps Script tiene Utilities.computeHmacSha256Signature, pero
//  cada llamada cruza a Java y cuesta milisegundos. Para estirar
//  el hash miles de veces hay que quedarse dentro de V8.
// ------------------------------------------------------------
const _K256 = [
  0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
  0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
  0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
  0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
  0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
  0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
  0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
  0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2
];

function _utf8Bytes(s) {
  const out = [];
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) {
      out.push(c);
    } else if (c < 0x800) {
      out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    } else if (c >= 0xd800 && c < 0xdc00) {          // par suplente
      const cp = 0x10000 + ((c - 0xd800) << 10) + (s.charCodeAt(++i) - 0xdc00);
      out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63),
               0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
    } else {
      out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
  }
  return out;
}

function sha256Hex(texto) {
  const msg = _utf8Bytes(String(texto));
  const bits = msg.length * 8;

  msg.push(0x80);
  while (msg.length % 64 !== 56) msg.push(0);
  // Largo en 64 bits big-endian. Los 32 altos van en 0: nunca
  // vamos a hashear medio exabyte.
  msg.push(0, 0, 0, 0,
           (bits >>> 24) & 255, (bits >>> 16) & 255, (bits >>> 8) & 255, bits & 255);

  let h0=0x6a09e667, h1=0xbb67ae85, h2=0x3c6ef372, h3=0xa54ff53a,
      h4=0x510e527f, h5=0x9b05688c, h6=0x1f83d9ab, h7=0x5be0cd19;
  const w = new Array(64);

  for (let i = 0; i < msg.length; i += 64) {
    for (let t = 0; t < 16; t++) {
      const j = i + t * 4;
      w[t] = (msg[j] << 24) | (msg[j+1] << 16) | (msg[j+2] << 8) | msg[j+3];
    }
    for (let t = 16; t < 64; t++) {
      const x = w[t-15], y = w[t-2];
      const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
      const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
      w[t] = (w[t-16] + s0 + w[t-7] + s1) | 0;
    }

    let a=h0, b=h1, c=h2, d=h3, e=h4, f=h5, g=h6, h=h7;
    for (let t = 0; t < 64; t++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + _K256[t] + w[t]) | 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0;
      d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    h0=(h0+a)|0; h1=(h1+b)|0; h2=(h2+c)|0; h3=(h3+d)|0;
    h4=(h4+e)|0; h5=(h5+f)|0; h6=(h6+g)|0; h7=(h7+h)|0;
  }

  let hex = "";
  [h0,h1,h2,h3,h4,h5,h6,h7].forEach(x => {
    let s = (x >>> 0).toString(16);
    while (s.length < 8) s = "0" + s;
    hex += s;
  });
  return hex;
}

// ------------------------------------------------------------
//  Hash de contraseña: salt por usuario + pepper del script,
//  repetido ITERACIONES_HASH veces para encarecer la fuerza bruta
// ------------------------------------------------------------
//  Usa sha256Hex (JavaScript puro) y no Utilities: estirar el
//  hash con llamadas a servicios de Apps Script tardaba ~1 minuto
//  por contraseña, y eso corre en cada login.
// ------------------------------------------------------------
function hashContrasena(contrasena, salt) {
  const pepper = secreto();               // se resuelve una sola vez
  let h = sha256Hex(String(salt) + ":" + String(contrasena) + ":" + pepper);
  for (let i = 0; i < ITERACIONES_HASH; i++) h = sha256Hex(h + pepper);
  return h;
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
  // hash y salt son columnas contiguas: una sola escritura
  h.getRange(fila, COLUMNAS.indexOf("hash") + 1, 1, 2)
   .setValues([[hashContrasena(contrasena, salt), salt]]);
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
  const h = hojaUsuarios();
  const cambios = [];

  // 1) Reparar filas a medio escribir (una corrida que se cortó
  //    por tiempo deja el usuario sin hash y sin salt).
  existentes.forEach(u => {
    if (String(u.hash || "").trim() && String(u.salt || "").trim()) return;
    const pass = contrasenaAlAzar();
    guardarContrasena(u._fila, pass, true);
    cambios.push({ nombre: String(u.nombre || ""), usuario: normalizarUsuario(u.usuario),
                   contrasena: pass, nota: "reparado" });
  });

  // 2) Dar de alta a los que falten, en un solo bloque de escritura
  const filas = [];
  aportantes().forEach(p => {
    const clave = p.nombre.trim().toLowerCase();
    if (yaTienen.indexOf(clave) !== -1) return;

    const usuario = usuarioDesdeNombre(p.nombre, tomados);
    const pass    = contrasenaAlAzar();
    const salt    = Utilities.getUuid();
    filas.push([usuario, p.nombre, hashContrasena(pass, salt), salt,
                "SI", "SI", new Date(), ""]);
    yaTienen.push(clave);
    cambios.push({ nombre: p.nombre, usuario: usuario, contrasena: pass, nota: "nuevo" });
  });

  if (filas.length) {
    h.getRange(h.getLastRow() + 1, 1, filas.length, COLUMNAS.length).setValues(filas);
  }

  Logger.log(informeCredenciales(cambios));
  return cambios;
}

// Vuelve a generar la contraseña de TODOS los usuarios cargados.
// Sirve cuando cambió la forma de calcular el hash y los viejos
// dejaron de valer. Todos quedan obligados a cambiarla al entrar.
function regenerarTodasLasClaves() {
  const cambios = leerUsuarios().map(u => {
    const pass = contrasenaAlAzar();
    guardarContrasena(u._fila, pass, true);
    return { nombre: String(u.nombre || ""), usuario: normalizarUsuario(u.usuario),
             contrasena: pass, nota: "regenerado" };
  });
  Logger.log(informeCredenciales(cambios));
  return cambios;
}

function informeCredenciales(cambios) {
  if (!cambios.length) return "No hubo cambios: ya estaban todos cargados.";
  const ancho = Math.max.apply(null, cambios.map(c => c.usuario.length));
  return cambios.length + " credencial(es) — copiá esto antes de cerrar:\n\n" +
    cambios.map(c =>
      c.usuario + Array(ancho - c.usuario.length + 3).join(" ") +
      c.contrasena + "   (" + c.nombre + ")"
    ).join("\n");
}

// Mide cuánto tarda de verdad un hash en este entorno.
function diagnostico() {
  const t0 = Date.now();
  hashContrasena("prueba-de-tiempo", "salt-de-prueba");
  const conHash = Date.now() - t0;

  const t1 = Date.now();
  for (let i = 0; i < 20; i++) hmac("x" + i);
  const conUtilities = Date.now() - t1;

  const informe =
    "Hash de una contraseña (" + ITERACIONES_HASH + " vueltas): " + conHash + " ms\n" +
    "20 llamadas a Utilities.computeHmacSha256Signature: " + conUtilities + " ms\n" +
    "Usuarios cargados: " + leerUsuarios().length;
  Logger.log(informe);
  return informe;
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

// ------------------------------------------------------------
//  Entrega el archivo de un comprobante adjunto
// ------------------------------------------------------------
//  Se comprueba que el adjunto cuelgue de una factura de
//  proveedor publicada ANTES de leer el contenido. Sin eso,
//  cualquiera con sesión podría pedir por id cualquier archivo
//  de la base de Odoo.
// ------------------------------------------------------------
const PESO_MAXIMO_ADJUNTO = 8 * 1024 * 1024;   // 8 MB

function obtenerAdjunto(idCrudo) {
  const id = parseInt(idCrudo, 10);
  if (!id || id < 1) throw new Error("Comprobante inválido.");

  const uid = autenticar();

  const meta = buscar(uid, "ir.attachment",
    [["id","=",id], ["res_model","=","account.move"], ["type","=","binary"]],
    ["id","name","mimetype","res_id","file_size"], 1, "id asc"
  );
  if (!meta.length) throw new Error("No se encontró ese comprobante.");
  const a = meta[0];

  const factura = buscar(uid, "account.move",
    [["id","=",a.res_id],
     ["move_type","in",["in_invoice","in_receipt"]],
     ["state","=","posted"]],
    ["id"], 1, "id asc"
  );
  if (!factura.length) throw new Error("Ese comprobante no corresponde a un gasto.");

  if ((a.file_size || 0) > PESO_MAXIMO_ADJUNTO) {
    throw new Error("El archivo pesa " + Math.round(a.file_size / 1048576) +
      " MB y no se puede abrir desde acá. Pedíselo a la comisión.");
  }

  const conDatos = buscar(uid, "ir.attachment", [["id","=",id]], ["id","datas"], 1, "id asc");
  if (!conDatos.length || !conDatos[0].datas) throw new Error("El comprobante está vacío.");

  return {
    ok:     true,
    nombre: a.name || "comprobante",
    tipo:   a.mimetype || "application/octet-stream",
    datos:  conDatos[0].datas          // base64
  };
}

// Para correr desde el editor: muestra qué adjuntos ve el script.
function diagnosticoAdjuntos() {
  const uid = autenticar();
  const facturas = buscar(uid, "account.move",
    [["move_type","in",["in_invoice","in_receipt"]], ["state","=","posted"]],
    ["id","name"], 500, "id desc"
  );
  const adjuntos = buscar(uid, "ir.attachment",
    [["res_model","=","account.move"], ["res_id","in", facturas.map(f => f.id)],
     ["type","=","binary"]],
    ["id","name","mimetype","res_id","file_size"], 500, "id asc"
  );

  const porFactura = {};
  adjuntos.forEach(a => {
    porFactura[a.res_id] = (porFactura[a.res_id] || []).concat(
      a.name + " (" + (a.mimetype || "?") + ", " +
      Math.round((a.file_size || 0) / 1024) + " KB)");
  });

  const informe = facturas.length + " gasto(s), " + adjuntos.length + " adjunto(s)\n\n" +
    facturas.map(f =>
      f.name + ": " + ((porFactura[f.id] || []).join(" | ") || "SIN COMPROBANTE")
    ).join("\n");
  Logger.log(informe);
  return informe;
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

      case "adjunto": {
        const s = sesion(req.token);
        if (s.c) throw new Error("DEBE_CAMBIAR");
        return respuestaJson(obtenerAdjunto(req.id));
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

  // Comprobantes adjuntos de cada factura. Sólo los metadatos:
  // el archivo se pide aparte, cuando alguien lo abre.
  const mapaAdjuntos = {};
  const idsGastos = rawGastos.map(f => f.id);
  if (idsGastos.length) {
    buscar(uid, "ir.attachment",
      [["res_model","=","account.move"], ["res_id","in",idsGastos], ["type","=","binary"]],
      ["id","name","mimetype","res_id","file_size"], 500, "id asc"
    ).forEach(a => {
      if (!mapaAdjuntos[a.res_id]) mapaAdjuntos[a.res_id] = [];
      mapaAdjuntos[a.res_id].push({
        id:     a.id,
        nombre: a.name || "comprobante",
        tipo:   a.mimetype || "",
        peso:   a.file_size || 0
      });
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
      adjuntos:    mapaAdjuntos[f.id] || [],
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
