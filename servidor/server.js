/* Centinela-IA SST · servidor (Render + Neon). Una aplicación de SkyNet Genesis.
   Guarda los mismos documentos que usa la aplicación (ruta → datos) en PostgreSQL,
   responde desde memoria para que la base pueda dormir, y aplica los permisos por rol. */
'use strict';
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');

const PORT = Number(process.env.PORT || 10000);
const SECRETO = process.env.SECRETO_SESION || crypto.randomBytes(32).toString('hex');
const ORIGENES = (process.env.ORIGENES || '*').split(',').map(s => s.trim()).filter(Boolean);
const CLAVE_CRON = process.env.CLAVE_CRON || '';
const BREVO_KEY = process.env.BREVO_API_KEY || '';
const CORREO_REMITENTE = process.env.CORREO_REMITENTE || '';
const URL_APP = process.env.URL_APP || 'https://centinela.skynetgenesis.com';
const URL_API = process.env.URL_API || 'https://centinela-sst-api.onrender.com';
const CORREO_DUENO = process.env.CORREO_DUENO || 'contacto@skynetgenesis.com';
/* (21 oct 2026, decisión de Ricardo) Centinela-IA ya no usa IA: los documentos del SG-SST se venden ya elaborados en el Market.
   Cada documento es un pago único con Bold (plan centinela:doc-<código> o varios en centinela:paq_doc-a_doc-b). Precios PROPUESTOS, pendientes de su aprobación:
   deben ser iguales a los de $PLANES en bold-firma.php y a MKT_DOCS del cliente. Las plantillas viven en la base (plantillas/<código>), no en el código público. */
const MKT_DOCS = { 'POL-01':80000, 'OBJ-01':60000, 'MAN-01':250000, 'MAN-02':120000, 'PLA-01':150000, 'PRG-01':120000, 'PRO-07':120000, 'PRO-01':150000, 'PRO-02':150000, 'PRO-03':120000, 'PRO-04':90000, 'PRO-05':90000, 'PRO-06':120000, 'PRG-06':120000, 'PRG-07':120000, 'PLA-02':220000, 'REG-01':80000, 'PRG-02':180000, 'PRG-03':180000, 'PRG-04':180000, 'PRG-05':150000, 'POL-02':80000, 'POL-03':150000, 'PLA-03':250000 };
const MKT_TODOS = 1690000; // paquete con los 24 documentos
const mktClave = cod => 'doc-' + cod.toLowerCase().replace(/[^a-z0-9]/g, ''); // POL-01 -> doc-pol01
const hay = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const MKT = Object.fromEntries([...Object.entries(MKT_DOCS).map(([c, v]) => [mktClave(c), { precio:v, docs:[c] }]), ['doc-todos', { precio:MKT_TODOS, docs:Object.keys(MKT_DOCS) }]]);
const BOLD_VERIFICAR = process.env.BOLD_VERIFICAR || 'https://skynetgenesis.com/bold-verificar.php'; // central de pagos de SkyNet Genesis
const DIAS_PRUEBA = 15;
const TRAMOS_DEF = [{ hasta:10, precio:89000 }, { hasta:50, precio:159000 }, { hasta:200, precio:289000 }, { hasta:null, precio:490000 }];
const DB_URL = process.env.DATABASE_URL || '';
/* (31 oct 2026, directiva SkyNet Genesis) Superadministrador propio de la app y enlaces de contraseña del dueño directo a su Gmail */
const SUPER_CORREO = 'superadmin.centinela@skynetgenesis.com';
const DUENO_CORREO = process.env.DUENO_CORREO || 'rikardolondono@gmail.com';
const DUENO_CUENTAS = new Set([SUPER_CORREO, 'superadmin@skynetgenesis.com', ...String(process.env.DUENO_CUENTAS || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean)]);
const CUPO_MB = Number(process.env.CUPO_MB || 100); // espacio para evidencias adjuntas por empresa (MB)
const SMMLV = Number(process.env.SMMLV || 1750905); // salario mínimo 2026 (Decreto 1469 de 2025)
if (!process.env.SECRETO_SESION) console.warn('Aviso: falta SECRETO_SESION; las sesiones se cierran al reiniciar.');

/* ---------- almacenamiento: memoria + PostgreSQL (o archivo local para pruebas) ---------- */
const DOCS = new Map();          // ruta -> { data, ts }
const BORRADOS = new Map();      // ruta -> ts
const EPOCH = Date.now().toString(36);
let RELOJ = 0; const tic = () => (RELOJ = Math.max(RELOJ + 1, Date.now()));
let pool = null;
const ARCHIVO = process.env.ARCHIVO_LOCAL || '';

async function iniciarBD(){
  if (DB_URL){
    const { Pool } = require('pg');
    process.on('unhandledRejection', e => console.error('Promesa sin manejar:', e && e.message));
    pool = new Pool({ connectionString:DB_URL, ssl: /localhost|127\.0\.0\.1/.test(DB_URL) ? false : { rejectUnauthorized:false }, max:3, idleTimeoutMillis:10000 });
    pool.on('error', e => console.error('Conexión de la base cerrada (Neon dormido):', e.message)); // sin esto Node se cae cuando Neon duerme
    await pool.query(`create table if not exists docs (ruta text primary key, coleccion text not null, empresa text, datos jsonb not null, actualizado timestamptz not null default now())`);
    await pool.query(`create index if not exists docs_empresa on docs(empresa)`);
    await pool.query(`create table if not exists archivos (id text primary key, empresa text, tipo text not null, bytes int not null, datos bytea not null, creado timestamptz not null default now())`);
    (await pool.query('select empresa, sum(bytes)::bigint b from archivos group by empresa')).rows.forEach(x => USO.set(x.empresa || '', Number(x.b)));
    const r = await pool.query('select ruta, datos from docs');
    r.rows.forEach(x => DOCS.set(x.ruta, { data:x.datos, ts:tic() }));
    console.log('Documentos cargados desde PostgreSQL:', DOCS.size);
  } else if (ARCHIVO && fs.existsSync(ARCHIVO)){
    const o = JSON.parse(fs.readFileSync(ARCHIVO, 'utf8')); Object.entries(o).forEach(([k, v]) => DOCS.set(k, { data:v, ts:tic() }));
    console.log('Documentos cargados desde archivo:', DOCS.size);
  } else console.log('Sin base de datos: modo de prueba en memoria.');
  for (const [ruta, v] of DOCS){ // el Superadministrador entra con su correo propio (superadmin.centinela@); conserva su contraseña
    const u = v.data; if (!/^usuarios\//.test(ruta) || !u || u.rol !== 'super') continue;
    if (u.usuario === 'superadmin@skynetgenesis.com' || String(u.correo || '').toLowerCase() === 'superadmin@skynetgenesis.com'){
      if (coleccion('usuarios').some(x => x.usuario === SUPER_CORREO || String(x.correo || '').toLowerCase() === SUPER_CORREO)) continue;
      await poner(ruta, { ...u, usuario:u.usuario === 'superadmin@skynetgenesis.com' ? SUPER_CORREO : u.usuario, correo:SUPER_CORREO }); console.log('Superadministrador cambiado a', SUPER_CORREO); }
  }
}
/* ---------- archivos adjuntos (evidencias, documentos de contratistas, manuales): tabla aparte, no van a la memoria ni a la sincronización ---------- */
const USO = new Map(); const ARCH_MEM = new Map();
const TIPOS_ARCH = ['image/jpeg','image/png','image/webp','application/pdf'];
async function guardarArchivo(empresa, tipo, b64, idFijo){
  if (!TIPOS_ARCH.includes(tipo)) throw { status:400, code:'invalid_argument', message:'Solo se aceptan fotos (JPG, PNG, WEBP) o PDF.' };
  const buf = Buffer.from(String(b64 || ''), 'base64'); if (!buf.length) throw { status:400, code:'invalid_argument', message:'El archivo está vacío.' };
  if (!idFijo && buf.length > 2.5e6) throw { status:413, code:'too_large', message:'El archivo pesa más de 2,5 MB. Para PDF, envíe uno más liviano (las fotos se reducen solas).' };
  if (tipo === 'application/pdf' ? buf.slice(0, 4).toString() !== '%PDF' : !(buf[0] === 0xFF || buf[0] === 0x89 || buf.slice(8, 12).toString() === 'WEBP')) throw { status:400, code:'invalid_argument', message:'El archivo no corresponde a su tipo.' };
  const k = empresa || ''; const usado = USO.get(k) || 0;
  if (empresa && usado + buf.length > CUPO_MB * 1048576) throw { status:507, code:'sin_espacio', message:'Su empresa llegó al límite de ' + CUPO_MB + ' MB para adjuntos. Escríbanos por WhatsApp 304 437 5758.' };
  const id = idFijo || 'f' + crypto.randomBytes(9).toString('hex');
  if (empresa) USO.set(k, usado + buf.length); // se reserva antes de escribir: dos subidas al tiempo no pasan el límite
  try {
  if (pool) await pool.query('insert into archivos (id, empresa, tipo, bytes, datos) values ($1,$2,$3,$4,$5) on conflict (id) do update set tipo = excluded.tipo, bytes = excluded.bytes, datos = excluded.datos', [id, empresa, tipo, buf.length, buf]);
  else ARCH_MEM.set(id, { empresa, tipo, datos:buf });
  } catch(e){ if (empresa) USO.set(k, Math.max(0, (USO.get(k) || 0) - buf.length)); throw e; }
  return { id, bytes:buf.length };
}
async function leerArchivo(id){
  if (pool){ const r = await pool.query('select empresa, tipo, datos from archivos where id = $1', [id]); return r.rows[0] || null; }
  return ARCH_MEM.get(id) || null;
}
const partes = ruta => { const i = ruta.lastIndexOf('/'); return [ruta.slice(0, i), ruta.slice(i + 1)]; };
const empresaDe = ruta => { const m = /^e\/([^/]+)\//.exec(ruta); return m ? m[1] : null; };
let guardadoArchivo = null;
async function persistir(ruta, data){
  if (pool){
    if (data === null) await pool.query('delete from docs where ruta = $1', [ruta]);
    else await pool.query(`insert into docs (ruta, coleccion, empresa, datos, actualizado) values ($1,$2,$3,$4,now()) on conflict (ruta) do update set datos = excluded.datos, actualizado = now()`, [ruta, partes(ruta)[0], empresaDe(ruta), data]);
  } else if (ARCHIVO){
    clearTimeout(guardadoArchivo); guardadoArchivo = setTimeout(() => { const o = {}; DOCS.forEach((v, k) => o[k] = v.data); fs.writeFileSync(ARCHIVO, JSON.stringify(o)); }, 300);
  }
}
async function poner(ruta, data){
  if (pool && /^empresas\//.test(ruta)) data = await ponerEmpresa(ruta, data); else await persistir(ruta, data);
  DOCS.set(ruta, { data, ts:tic() }); BORRADOS.delete(ruta);
}
/* Fin de mes n meses después de un fin de mes (o de cualquier fecha) */
const avanzarMeses = (iso, n) => { let h = String(iso || '').slice(0, 10) || HOY(); for (let i = 0; i < n; i++){ const d = new Date(h + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + 1); h = finMes(d.toISOString().slice(0, 10)); } return h; };
/* Si la base tiene pagos de Bold que la copia que se guarda no tiene, se suman (sin perder meses pagados) */
function sumarPagosBold(d, enBase){
  if (!enBase) return d; const tiene = new Set((d.pagos || []).map(x => x.recibo || x.ref));
  const faltan = (enBase.pagos || []).filter(x => x.medio === 'Bold' && !tiene.has(x.recibo || x.ref)); if (!faltan.length) return d;
  const meses = faltan.filter(x => !x.concepto).reduce((a, x) => a + Number(x.meses ?? 1), 0); // las compras del Market no suman meses
  return { ...d, pagos:[...(d.pagos || []), ...faltan], vence:meses ? avanzarMeses(d.vence || enBase.vence, meses) : (d.vence || enBase.vence), ia:enBase.ia || d.ia, modulos:{ ...(d.modulos || {}), ...(enBase.modulos || {}) }, suspendida:meses ? false : d.suspendida };
}
/* Las empresas se guardan dentro de una transacción con bloqueo, porque la central de Bold también las modifica en la base */
async function ponerEmpresa(ruta, data){
  const c = await pool.connect();
  try {
    await c.query('begin'); await c.query('select pg_advisory_xact_lock(4242)');
    const r = await c.query('select datos from docs where ruta = $1 for update', [ruta]); data = sumarPagosBold(data, r.rows[0]?.datos);
    await c.query(`insert into docs (ruta, coleccion, empresa, datos, actualizado) values ($1,'empresas',null,$2,now()) on conflict (ruta) do update set datos = excluded.datos, actualizado = now()`, [ruta, data]);
    await c.query('commit'); return data;
  } catch(e){ await c.query('rollback').catch(() => {}); throw e; } finally { c.release(); }
}
async function quitar(ruta){ await persistir(ruta, null); DOCS.delete(ruta); BORRADOS.set(ruta, tic()); }
const doc = ruta => DOCS.get(ruta)?.data;
const coleccion = col => [...DOCS.entries()].filter(([k]) => partes(k)[0] === col).map(([k, v]) => ({ id:partes(k)[1], ...v.data }));

/* ---------- sesiones firmadas ---------- */
const b64 = s => Buffer.from(s).toString('base64url');
function firmar(p, ms){ const c = b64(JSON.stringify({ ...p, exp:Date.now() + (ms || 12 * 3600e3) })); return c + '.' + crypto.createHmac('sha256', SECRETO).update(c).digest('base64url'); }
function leerToken(t){
  if (!t) return null; const [c, f] = String(t).split('.'); if (!c || !f) return null;
  const ok = crypto.createHmac('sha256', SECRETO).update(c).digest('base64url');
  if (ok.length !== f.length || !crypto.timingSafeEqual(Buffer.from(ok), Buffer.from(f))) return null;
  const p = JSON.parse(Buffer.from(c, 'base64url').toString()); if (p.exp < Date.now()) return null; return p;
}
const huellaClave = u => crypto.createHmac('sha256', SECRETO).update('r:' + u.hash).digest('base64url').slice(0, 16); // cambia al cambiar la contraseña
const claveFuerte = n => n.length >= 10 && /[a-zA-Z]/.test(n) && /\d/.test(n);
const MSG_CLAVE = 'La contraseña debe tener mínimo 10 caracteres, con letras y números.';
const hashClave = (clave, sal) => crypto.pbkdf2Sync(String(clave), String(sal), 120000, 32, 'sha256').toString('hex');
function sesion(req){
  const p = leerToken((req.headers.authorization || '').replace(/^Bearer\s+/i, '')); if (!p) return null;
  if (p.t === 'u'){ const u = doc('usuarios/' + p.uid); if (!u || u.activo === false) return null;
    if (u.rol === 'asesor'){ const lst = Array.isArray(u.empresas) ? u.empresas : []; const emp = lst.includes(u.empresa) ? u.empresa : null; // el asesor trabaja como administrador de la empresa que eligió
      return { t:'u', uid:p.uid, rol:'admin', asesor:true, asesorDe:lst, empresa:emp, nombre:u.nombre, usuario:u.usuario, cerrada:emp ? empresaCerrada(emp) : false }; }
    return { t:'u', uid:p.uid, rol:u.rol, empresa:u.empresa, nombre:u.nombre, usuario:u.usuario, area:u.rol === 'jefe' ? String(u.area || '').trim().toLowerCase() : undefined, cerrada:u.rol !== 'super' && empresaCerrada(u.empresa) }; }
  if (p.t === 'w'){ const t = doc('e/' + p.cid + '/trabajadores/' + p.tid); if (!t || t.estado === 'retirado' || empresaCerrada(p.cid)) return null; return { t:'w', cid:p.cid, tid:p.tid }; }
  return null;
}

/* ---------- límites de intentos ---------- */
const INTENTOS = new Map();
function frenar(clave, max, ventanaMin){ const ahora = Date.now(); const a = (INTENTOS.get(clave) || []).filter(x => ahora - x < ventanaMin * 60e3); INTENTOS.set(clave, a); return a.length >= max; }
const fallo = clave => INTENTOS.set(clave, [...(INTENTOS.get(clave) || []), Date.now()]);

/* ---------- permisos ---------- */
const CLIN = new Set(['hc','tamizajes','casos','autoreportes','bateriaInd','paraclinicos']);
const PORTAL_PROPIOS = new Set(['evaluaciones','tamizajes','cursosRes','epp','reportes','autoreportes','cambios','practicaRes','votos','sociodemo','tareas','lecturas','reintegros']);
const PORTAL_TODOS = new Set(['cargos','cursos','capacitaciones','elecciones']);
/* jefe de área: ve y gestiona solo lo de su área (trabajadores con el mismo campo "área") */
const JEFE_NO = new Set(['bitacora','quejas','sociodemo','bateria','incapacidades','presupuesto','config','encuestaRes','urna','votos','postulaciones','informes','auditorias']);
const JEFE_ESCRIBE = new Set(['tareas','reportes','inspecciones','caminatas','visitantes','bitacora','acpm']);
const enArea = (s, cid, tid) => { const t = tid && doc('e/' + cid + '/trabajadores/' + tid); return !!t && String(t.area || '').trim().toLowerCase() === s.area && !!s.area; };
/* respuestas correctas de los simulacros por casos (deben coincidir con CASOS_PR del cliente) */
const CLAVES_CASOS = {b1:[0,1,0,1],b2:[1,0,0],b3:[1,0,1],v1:[1,0,1],v2:[1,1,0],v3:[1,1,1],c1:[1,1,1],c2:[1,0,1],c3:[1,1,0],b4:[1,2,0],b5:[2,2,0],b6:[0,2,0],b7:[2,2,0],b8:[2,0,1],v4:[0,1,1],v5:[2,0,2],v6:[0,0,0,0],v7:[2,2,1],v8:[2,1,0],v9:[1,2,2],c4:[0,1,1],c5:[0,0,2],c6:[1,1,1],c7:[2,2,2],c8:[2,1,1],al1:[2,1,2],al2:[0,0,2],al3:[1,1,2],al4:[1,1,1],ec1:[0,2,1],ec2:[2,0,0],ec3:[1,1,1],el1:[1,2,0],el2:[0,0,2],el3:[0,0,2],q1:[1,2,2],q2:[2,1,0],q3:[2,1,2],q4:[0,1,1],m1:[0,0,1],m2:[1,1,2],m3:[2,0,0],bi1:[1,2,1],bi2:[2,1,0],bi3:[1,1,1],er1:[0,1,2],er2:[1,2,1],er3:[0,0,2],pa1:[0,0,1],pa2:[2,1,1],pa3:[0,2,2],pa4:[2,2,1],pa5:[0,0,0],pa6:[2,0,1],pa7:[2,1,1],ap1:[1,2,1],ap2:[1,1,1],ap3:[1,0,1],co1:[1,0,2],co2:[0,0,2],co3:[2,0,0],cn1:[2,0,2],cn2:[0,2,0],cn3:[1,0,0],ag1:[0,0,1],ag2:[2,1,0],ag3:[1,1,1],ag4:[2,1,0],mi1:[1,1,2],mi2:[0,1,0],mi3:[2,2,0],ca1:[1,1,1],ca2:[0,0,1],ps1:[1,0,0],ps2:[2,1,0],ps3:[1,0,2],ps4:[2,1,2],of1:[0,1,1],of2:[0,0,2],of3:[0,0,2]};
/* código de asistencia: el secreto de cada capacitación o, en las antiguas, el derivado de su id (mismo cálculo que el cliente) */
const codCap = id => { let h = 7; for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) % 900000; return String(1000 + h % 9000); };
const codAsis = (id, c) => (c && c.codigoAsis) || codCap(id);
const esClin = r => r === 'medico' || r === 'psicologo';
function puedeLeer(s, ruta, d){
  const [col, id] = partes(ruta);
  if (s.t === 'w'){
    if (ruta === 'empresas/' + s.cid || ruta === 'plataforma/config') return true;
    const cid = empresaDe(ruta); if (cid !== s.cid) return false; const c = col.split('/')[2];
    if (c === 'trabajadores') return id === s.tid;
    if (c === 'lecciones') return !!(d && d.publicada);
    if (c === 'urna') return false;
    if (c === 'postulaciones') return !!(d && (d.trabajador === s.tid || d.estado === 'aceptada'));
    if (PORTAL_TODOS.has(c)) return true;
    if (c === 'comunicados') return !!(d && d.publicado && (!d.hasta || d.hasta >= HOY()));
    if (c === 'tareas') return !!d && d.trabajador === s.tid && !!d.paraTrabajador && !d.anulado; // solo las tareas que el trabajador debe hacer
    if (PORTAL_PROPIOS.has(c)) return d && d.trabajador === s.tid;
    return false;
  }
  if (s.cerrada) return ruta === 'empresas/' + s.empresa || ruta === 'usuarios/' + s.uid || col === 'plataforma';
  if (col === 'plantillas' || col === 'manuales') return false; // plantillas del Market: solo el servidor las usa
  if (col === 'boldpagos' || col === 'pruebas' || col === 'iauso') return s.rol === 'super';
  if (col === 'usuarios') return s.rol === 'super' || id === s.uid || (d && d.rol !== 'asesor' && d.empresa === s.empresa && !!s.empresa) || (d && d.rol === 'asesor' && s.rol === 'admin' && !s.asesor && (d.empresas || []).includes(s.empresa));
  if (col === 'pagosAviso') return s.rol === 'super' || (s.rol === 'admin' && !!s.empresa && d && d.empresa === s.empresa);
  if (col === 'empresas') return s.rol === 'super' || id === s.empresa || (!!s.asesor && s.asesorDe.includes(id));
  if (col === 'plataforma' || col === 'normas') return true;
  if (col === 'soporte') return s.rol === 'super' || (!!s.empresa && d && d.empresa === s.empresa);
  const cid = empresaDe(ruta); if (!cid) return false;
  if (s.rol === 'super') return false; // el Superadministrador administra la plataforma, no ve los datos de trabajo de las empresas
  if (cid !== s.empresa) return false;
  const c = col.split('/')[2];
  if (CLIN.has(c)) return esClin(s.rol);
  if (s.rol === 'jefe'){
    if (JEFE_NO.has(c)) return false;
    if (!s.area) return false; // un jefe sin área no ve datos de personas ni tareas
    if (c === 'evidencias'){ if (!d || JEFE_NO.has(d.col) || CLIN.has(d.col) || d.col === 'contratistas') return false; const rp = 'e/' + cid + '/' + d.col + '/' + d.ref; const pr = doc(rp); return !!pr && puedeLeer(s, rp, pr); }
    if (c === 'trabajadores') return enArea(s, cid, id);
    if (d && d.trabajador) return enArea(s, cid, d.trabajador);
    if (c === 'tareas') return !!d && String(d.area || '').trim().toLowerCase() === s.area;
    return true; }
  if (c === 'quejas') return ['admin','psicologo','super'].includes(s.rol);
  if (c === 'encuestaRes' && d && d.anonima){ const cm = doc('e/' + cid + '/comunicados/' + d.comunicado); return !!cm && !!cm.hasta && cm.hasta < HOY(); } // resultados anónimos: al cerrar
  if (c === 'sociodemo') return ['admin','medico','psicologo'].includes(s.rol);
  if (c === 'urna'){ const el = doc('e/' + cid + '/elecciones/' + id); return !!el && el.estado === 'cerrada'; } // el conteo se ve solo después del escrutinio
  return true;
}
const limpiarUsuario = d => { if (!d) return d; const { sal, hash, ...r } = d; return { ...r, claveOk:!!hash }; };
const iguales = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function sinCampos(o, ks){ const r = { ...(o || {}) }; ks.forEach(k => delete r[k]); return r; }

/* Devuelve el documento a guardar (o lanza un error con código) */
function revisarEscritura(s, ruta, d, borrar){
  const [col, id] = partes(ruta); const prev = doc(ruta);
  const no = () => { throw { status:403, code:'forbidden', message:'No tiene permiso para esta acción.' }; };
  if (!/^[A-Za-z0-9_./@:-]+$/.test(ruta) || ruta.split('/').length % 2 !== 0) throw { status:400, code:'invalid_argument', message:'Ruta no válida.' };
  if (s.t === 'w'){
    if (borrar) no(); const cid = empresaDe(ruta); if (cid !== s.cid) no(); const c = col.split('/')[2];
    if (c === 'bitacora') return d;
    if (c === 'trabajadores'){ if (id !== s.tid || !prev || !iguales(sinCampos(prev, ['consentimiento']), sinCampos(d, ['consentimiento']))) no(); return d; }
    if (c === 'capacitaciones') no(); // la asistencia se registra con /api/asistencia (verifica el código en el servidor)
    if (c === 'sociodemo'){ if (id !== s.tid || d.trabajador !== s.tid) no(); return d; } // su propia encuesta (la puede actualizar)
    if (prev) no();
    if (['tamizajes','cursosRes','autoreportes'].includes(c)){ if (d.trabajador !== s.tid) no(); const NV = ['bajo','medio','alto']; return c === 'cursosRes' ? { ...d, puntaje:Math.max(0, Math.min(100, Number(d.puntaje) || 0)), aprobado:d.aprobado === true } : c === 'tamizajes' ? { ...d, puntaje:Number(d.puntaje) || 0, max:Number(d.max) || 0, nivel:NV.includes(d.nivel) ? d.nivel : 'medio' } : d; }
    if (c === 'practicaRes'){ const cl = CLAVES_CASOS[d.caso]; const rs = Array.isArray(d.respuestas) ? d.respuestas.map(Number) : []; if (d.trabajador !== s.tid || !cl || rs.length !== cl.length) no();
      const ok = cl.filter((v, i) => v === rs[i]).length; return { caso:d.caso, grupo:String(d.grupo || '').slice(0, 20), trabajador:s.tid, respuestas:rs, ok, puntaje:Math.round(ok / cl.length * 100), fecha:HOY(), en:new Date().toISOString() }; }
    if (c === 'cambios'){ if (d.trabajador !== s.tid) no(); return { descripcion:String(d.descripcion || '').slice(0, 2000), impacto:String(d.impacto || '').slice(0, 2000), tipo:'Novedad reportada por un trabajador', trabajador:s.tid, fecha:HOY(), estado:'propuesto', origen:'Portal del trabajador', en:new Date().toISOString() }; }
    if (c === 'postulaciones'){ const el = doc('e/' + s.cid + '/elecciones/' + d.eleccion); if (d.trabajador !== s.tid || !el || el.estado !== 'inscripcion' || coleccion('e/' + s.cid + '/postulaciones').some(x => x.eleccion === d.eleccion && x.trabajador === s.tid)) no(); return { eleccion:String(d.eleccion), trabajador:s.tid, propuesta:String(d.propuesta || '').slice(0, 400), fecha:HOY(), estado:'pendiente' }; }
    if (c === 'reportes'){ if (d.trabajador && d.trabajador !== s.tid) no(); return d; }
    if (c === 'tareas'){ if (d.trabajador !== s.tid) no(); const { responsableU, paraTrabajador, area, ...r } = d; return r; }
    if (c === 'casos'){ if (d.trabajador !== s.tid) no(); return { __caso:true, ...d, nivel:['bajo','medio','alto'].includes(d.nivel) ? d.nivel : 'medio' }; }
    no();
  }
  const R = s.rol;
  if (col === 'pagosAviso'){ // (oct 2026) la mensualidad se paga solo con Bold: ya no hay avisos "Ya pagué"
    if (R === 'super') return borrar ? null : d;
    throw { status:403, code:'solo_bold', message:'La mensualidad se paga en línea con Bold.' };
  }
  if (col === 'boldpagos' || col === 'pruebas'){ if (R !== 'super' || !borrar) no(); return null; } // los escribe solo el servidor
  if (col === 'plantillas') no(); // se cargan con /api/super/plantillas
  if (s.cerrada) throw { status:402, code:'cerrada', message:'El acceso de su empresa está cerrado por pago pendiente.' };
  if (col === 'usuarios'){
    if (borrar){ if (R !== 'super') no(); return null; }
    const otro = coleccion('usuarios').find(u => u.usuario === d.usuario && u.id !== id); if (otro) throw { status:409, code:'usuario_existe', message:'Ese usuario ya existe. Elija otro.' };
    const cor = String(d.correo || '').trim().toLowerCase();
    if (cor && coleccion('usuarios').some(u => u.id !== id && (String(u.correo || '').toLowerCase() === cor || u.usuario === cor))) throw { status:409, code:'correo_existe', message:'Ese correo ya lo usa otra cuenta.' };
    if (String(d.usuario || '').includes('@') && d.usuario !== cor && !(prev && prev.usuario === d.usuario)) throw { status:400, code:'invalid_argument', message:'Si el usuario es un correo, debe ser el mismo correo del usuario.' };
    const base = { ...d }; delete base.claveOk; if (!base.hash && prev?.hash){ base.sal = prev.sal; base.hash = prev.hash; }
    if (R !== 'super'){ base.ultimo = prev?.ultimo; base.bloqueo = prev?.bloqueo; }
    if (prev?.rol === 'asesor' || d.rol === 'asesor'){ // las empresas de un asesor solo cambian por invitación del administrador de cada empresa
      if (R === 'super' && !s.asesor) return prev ? { ...base, empresas:prev.empresas || [], empresa:prev.empresa || null } : { ...base, empresas:[], empresa:null };
      if (id === s.uid && prev) return { ...base, rol:prev.rol, empresa:prev.empresa, empresas:prev.empresas || [], activo:prev.activo, usuario:prev.usuario };
      no();
    }
    if (R === 'super') return base;
    if (d.rol === 'jefe' && !String(d.area || '').trim()) throw { status:400, code:'invalid_argument', message:'Escriba el área del jefe de área.' };
    if (R === 'admin' && s.empresa && d.empresa === s.empresa && ['admin','medico','psicologo','auxiliar','consulta','jefe'].includes(d.rol) && (!prev || (prev.empresa === s.empresa && prev.rol !== 'super'))) return { ...base, ultimo:prev?.ultimo, bloqueo:prev?.bloqueo, activo:prev?.bloqueo ? false : base.activo }; // una cuenta bloqueada por la plataforma solo la desbloquea el Superadministrador
    if (id === s.uid && prev) return { ...base, rol:prev.rol, empresa:prev.empresa, activo:prev.activo, usuario:prev.usuario, area:prev.area, ultimo:prev.ultimo, bloqueo:prev.bloqueo };
    no();
  }
  if (col === 'empresas' && !borrar && d.logo && !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(String(d.logo))) throw { status:400, code:'invalid_argument', message:'El logo no es una imagen válida.' };
  if (col === 'empresas'){
    if (R === 'super'){ if (borrar) return null;
      if (prev) return { ...d, trabajadoresActivos:prev.trabajadoresActivos, ia:prev.ia, modulos:prev.modulos, correcciones:prev.correcciones, vence:prev.vence, pagos:prev.pagos || [], prueba:prev.prueba, interna:prev.interna, ipsLlave:prev.ipsLlave, visitasV:prev.visitasV }; // el súper no regala: fechas y pagos solo con Bold o una corrección con motivo
      const hoy = HOY(); const d0 = new Date(hoy + 'T12:00:00Z'); d0.setUTCDate(d0.getUTCDate() + DIAS_PRUEBA - 1); const hp = d0.toISOString().slice(0, 10);
      return { ...d, trabajadoresActivos:0, pagos:[], vence:hp, prueba:{ desde:hoy, hasta:hp }, ia:undefined, modulos:undefined, correcciones:undefined, interna:undefined, ipsLlave:undefined, visitasV:undefined }; }
    if (borrar || id !== s.empresa || !prev || R === 'consulta') no();
    if (esClin(R)) return { ...prev, resumenVigilancia:d.resumenVigilancia }; // el médico y el psicólogo solo publican el resumen de vigilancia (sin nombres)
    if (R !== 'admin') no(); // los demás datos de la empresa los cambia solo su administrador
    return { ...d, pagos:prev.pagos, vence:prev.vence, creado:prev.creado, nit:prev.nit, suspendida:prev.suspendida, trabajadoresActivos:prev.trabajadoresActivos, inicioUso:prev.inicioUso, prueba:prev.prueba, ia:prev.ia, modulos:prev.modulos, correcciones:prev.correcciones, interna:prev.interna, ipsLlave:prev.ipsLlave, visitasV:prev.visitasV };
  }
  if (col === 'plataforma' || col === 'normas'){ if (R !== 'super') no(); return borrar ? null : d; }
  if (col === 'soporte'){
    if (R === 'super') return borrar ? null : d;
    if (borrar || !s.empresa || d.empresa !== s.empresa || (prev && prev.empresa !== s.empresa)) no(); return d;
  }
  const cid = empresaDe(ruta); if (!cid || !doc('empresas/' + cid)) no();
  if (R === 'super' || cid !== s.empresa) no(); // el Superadministrador no escribe datos de trabajo de las empresas
  const c = col.split('/')[2];
  if (c === 'bitacora') return borrar ? no() : d;
  if (R === 'consulta') no();
  if (R === 'jefe'){
    if (!JEFE_ESCRIBE.has(c) || borrar) no();
    if (!s.area) no();
    const ar = x => String(x || '').trim().toLowerCase();
    if (c === 'tareas'){ const t = prev || d; const okA = ar(t.area) === s.area || enArea(s, cid, t.trabajador); if (!okA || (prev && (d.trabajador || null) !== (prev.trabajador || null)) || (prev && ar(d.area) !== ar(prev.area)) || (d.trabajador && !enArea(s, cid, d.trabajador))) no(); }
    if (c === 'acpm'){ if (prev && ar(prev.area) !== s.area) no(); d = { ...d, area:prev ? prev.area : s.area }; } // acciones que salen de sus inspecciones y caminatas
    if (c === 'reportes' && ((prev && prev.trabajador && !enArea(s, cid, prev.trabajador)) || (d.trabajador && !enArea(s, cid, d.trabajador)))) no();
  }
  if (['encuestaRes','lecturas'].includes(c)) no(); // las escribe el servidor (/api/encuesta)
  if (c === 'evidencias'){ // los adjuntos se suben con /api/archivo; aquí solo se anulan con motivo
    if (borrar || !prev) throw { status:403, code:'forbidden', message:'Los adjuntos no se borran: se anulan con un motivo.' };
    if (prev.anulado || !d.anulado || R !== 'admin') no();
    const motivo = String(d.anulado.motivo || '').trim().slice(0, 500); if (motivo.length < 10) throw { status:400, code:'invalid_argument', message:'Escriba el motivo de la anulación (mínimo 10 caracteres).' };
    return { ...prev, anulado:{ motivo, fecha:HOY(), por:s.nombre || '', en:new Date().toISOString() } };
  }
  if (c === 'visitantes' && prev && prev.salida && (borrar || d.salida !== prev.salida)) no();
  if (c === 'contratistas' && prev && !borrar){ // el enlace y lo que subió el contratista solo los cambia el servidor
    const docs = { ...(d.docs || {}) }; Object.entries(prev.docs || {}).forEach(([k, x]) => { if (x && x.subido) docs[k] = { ...(docs[k] || {}), subido:x.subido }; });
    const hasta = String(d.revisadoHasta || prev.revisadoHasta || ''); const porRevisar = Object.values(docs).some(x => x && x.subido && String(x.subido.en || '') > hasta);
    return { ...d, docs, enlaceV:prev.enlaceV, revisadoHasta:hasta, porRevisar };
  }
  if (['accidentes','tareas','reportes'].includes(c)){ // (21 oct 2026) registros del SG-SST se conservan: no se borran; se anulan con motivo
    if (borrar) throw { status:403, code:'forbidden', message:'Este registro no se elimina: anúlelo con un motivo para que quede la evidencia.' };
    if (prev?.anulado) throw { status:403, code:'forbidden', message:'El registro está anulado y ya no se modifica.' };
    if (d.anulado){
      if (R !== 'admin') throw { status:403, code:'forbidden', message:'Solo el administrador SG-SST anula registros.' };
      const motivo = String(d.anulado.motivo || '').trim().slice(0, 500); if (motivo.length < 10 || !prev) throw { status:400, code:'invalid_argument', message:'Escriba el motivo de la anulación (mínimo 10 caracteres).' };
      return { ...prev, anulado:{ motivo, fecha:HOY(), por:s.nombre || '', en:new Date().toISOString() } };
    }
    if (prev) return { ...prev, ...d, anulado:undefined }; // una edición no puede vaciar el registro
  }
  if (c === 'config'){ // parametrización de la empresa: solo el administrador, con forma validada
    if (R !== 'admin' || id !== 'param') no(); if (borrar) no();
    const txt = (x, n) => String(x ?? '').replace(/[<>]/g, '').slice(0, n); const idOk = k => /^[A-Za-z0-9_-]{1,40}$/.test(k);
    const tipos = (o, campos) => Object.fromEntries(Object.entries(o && typeof o === 'object' ? o : {}).filter(([k]) => idOk(k)).slice(0, 40).map(([k, v]) => [k, campos(v || {})]));
    return { inspActivas:Array.isArray(d.inspActivas) ? d.inspActivas.filter(k => idOk(String(k))).slice(0, 60) : undefined,
      insp:tipos(d.insp, v => ({ n:txt(v.n, 120), cada:Math.min(12, Math.max(1, Number(v.cada) || 3)), items:(Array.isArray(v.items) ? v.items : []).map(x => txt(x, 200)).slice(0, 40), inactivo:!!v.inactivo })),
      pt:tipos(d.pt, v => ({ n:txt(v.n, 120), norma:txt(v.norma, 200), curso:txt(v.curso, 60), checks:(Array.isArray(v.checks) ? v.checks : []).map(x => txt(x, 200)).slice(0, 40), inactivo:!!v.inactivo })),
      cal:(Array.isArray(d.cal) ? d.cal : []).filter(o => o && idOk(String(o.id))).slice(0, 60).map(o => ({ id:String(o.id), texto:txt(o.texto, 200), quien:txt(o.quien, 100), norma:txt(o.norma, 200), cada:[0,1,2,3,6].includes(Number(o.cada)) ? Number(o.cada) : 0, mes:Math.min(12, Math.max(1, Number(o.mes) || 12)), dia:Math.min(28, Math.max(1, Number(o.dia) || 28)) })),
      editado:d.editado };
  }
  if (CLIN.has(c) && !esClin(R) && R !== 'super') no(); // el súper solo escribe (empresa de ejemplo), nunca lee lo clínico
  if (c === 'quejas' && !['admin','psicologo','super'].includes(R)) no();
  if (c === 'sustancias' && d && d.fdsEnlace && !/^https:\/\//i.test(String(d.fdsEnlace))) d = { ...d, fdsEnlace:'' };
  if (['votos','urna','sociodemo','practicaRes','postulaciones'].includes(c) && !(c === 'postulaciones' && prev && !borrar && R === 'admin')) no(); // los escriben el trabajador o el servidor (voto secreto); el administrador solo acepta o rechaza postulaciones
  if (c === 'postulaciones') return { ...prev, estado:['aceptada','rechazada'].includes(d.estado) ? d.estado : prev.estado };
  if (c === 'elecciones' && !borrar){ // el estado "cerrada" y los resultados solo los pone el escrutinio del servidor
    const r = { ...d }; ['resultado','blanco','total','habilitados','escrutinio'].forEach(k => { if (prev && k in prev) r[k] = prev[k]; else delete r[k]; });
    if (r.estado === 'cerrada' && prev?.estado !== 'cerrada') r.estado = prev ? prev.estado : 'inscripcion';
    if (prev && ['votacion','cerrada'].includes(prev.estado)){ r.candidatos = prev.candidatos; r.info = prev.info; r.votacionDesde = prev.votacionDesde; } // con la votación abierta no se cambian los candidatos
    if (prev?.estado === 'cerrada') r.estado = 'cerrada';
    return r; }
  if (c === 'informes' && R !== 'super'){ // la firma solo la pone /api/firmar y un informe firmado no se cambia ni se borra
    if (prev?.firma) throw { status:403, code:'forbidden', message:'El informe ya está firmado y no se puede modificar.' };
    if (borrar) return null; const r = { ...d }; delete r.firma; return r;
  }
  return borrar ? null : d;
}
/* Pagos con Bold: la central de pagos de skynetgenesis.com los registra directamente en la base (función bold_pago_aprobado).
   El servidor vuelve a leer la empresa desde la base cuando hace falta, para no trabajar con una copia vieja. */
const REFRESCO = new Map();
async function refrescarEmpresas(cid, espera){
  if (!pool) return; const k = cid || '*'; const ahora = Date.now();
  if (espera && ahora - (REFRESCO.get(k) || 0) < espera) return;
  const antes = new Map(); DOCS.forEach((v, ruta) => { if (/^empresas\//.test(ruta)) antes.set(ruta, v.ts); });
  try {
    const r = cid ? await pool.query('select ruta, datos from docs where ruta = $1', ['empresas/' + cid]) : await pool.query("select ruta, datos from docs where coleccion = 'empresas'");
    // si mientras se leía la base alguien guardó la empresa, se respeta lo guardado (es más nuevo)
    r.rows.forEach(x => { if (DOCS.get(x.ruta)?.ts === antes.get(x.ruta) && !iguales(doc(x.ruta), x.datos)) DOCS.set(x.ruta, { data:x.datos, ts:tic() }); });
    REFRESCO.set(k, ahora);
  } catch(e){ console.error('No se pudo releer empresas', e.message); }
}
async function guardar(s, ruta, d){
  if (/^empresas\//.test(ruta)) await refrescarEmpresas(ruta.split('/')[1]);
  const r = revisarEscritura(s, ruta, d, false);
  const c = partes(ruta)[0].split('/')[2];
  if (c === 'bitacora'){ // se combinan las entradas para no perder las de otros usuarios
    const prev = doc(ruta)?.items || []; const vistos = new Set(prev.map(x => x.en + x.accion));
    const nuevos = (r.items || []).filter(x => !vistos.has(x.en + x.accion)).map(x => s.t === 'w' ? { ...x, rol:'Trabajador' } : x);
    return poner(ruta, { items:[...prev, ...nuevos].slice(-3000) });
  }
  if (r && r.__caso){ // caso abierto desde el portal: se une al caso abierto del mismo programa
    const { __caso, ...d2 } = r; const cid = s.cid;
    const ab = coleccion('e/' + cid + '/casos').find(k => k.trabajador === d2.trabajador && k.programa === d2.programa && k.estado !== 'Cerrado');
    if (ab){ const { id, ...k } = ab; return poner('e/' + cid + '/casos/' + id, { ...k, nivel:k.nivel === 'alto' ? 'alto' : d2.nivel, notas:[...(k.notas || []), ...(d2.notas || [])] }); }
    return poner(ruta, d2);
  }
  await poner(ruta, r);
  if (c === 'trabajadores' && s.t === 'u') await contarTrabajadores(empresaDe(ruta));
  if (partes(ruta)[0] === 'pagosAviso' && s.rol !== 'super') correo(CORREO_DUENO, 'Centinela-IA SST: pago por confirmar de ' + r.razon, `<p><b>${esc(r.razon)}</b> avisó un pago de <b>$${Number(r.valor || 0).toLocaleString('es-CO')}</b> (${esc(r.medio)}), referencia <b>${esc(r.referencia)}</b>.</p><p>Revíselo en el panel de la plataforma y pulse <b>Confirmar</b> o <b>Rechazar</b>.</p>`).catch(() => {});
}
function dvNit(nit){ const w = [3,7,13,17,19,23,29,37,41,43,47,53,59,67,71]; const d = String(nit).split('').reverse(); let s = 0; d.forEach((c, i) => s += Number(c) * w[i]); const r = s % 11; return r > 1 ? 11 - r : r; }
const correoA = (para, asunto, cuerpo) => correo(para, asunto, cuerpo).catch(() => false);
/* ---------- pagos con Bold (central de SkyNet Genesis, conexión tipo "url" sin secreto) ----------
   La central llama POST /api/bold/aplicar; el servidor NO confía en lo que llega: consulta bold-verificar.php
   y aplica solo la orden que la central confirma (app=centinela), una sola vez por pago. */
let colaP = Promise.resolve(); const enCola = fn => { const r = colaP.then(fn, fn); colaP = r.catch(() => {}); return r; }; // una cosa a la vez (pagos y registros)
const NEG = new Map(); // consultas recientes que la central no confirmó (no se repiten durante 1 minuto)
async function verificarBold(q){
  const k = JSON.stringify(q); if (Date.now() - (NEG.get(k) || 0) < 60e3) return { ok:false, error:'pago no confirmado' };
  let j;
  try {
    const url = BOLD_VERIFICAR + '?' + new URLSearchParams({ ...q, app:'centinela' }).toString();
    const r = await fetch(url, { headers:{ 'User-Agent':'SkyNetGenesis-Centinela/1.0', accept:'application/json' }, signal:AbortSignal.timeout(8000) });
    j = await r.json().catch(() => null);
  } catch(e){ return { ok:false, error:'sin conexión con la central de pagos' }; }
  if (!j || j.ok === false){ NEG.set(k, Date.now()); if (NEG.size > 2000) NEG.clear(); return { ok:false, error:'pago no confirmado' }; }
  const o = j.orden || j.order || j.data || j.pedido || j;
  console.log('Bold verificado:', JSON.stringify(o).slice(0, 400));
  return enCola(() => aplicarBold(o));
}
/* Market: compra de documentos (pago único, no mueve "Pagado hasta"). El valor debe cubrir la suma de lo pedido; lo ya comprado o lo desconocido queda "para revisar" */
async function aplicarMarket(reg, rp, cid, claves, forzar){
  const re = 'empresas/' + cid; await refrescarEmpresas(cid); const e0 = doc(re);
  const total = claves.reduce((a, k) => a + (hay(MKT, k) ? MKT[k].precio : 0), 0);
  const ya = e0 ? claves.filter(k => e0.modulos?.[k] || (e0.modulos?.['doc-todos'] && k !== 'doc-todos')) : [];
  const motivo = !e0 ? 'La empresa no existe' : claves.some(k => !hay(MKT, k)) ? 'Pedido con un documento desconocido' : forzar ? '' : reg.valor < total ? 'El valor no cubre el pedido (' + total + ')' : ya.length ? 'Ya tenía comprado: ' + ya.join(', ') : '';
  if (motivo){ await poner(rp, { ...reg, estado:'revisar', motivo }); correoA(CORREO_DUENO, 'Centinela-IA SST: compra del Market para revisar', `<p>Pago ${esc(reg.pago_id)} de $${reg.valor.toLocaleString('es-CO')} (${esc(reg.plan)}): ${esc(motivo)}. Revíselo en el panel.</p>`); return { ok:true, estado:'revisar' }; }
  const hoy = HOY(); const nombres = claves.map(k => k === 'doc-todos' ? 'Paquete de los 24 documentos' : MKT[k].docs[0]).join(', ');
  const aplicar = (e, maxRec) => { const recibo = 'RC-' + hoy.slice(0, 4) + '-' + String(maxRec + 1).padStart(4, '0');
    const pago = { fecha:hoy, meses:0, valor:reg.valor, ref:reg.ref || reg.pago_id, medio:'Bold', por:'Pago en línea con Bold', hasta:e.vence || '', recibo, pago_id:reg.pago_id, concepto:'Market: ' + nombres };
    const modulos = { ...(e.modulos || {}) }; claves.forEach(k => { modulos[k] = { fecha:hoy, pago_id:reg.pago_id, recibo }; });
    return { e2:{ ...e, modulos, pagos:[...(e.pagos || []), pago] }, pago }; };
  let out;
  if (pool){
    const c = await pool.connect();
    try {
      await c.query('begin'); await c.query('select pg_advisory_xact_lock(4242)');
      if (!forzar && (await c.query('select 1 from docs where ruta = $1', [rp])).rows.length){ await c.query('rollback'); return { ok:true, estado:'aplicado' }; }
      const e = (await c.query('select datos from docs where ruta = $1 for update', [re])).rows[0]?.datos || e0; const pre = 'RC-' + hoy.slice(0, 4) + '-';
      const mx = (await c.query(`select coalesce(max(substring(p->>'recibo' from $1)::int), 0) n from docs d, jsonb_array_elements(coalesce(d.datos->'pagos','[]'::jsonb)) p where d.coleccion = 'empresas' and p->>'recibo' like $2`, ['^' + pre + '([0-9]+)$', pre + '%'])).rows[0].n;
      out = aplicar(e, Number(mx));
      await c.query('update docs set datos = $2, actualizado = now() where ruta = $1', [re, out.e2]);
      await c.query(`insert into docs (ruta, coleccion, empresa, datos, actualizado) values ($1,'boldpagos',null,$2,now()) on conflict (ruta) do update set datos = excluded.datos, actualizado = now()`, [rp, { ...reg, meses:0, estado:'aplicado', recibo:out.pago.recibo, modulos:claves }]);
      await c.query('commit');
    } catch(x){ await c.query('rollback').catch(() => {}); throw x; } finally { c.release(); }
    DOCS.set(re, { data:out.e2, ts:tic() }); DOCS.set(rp, { data:{ ...reg, meses:0, estado:'aplicado', recibo:out.pago.recibo, modulos:claves }, ts:tic() });
  } else {
    const pre = 'RC-' + hoy.slice(0, 4) + '-'; let mx = 0; coleccion('empresas').forEach(e => (e.pagos || []).forEach(x => { if (String(x.recibo || '').startsWith(pre)) mx = Math.max(mx, parseInt(x.recibo.slice(pre.length), 10) || 0); }));
    out = aplicar(e0, mx); await poner(re, out.e2); await poner(rp, { ...reg, meses:0, estado:'aplicado', recibo:out.pago.recibo, modulos:claves });
  }
  correoA(e0.correo, 'Centinela-IA SST: documentos comprados', `<p>Recibimos el pago de <b>${esc(e0.razon)}</b> por $${reg.valor.toLocaleString('es-CO')} (Bold, recibo ${out.pago.recibo}). Ya puede cargar en Centinela-IA SST los documentos comprados (${esc(nombres)}) desde el Market: quedan con los datos de su empresa, listos para revisar y aprobar.</p>`);
  return { ok:true, estado:'aplicado', recibo:out.pago.recibo };
}
/* Documento del Market lleno con los datos de la empresa (solo si la empresa lo compró) */
const RIESGO_TXT = { 1:'I (mínimo)', 2:'II (bajo)', 3:'III (medio)', 4:'IV (alto)', 5:'V (máximo)' };
const MESES_L = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
function documentoMarket(cid, cod){
  const e = doc('empresas/' + cid) || {}; const pl = doc('plantillas/' + cod); if (!pl) return null;
  const hoy = HOY(); const n = coleccion('e/' + cid + '/trabajadores').filter(t => t.estado !== 'retirado').length;
  const cargos = coleccion('e/' + cid + '/cargos').map(c => c.nombre).filter(Boolean);
  const pel = [...new Set(coleccion('e/' + cid + '/peligros').map(p => (p.clasif || '') + ': ' + (p.descripcion || '')))].slice(0, 10);
  const falta = '(por completar)'; const v = x => String(x ?? '').trim() || falta;
  const D = { razon:v(e.razon), nit:e.nit ? e.nit + (e.dv !== undefined && e.dv !== '' ? '-' + e.dv : '') : falta, ciudad:v(e.ciudad), direccion:v(e.direccion), actividad:v(e.actividad), riesgo:RIESGO_TXT[e.riesgo] || v(e.riesgo), arl:v(e.arl), representante:v(e.representante), responsable:v(e.responsable),
    trabajadores:String(n || e.trabajadoresActivos || 0), anio:hoy.slice(0, 4), fecha:Number(hoy.slice(8, 10)) + ' de ' + MESES_L[Number(hoy.slice(5, 7)) - 1] + ' de ' + hoy.slice(0, 4), organo:n >= 10 ? 'COPASST' : 'Vigía de SST',
    cargos:cargos.length ? cargos.join(', ') : falta, peligros:pel.length ? pel.join('; ') : falta };
  return { codigo:cod, nombre:pl.nombre, tipo:pl.tipo, texto:String(pl.texto || '').replace(/\{\{(\w+)\}\}/g, (m, k) => hay(D, k) ? D[k] : m) };
}
/* Valor en pesos: acepta 89000, "89000", "89.000", "89,000" o "$ 89.000 COP" */
function numeroCOP(v){ if (typeof v === 'number') return v; let t = String(v).replace(/[^\d.,]/g, '');
  if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(t)) t = t.replace(/\./g, '').replace(',', '.'); else if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(t)) t = t.replace(/,/g, ''); else t = t.replace(',', '.');
  return Number(t); }
async function aplicarBold(o){
  const pid = String(o.pago_id || o.pago || o.transaccion || o.id || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 80);
  const plan = String(o.plan || ''), cid = String(o.empresa || '').replace(/[^A-Za-z0-9_-]/g, '');
  const meses = Math.min(12, Math.max(1, parseInt(o.meses, 10) || 1)), valor0 = numeroCOP(o.valor ?? o.monto ?? o.amount ?? 0), valor = Number.isFinite(valor0) ? valor0 : 0;
  const ref = String(o.referencia || o.orderId || o.order_id || o.ref || '').slice(0, 80);
  if (!pid || !/^centinela:/.test(plan)) return { ok:false, error:'orden de otra app o sin identificador' };
  const rp = 'boldpagos/' + pid; if (doc(rp)) return { ok:true, estado:doc(rp).estado };
  const reg = { pago_id:pid, ref, plan, empresa:cid, meses, valor, en:new Date().toISOString() };
  if (plan === 'centinela:prueba'){ await poner(rp, { ...reg, estado:'prueba' }); return { ok:true, estado:'prueba' }; }
  const mk = /^centinela:(doc-[a-z0-9]+|paq_[a-z0-9_-]+)$/.exec(plan);
  if (mk){ const claves = mk[1].startsWith('paq_') ? mk[1].slice(4).split('_').filter(Boolean) : [mk[1]]; if (claves.every(k => /^doc-/.test(k))) return aplicarMarket(reg, rp, cid, [...new Set(claves)]);
    await poner(rp, { ...reg, estado:'revisar', motivo:'Paquete que mezcla documentos con otros conceptos' }); return { ok:true, estado:'revisar' }; }
  const re = 'empresas/' + cid; await refrescarEmpresas(cid); const e0 = doc(re);
  if (!e0){ await poner(rp, { ...reg, estado:'revisar', motivo:'La empresa no existe' }); correoA(CORREO_DUENO, 'Centinela-IA SST: pago de Bold para revisar', `<p>Pago ${esc(pid)} de $${valor.toLocaleString('es-CO')} sin empresa (${esc(cid)}). Revíselo en el panel.</p>`); return { ok:true, estado:'revisar' }; }
  const precio = precioPlan(Number(e0.trabajadoresActivos || 0)); const m = Math.min(meses, precio ? Math.floor(valor / precio + 1e-9) : meses);
  if (!(m >= 1)){ await poner(rp, { ...reg, estado:'revisar', motivo:'El valor no cubre el plan que le corresponde (' + precio + ')' }); correoA(CORREO_DUENO, 'Centinela-IA SST: pago de Bold para revisar', `<p>${esc(e0.razon)} pagó $${valor.toLocaleString('es-CO')}, menos que su plan ($${precio.toLocaleString('es-CO')}). Revíselo en el panel.</p>`); return { ok:true, estado:'revisar' }; }
  const aplicar = (e, maxRec) => {
    const hasta = hastaTrasPago(e, m); const recibo = 'RC-' + HOY().slice(0, 4) + '-' + String(maxRec + 1).padStart(4, '0');
    const pago = { fecha:HOY(), meses:m, valor, ref:ref || pid, medio:'Bold', por:'Pago en línea con Bold', hasta, recibo, pago_id:pid };
    return { e2:{ ...e, vence:hasta, suspendida:false, pagos:[...(e.pagos || []), pago] }, pago };
  };
  let out;
  if (pool){
    const c = await pool.connect();
    try {
      await c.query('begin'); await c.query('select pg_advisory_xact_lock(4242)');
      if ((await c.query('select 1 from docs where ruta = $1', [rp])).rows.length){ await c.query('rollback'); return { ok:true, estado:'aplicado' }; }
      const e = (await c.query('select datos from docs where ruta = $1 for update', [re])).rows[0]?.datos || e0;
      const pre = 'RC-' + HOY().slice(0, 4) + '-';
      const mx = (await c.query(`select coalesce(max(substring(p->>'recibo' from $1)::int), 0) n from docs d, jsonb_array_elements(coalesce(d.datos->'pagos','[]'::jsonb)) p where d.coleccion = 'empresas' and p->>'recibo' like $2`, ['^' + pre + '([0-9]+)$', pre + '%'])).rows[0].n;
      out = aplicar(e, Number(mx));
      await c.query('update docs set datos = $2, actualizado = now() where ruta = $1', [re, out.e2]);
      await c.query(`insert into docs (ruta, coleccion, empresa, datos, actualizado) values ($1,'boldpagos',null,$2,now())`, [rp, { ...reg, meses:m, estado:'aplicado', recibo:out.pago.recibo, hasta:out.pago.hasta }]);
      await c.query('commit');
    } catch(x){ await c.query('rollback').catch(() => {}); throw x; } finally { c.release(); }
    DOCS.set(re, { data:out.e2, ts:tic() }); DOCS.set(rp, { data:{ ...reg, meses:m, estado:'aplicado', recibo:out.pago.recibo, hasta:out.pago.hasta }, ts:tic() });
  } else {
    const pre = 'RC-' + HOY().slice(0, 4) + '-'; let mx = 0; coleccion('empresas').forEach(e => (e.pagos || []).forEach(x => { if (String(x.recibo || '').startsWith(pre)) mx = Math.max(mx, parseInt(x.recibo.slice(pre.length), 10) || 0); }));
    out = aplicar(e0, mx); await poner(re, out.e2); await poner(rp, { ...reg, meses:m, estado:'aplicado', recibo:out.pago.recibo, hasta:out.pago.hasta });
  }
  correoA(e0.correo, 'Centinela-IA SST: pago recibido', `<p>Recibimos el pago de <b>${esc(e0.razon)}</b> por $${valor.toLocaleString('es-CO')} (Bold, recibo ${out.pago.recibo}). Su servicio queda al día hasta el <b>${out.pago.hasta}</b>. Gracias.</p>`);
  return { ok:true, estado:'aplicado', recibo:out.pago.recibo, hasta:out.pago.hasta };
}
async function registrar(b, laIp){
      const txt = (v, n) => String(v ?? '').replace(/[<>"']/g, '').trim().slice(0, n);
  const razon = txt(b.razon, 120), nit = String(b.nit || '').split('-')[0].replace(/\D/g, '').replace(/^0+/, ''), dv = String(b.dv || '').replace(/\D/g, ''), nombre = txt(b.nombre, 80), correo = txt(b.correo, 120).toLowerCase(), celular = txt(b.celular, 20).replace(/[^\d+ ]/g, ''), ciudad = txt(b.ciudad, 60), clave = String(b.clave || '');
  const riesgo = Math.min(5, Math.max(1, Number(b.riesgo) || 1)), trab = Math.min(100000, Math.max(0, Number(b.trabajadores) || 0));
  if (!razon || !nombre || !celular) return { status:400, body:{ code:'invalid_argument', message:'Complete la razón social, su nombre y su celular.' } };
  if (!/^\d{6,12}$/.test(nit) || String(dvNit(nit)) !== dv) return { status:400, body:{ code:'nit', message:'Revise el NIT y el dígito de verificación.' } };
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(correo)) return { status:400, body:{ code:'correo', message:'Escriba un correo válido.' } };
  if (!claveFuerte(clave)) return { status:400, body:{ code:'clave_debil', message:MSG_CLAVE } };
  fallo('reg:' + laIp);
  // la prueba gratis no se repite con el mismo NIT ni con el mismo correo
  const hc = 'c' + crypto.createHash('sha256').update(correo).digest('hex').slice(0, 24);
  if (coleccion('empresas').some(e => String(e.nit) === nit) || doc('pruebas/n' + nit)) return { status:409, body:{ code:'nit_existe', message:'Ya existe una cuenta para ese NIT. Si es suya, entre con su usuario o recupere la contraseña; si no, escríbanos por WhatsApp 304 437 5758.' } };
  if (coleccion('usuarios').some(x => x.usuario === correo || String(x.correo || '').toLowerCase() === correo) || doc('pruebas/' + hc)) return { status:409, body:{ code:'correo_existe', message:'Ese correo ya tiene una cuenta. Entre con él o recupere la contraseña.' } };
  const hoy = HOY(); const d0 = new Date(hoy + 'T12:00:00Z'); d0.setUTCDate(d0.getUTCDate() + DIAS_PRUEBA - 1); /* 15 días contando hoy */ const hasta = d0.toISOString().slice(0, 10);
  const cid = 'e' + crypto.randomBytes(7).toString('hex'), uid = 'u' + crypto.randomBytes(8).toString('hex'), sal = crypto.randomBytes(12).toString('hex'), en = new Date().toISOString();
  await poner('empresas/' + cid, { razon, nit, dv, actividad:'', riesgo, arl:'', ciudad, direccion:'', telefono:celular, correo, representante:'', responsable:nombre, trabajadoresActivos:0, trabajadoresDeclarados:trab, pagos:[], vence:hasta, prueba:{ desde:hoy, hasta }, plan:txt(b.plan, 20), origen:'registro', creado:{ por:'Registro en línea', en } });
  await poner('usuarios/' + uid, { usuario:correo, correo, nombre, rol:'admin', empresa:cid, licencia:'', sal, hash:hashClave(clave, sal), activo:true, creado:en });
  await poner('pruebas/n' + nit, { empresa:cid, en }); await poner('pruebas/' + hc, { empresa:cid, en });
  const tv = firmar({ t:'v', uid }, 7 * 24 * 3600e3);
  correoA(correo, 'Bienvenido a Centinela-IA SST: 15 días gratis', `<p>Hola, ${esc(nombre)}.</p><p><a href="${URL_API}/api/confirmar?t=${tv}">Confirme aquí su correo</a> para recibir los avisos de su cuenta.</p><p>La cuenta de <b>${esc(razon)}</b> está lista. Su prueba gratis va hasta el <b>${hasta}</b>. Entre con su correo y la contraseña que eligió.</p><p>Primeros pasos: registre los cargos y los trabajadores, revise el calendario legal y cargue los documentos del SG-SST. Para seguir después de la prueba, pague la mensualidad en línea desde la app.</p><p><a href="${URL_APP}" style="background:#14A38B;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none">Abrir Centinela-IA SST</a></p>`);
  correoA(CORREO_DUENO, 'Centinela-IA SST: nueva empresa en prueba', `<p><b>${esc(razon)}</b> (NIT ${nit}-${dv}, ${esc(ciudad)}) creó su cuenta. Contacto: ${esc(nombre)} · ${esc(correo)} · ${esc(celular)}. Trabajadores declarados: ${trab}. Prueba hasta ${hasta}.</p>`);
  return { status:200, body:{ ok:true, token:firmar({ t:'u', uid }), uid, cid, hasta } };
}
/* El número de trabajadores activos (define el tramo de precio) lo calcula el servidor */
async function contarTrabajadores(cid){
  const e = doc('empresas/' + cid); if (!e) return;
  const n = coleccion('e/' + cid + '/trabajadores').filter(t => t.estado !== 'retirado').length;
  if (e.trabajadoresActivos === n) return;
  if (!pool) return poner('empresas/' + cid, { ...e, trabajadoresActivos:n });
  // solo se cambia ese dato en la base: no pisa un pago de Bold que haya llegado mientras tanto
  const r = await pool.query(`update docs set datos = jsonb_set(datos, '{trabajadoresActivos}', to_jsonb($2::int)), actualizado = now() where ruta = $1 returning datos`, ['empresas/' + cid, n]);
  if (r.rows[0]) DOCS.set('empresas/' + cid, { data:r.rows[0].datos, ts:tic() });
}
const esc = t => String(t ?? '').replace(/[&<>"]/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;' }[c]));
const PIE = '<p style="font-size:12px;color:#5D6B78">Centinela-IA SST · Una aplicación de SkyNet Genesis · contacto@skynetgenesis.com · WhatsApp 304 437 5758</p>';
async function correo(para, asunto, cuerpo){
  if (!BREVO_KEY || !CORREO_REMITENTE || !para) return false;
  const html = `<div style="font-family:Arial,sans-serif;color:#1C2B39;max-width:620px"><div style="background:#0B4F8A;color:#fff;padding:14px 18px;border-radius:8px 8px 0 0"><b style="font-size:18px">Centinela-IA SST</b></div><div style="border:1px solid #DCE5EE;border-top:0;padding:16px 18px;border-radius:0 0 8px 8px">${cuerpo}${PIE}</div></div>`;
  const r = await fetch('https://api.brevo.com/v3/smtp/email', { method:'POST', headers:{ 'api-key':BREVO_KEY, 'Content-Type':'application/json', accept:'application/json' }, body:JSON.stringify({ sender:{ name:'Centinela-IA SST', email:CORREO_REMITENTE }, to:[{ email:para }], subject:asunto, htmlContent:html }) });
  return r.ok;
}

/* solo cambia la fecha del último ingreso: no pisa un cambio de contraseña o un bloqueo que llegue al mismo tiempo */
async function marcarIngreso(uid){
  const ruta = 'usuarios/' + uid; const ahora = new Date().toISOString();
  if (pool){ const r = await pool.query(`update docs set datos = jsonb_set(datos, '{ultimo}', to_jsonb($2::text)) where ruta = $1 returning datos`, [ruta, ahora]); if (r.rows[0]) DOCS.set(ruta, { data:r.rows[0].datos, ts:tic() }); return; }
  const cur = doc(ruta); if (cur) await poner(ruta, { ...cur, ultimo:ahora });
}
/* Los enlaces de contraseña de las cuentas del dueño (Superadministrador y las de sus empresas) van directo a su Gmail (directiva 29 oct 2026) */
const esDelDueno = us => us && (us.rol === 'super' || DUENO_CUENTAS.has(String(us.usuario || '').toLowerCase()) || DUENO_CUENTAS.has(String(us.correo || '').toLowerCase()));
const destinoClave = us => esDelDueno(us) ? DUENO_CORREO : (us && us.correo) || '';
async function enviarEnlaceClave(us, para){
  const t = firmar({ t:'r', uid:us.id, h:huellaClave(us) }, 60 * 60e3); const e = us.empresa ? doc('empresas/' + us.empresa) : null;
  const cuenta = para === DUENO_CORREO ? `<p style="background:#E8F1FA;padding:8px 10px;border-radius:6px">Cuenta: <b>${esc(us.usuario)}</b> · ${esc(us.rol === 'super' ? 'Superadministrador de Centinela-IA SST' : (e?.razon || ''))}</p>` : '';
  return correo(para, 'Centinela-IA SST: cree o cambie su contraseña', `<p>Hola, ${esc(us.nombre)}.</p>${cuenta}<p>Use este enlace para crear o cambiar la contraseña del usuario <b>${esc(us.usuario)}</b>. Sirve durante 1 hora y una sola vez.</p><p><a href="${URL_APP}/#recuperar=${t}" style="background:#0B4F8A;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none">Crear o cambiar mi contraseña</a></p><p>Si usted no la pidió, ignore este correo; su contraseña sigue igual.</p>`).catch(() => false);
}

/* ---------- utilidades http ---------- */
function cors(req, res){
  const o = req.headers.origin; const ok = ORIGENES.includes('*') ? '*' : (o && ORIGENES.includes(o) ? o : ORIGENES[0]);
  res.setHeader('Access-Control-Allow-Origin', ok); res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization'); res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
}
const enviar = (res, status, obj) => { res.writeHead(status, { 'Content-Type':'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };
const leerCuerpo = (req, max) => new Promise((ok, no) => { let b = ''; req.on('data', c => { b += c; if (b.length > (max || 8e6)){ no({ status:413, code:'too_large', message:'Archivo demasiado grande.' }); req.destroy(); } }); req.on('end', () => { try { ok(b ? JSON.parse(b) : {}); } catch(e){ no({ status:400, code:'invalid_argument', message:'Datos no válidos.' }); } }); });
const ip = req => { const x = String(req.headers['x-forwarded-for'] || '').split(',').map(t => t.trim()).filter(Boolean); return x.length ? x[x.length - 1] : (req.socket.remoteAddress || ''); }; // la última la pone el proxy de Render; las primeras las puede inventar el cliente

/* ---------- correo diario (Brevo) ---------- */
const HOY = () => new Intl.DateTimeFormat('en-CA', { timeZone:'America/Bogota' }).format(new Date());
const finMes = iso => { const d = new Date(iso + 'T12:00:00Z'); d.setUTCMonth(d.getUTCMonth() + 1, 0); return d.toISOString().slice(0, 10); };
const dias = (iso, hoy) => Math.round((new Date(iso + 'T12:00:00') - new Date(hoy + 'T12:00:00')) / 864e5);
/* Regla de cobro de SkyNet Genesis (oct 2026): "Pagado hasta" fin de mes; si no se paga, el acceso se cierra el día 5
   del mes siguiente (sin cuenta regresiva). Prueba gratis de 15 días: se cierra al terminar si no se paga. Lo aplica el servidor. */
const pagadoHasta = e => e.vence || finMes(String(e.creado?.en || e.creado || HOY()).slice(0, 10));
const tienePagos = e => (e.pagos || []).some(x => Number(x.valor || 0) > 0 && !x.concepto); // las compras del Market (con concepto) no son mensualidad
const enPrueba = e => !!(e && !e.interna && e.prueba?.hasta && !e.prueba.cerrada && !tienePagos(e)); // una cortesía o un "Pagado hasta" del Superadministrador cierra la prueba
const cerrada = e => !e || !!e.suspendida || (e.interna ? false : enPrueba(e) ? dias(e.prueba.hasta, HOY()) < 0 : dias(pagadoHasta(e), HOY()) <= -5);
function precioPlan(n){ const tr = doc('plataforma/config')?.tramos; const lista = Array.isArray(tr) && tr.some(t => Number(t.precio) > 0) ? tr : TRAMOS_DEF; const t = lista.find(x => x.hasta == null || n <= Number(x.hasta)) || lista[lista.length - 1]; return Number(t.precio) || 0; }
/* "Pagado hasta" después de pagar m meses (regla general de SkyNet Genesis, oct 2026):
   - PRIMER pago: "resto del mes gratis": cubre lo que queda del mes del primer día pagado más el mes siguiente; si ese día
     cae entre el 1 y el 5, cubre solo ese mes. Si paga durante la prueba, el primer día pagado es el siguiente al fin de la prueba.
   - Vuelve tras un cierre: paga desde el mes en curso, sin acumular los meses que estuvo cerrada.
   - Al día o con pago pendiente (días 1 a 4): suma los meses a su "Pagado hasta". */
const diaSig = iso => { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); };
function hastaTrasPago(e, m){
  const hoy = HOY();
  if (!tienePagos(e)){ const F = enPrueba(e) && dias(e.prueba.hasta, hoy) >= 0 ? diaSig(e.prueba.hasta) : hoy; const h0 = Number(F.slice(8, 10)) <= 5 ? finMes(F) : avanzarMeses(finMes(F), 1); return avanzarMeses(h0, m - 1); }
  if (cerrada({ ...e, suspendida:false })) return avanzarMeses(finMes(hoy), m - 1);
  return avanzarMeses(pagadoHasta(e), m);
}
const empresaCerrada = cid => cerrada(doc('empresas/' + cid));
function pendientesEmpresa(cid, hoy){
  const L = c => coleccion('e/' + cid + '/' + c).filter(x => !x.anulado); const out = [];
  const add = (f, t) => { if (f && dias(f, hoy) <= 7) out.push([f, t]); };
  L('tareas').filter(t => t.estado !== 'cumplida').forEach(t => add(t.vence, 'Tarea: ' + t.texto + (t.responsable ? ' (' + t.responsable + ')' : '')));
  L('acpm').filter(a => a.estado !== 'cerrada').forEach(a => add(a.vence, 'Acción ' + (a.codigo || '') + ': ' + a.accion));
  L('vehiculos').forEach(v => { add(v.soat, 'SOAT del vehículo ' + v.placa); if (!v.rtmNoAplica) add(v.rtm, 'Revisión técnico-mecánica del vehículo ' + v.placa); });
  L('conductores').forEach(c => add(c.vence, 'Licencia de conducción de un conductor'));
  L('contratistas').filter(c => !c.fin || c.fin >= hoy).forEach(c => add(c.docs?.arl?.vence, 'ARL del contratista ' + c.nombre));
  L('documentos').filter(d => d.estado === 'aprobado').forEach(d => add(d.revision, 'Revisión del documento ' + d.codigo));
  L('accidentes').filter(a => a.tipo !== 'Incidente' && !a.reporteARL).forEach(a => out.push([a.fecha, 'Accidente sin reporte a la ARL (FURAT)']));
  L('mediciones').forEach(m => add(m.repetir, 'Repetir la medición de ' + String(m.tipo || '').toLowerCase() + ' en ' + (m.area || '')));
  return out.sort((a, b) => a[0].localeCompare(b[0]));
}
async function correoDiario(){
  await refrescarEmpresas(null); const hoy = HOY(); const res = [];
  for (const e of coleccion('empresas')){
    if (enPrueba(e) && !e.suspendida){ // correo diario de la prueba gratis al administrador, con los días que le quedan
      const n = dias(e.prueba.hasta, hoy); const ads = coleccion('usuarios').filter(x => x.empresa === e.id && x.rol === 'admin' && x.activo !== false && x.correo && x.correoOk);
      if (n >= 0) for (const a of ads) correoA(a.correo, n === 0 ? 'Centinela-IA SST: hoy termina su prueba gratis' : `Centinela-IA SST: le quedan ${n} días de prueba gratis`, `<p>Hola, ${esc(a.nombre)}.</p><p>${n === 0 ? 'Hoy es el último día' : `Le quedan <b>${n} días</b>`} de la prueba gratis de <b>${esc(e.razon)}</b>. Para seguir usando Centinela-IA SST sin interrupciones, pague la mensualidad en línea desde la app (tarjeta débito o crédito, PSE, Nequi, llave Bre-B).</p><p><a href="${URL_APP}" style="background:#14A38B;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none">Abrir Centinela-IA SST</a></p>`);
    }
    if (cerrada(e)){ res.push({ empresa:e.razon, pendientes:0, enviado:false, cerrada:true }); continue; }
    /* (31 oct 2026) aviso a cada responsable: sus tareas vencidas o que vencen en 3 días */
    for (const us of coleccion('usuarios').filter(x => x.empresa === e.id && x.activo !== false && x.correo && x.correoOk && x.avisos !== false)){
      const mias = coleccion('e/' + e.id + '/tareas').filter(t => !t.anulado && t.estado !== 'cumplida' && t.responsableU === us.id && t.vence && dias(t.vence, hoy) <= 3);
      if (!mias.length || frenar('av:' + us.id + ':' + hoy, 1, 1440)) continue; fallo('av:' + us.id + ':' + hoy);
      correo(us.correo, `Centinela-IA SST: tiene ${mias.length} ${mias.length === 1 ? 'tarea pendiente' : 'tareas pendientes'}`, `<p>Hola, ${esc(us.nombre)}.</p><p>Estas tareas de <b>${esc(e.razon)}</b> están a su cargo:</p><ul>${mias.slice(0, 30).map(t => `<li style="margin:4px 0"><b style="color:${dias(t.vence, hoy) < 0 ? '#B93A27' : '#946A00'}">${t.vence}</b> · ${esc(t.texto)}</li>`).join('')}</ul><p><a href="${URL_APP}" style="background:#0B4F8A;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none">Abrir Centinela-IA SST</a></p><p style="font-size:12px;color:#5D6B78">Puede apagar estos avisos en Mi cuenta.</p>`).catch(() => {});
    }
    if (!e.resumenDiario){ res.push({ empresa:e.razon, enviado:false, opcional:true }); continue; } // el resumen por correo es opcional (los avisos están en la campana de la app)
    const p = pendientesEmpresa(e.id, hoy); if (!p.length || !e.correo) { res.push({ empresa:e.razon, pendientes:p.length, enviado:false }); continue; }
    const venc = p.filter(x => dias(x[0], hoy) < 0).length;
    const html = `<div style="font-family:Arial,sans-serif;color:#1C2B39;max-width:620px"><div style="background:#0B4F8A;color:#fff;padding:14px 18px;border-radius:8px 8px 0 0"><b style="font-size:18px">Centinela-IA SST</b><br><span style="font-size:13px">${e.razon}</span></div>
      <div style="border:1px solid #DCE5EE;border-top:0;padding:16px 18px;border-radius:0 0 8px 8px"><p>Tiene <b>${venc}</b> pendientes vencidos y <b>${p.length - venc}</b> que vencen en los próximos 7 días:</p><ul>${p.slice(0, 40).map(([f, t]) => `<li style="margin:4px 0"><b style="color:${dias(f, hoy) < 0 ? '#B93A27' : '#946A00'}">${f}</b> · ${t.replace(/</g, '&lt;')}</li>`).join('')}</ul>
      <p><a href="${URL_APP}" style="background:#0B4F8A;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none">Abrir Centinela-IA SST</a></p><p style="font-size:12px;color:#5D6B78">Centinela-IA SST · Una aplicación de SkyNet Genesis · contacto@skynetgenesis.com · WhatsApp 304 437 5758</p></div></div>`;
    let enviado = false;
    if (BREVO_KEY && CORREO_REMITENTE){
      try { const r = await fetch('https://api.brevo.com/v3/smtp/email', { method:'POST', headers:{ 'api-key':BREVO_KEY, 'Content-Type':'application/json', accept:'application/json' }, body:JSON.stringify({ sender:{ name:'Centinela-IA SST', email:CORREO_REMITENTE }, to:[{ email:e.correo, name:e.razon }], subject:`Centinela-IA SST: ${venc} vencidos y ${p.length - venc} por vencer`, htmlContent:html }) }); enviado = r.ok; } catch(err){ enviado = false; }
    }
    res.push({ empresa:e.razon, pendientes:p.length, enviado });
  }
  return res;
}

/* ---------- rutas ---------- */
const server = http.createServer(async (req, res) => {
  cors(req, res); if (req.method === 'OPTIONS'){ res.writeHead(204); return res.end(); }
  const u = new URL(req.url, 'http://x'); const p = u.pathname;
  try {
    if (p === '/' || p === '/api/ping') return enviar(res, 200, { ok:true, app:'Centinela-IA SST', hora:new Date().toISOString() });
    if (p === '/api/estado') return enviar(res, 200, { hayUsuarios:coleccion('usuarios').length > 0, epoch:EPOCH, smmlv:SMMLV, cupoMB:CUPO_MB });
    if (p === '/api/setup' && req.method === 'POST'){
      if (coleccion('usuarios').length) return enviar(res, 409, { code:'ya_configurado', message:'La plataforma ya tiene administrador.' });
      const b = await leerCuerpo(req); if (!b.usuario || !b.sal || !b.hash || !b.nombre) return enviar(res, 400, { code:'invalid_argument' });
      const uid = 'u' + crypto.randomBytes(8).toString('hex');
      await poner('usuarios/' + uid, { usuario:String(b.usuario).toLowerCase(), correo:String(b.correo || '').toLowerCase().slice(0, 120), nombre:b.nombre, rol:'super', empresa:null, sal:b.sal, hash:b.hash, activo:true, creado:new Date().toISOString() });
      return enviar(res, 200, { token:firmar({ t:'u', uid }), uid });
    }
    if (p === '/api/login' && req.method === 'POST'){
      const b = await leerCuerpo(req); const us = String(b.usuario || '').trim().toLowerCase();
      const porCorreo = coleccion('usuarios').filter(x => String(x.correo || '').toLowerCase() === us);
      const u2 = coleccion('usuarios').find(x => x.usuario === us) || (porCorreo.length === 1 ? porCorreo[0] : null); // se entra con el usuario o con el correo
      const k = 'l:' + (u2 ? u2.id : us) + ':' + ip(req), kg = 'lg:' + (u2 ? u2.id : us);
      // 5 intentos fallidos desde una conexión bloquean 15 minutos (por correo + IP, para que nadie bloquee a otro); tope general 40
      if (frenar(k, 5, 15) || frenar(kg, 40, 15) || frenar('lip:' + ip(req), 30, 15)) return enviar(res, 429, { code:'rate_limited', message:'Demasiados intentos. Espere 15 minutos.' });
      fallo(k); fallo(kg); fallo('lip:' + ip(req)); // se anota antes de verificar: intentos simultáneos también cuentan
      if (!u2 || hashClave(b.clave || '', u2.sal) !== u2.hash) return enviar(res, 401, { code:'credenciales', message:'Usuario o contraseña incorrectos.' });
      INTENTOS.delete(k); INTENTOS.delete(kg);
      if (u2.activo === false) return enviar(res, 403, { code:'inactivo', message:u2.bloqueo ? 'Este usuario está bloqueado por la plataforma. Escríbanos por WhatsApp 304 437 5758.' : 'Este usuario está desactivado. Hable con el administrador de su empresa.' });
      if (!u2.ultimo || Date.now() - Date.parse(u2.ultimo) > 3600e3) marcarIngreso(u2.id).catch(() => {}); // último ingreso («Cuentas y accesos»)
      return enviar(res, 200, { token:firmar({ t:'u', uid:u2.id }), uid:u2.id });
    }
    if (p === '/api/portal/login' && req.method === 'POST'){
      const b = await leerCuerpo(req); const nit = String(b.nit || '').replace(/\D/g, ''), dc = String(b.doc || '').replace(/\s/g, ''), cod = String(b.cod || '').trim(); const k = 'w:' + nit + ':' + dc;
      if (frenar(k, 5, 60) || frenar('wip:' + ip(req), 30, 60)) return enviar(res, 429, { code:'rate_limited', message:'Demasiados intentos. Espere una hora o pida ayuda al área de SST.' });
      const e = coleccion('empresas').find(x => String(x.nit) === nit);
      if (!e){ fallo(k); fallo('wip:' + ip(req)); return enviar(res, 404, { code:'empresa', message:'No encontramos una empresa con ese NIT.' }); }
      if (cerrada(e)) return enviar(res, 403, { code:'bloqueada', message:'El servicio de su empresa no está activo en este momento.' });
      const t = coleccion('e/' + e.id + '/trabajadores').find(x => String(x.documento) === dc && String(x.codigo) === cod && x.estado !== 'retirado');
      if (!t){ fallo(k); fallo('wip:' + ip(req)); return enviar(res, 401, { code:'credenciales', message:'El documento o el código no coinciden. Pida su código al área de SST.' }); }
      return enviar(res, 200, { token:firmar({ t:'w', cid:e.id, tid:t.id }), cid:e.id, tid:t.id });
    }
    if (p === '/api/cron/diario'){
      if (!CLAVE_CRON || String(u.searchParams.get('clave') || '').replace(/ /g, '+') !== CLAVE_CRON) return enviar(res, 403, { code:'forbidden' }); // un "+" de la clave llega como espacio si no se codifica
      return enviar(res, 200, { ok:true, resultado:await correoDiario() });
    }
    if (p === '/api/registro' && req.method === 'POST'){ // cuenta nueva desde la página o la demostración: 15 días gratis, sin tarjeta
      const b = await leerCuerpo(req);
      if (frenar('reg:' + ip(req), 5, 24 * 60)) return enviar(res, 429, { code:'rate_limited', message:'Demasiados registros desde esta conexión. Escríbanos por WhatsApp 304 437 5758.' });
      const out = await enCola(() => registrar(b, ip(req)));
      return enviar(res, out.status || 200, out.body);
    }
    if (p === '/api/confirmar' && req.method === 'GET'){ // confirmación del correo (enlace del correo de bienvenida)
      const t = leerToken(u.searchParams.get('t')); const us = t && t.t === 'v' && doc('usuarios/' + t.uid);
      if (us && !us.correoOk) await poner('usuarios/' + t.uid, { ...us, correoOk:true });
      res.writeHead(302, { Location:URL_APP + (us ? '/#correo-confirmado' : '/#correo-vencido') }); return res.end();
    }
    if (p === '/api/bold/aplicar' && req.method === 'POST'){ // la central de pagos avisa un pago de Bold; se confirma con la central antes de aplicarlo
      if (frenar('ba:' + ip(req), 120, 10)) return enviar(res, 429, { ok:false, error:'espere' }); fallo('ba:' + ip(req));
      const b = await leerCuerpo(req).catch(() => ({})); const o = b.orden || b.order || b.data || b;
      const pid = String(o.pago_id || o.pago || o.id || o.transaccion || '').slice(0, 80), ref = String(o.referencia || o.orderId || o.order_id || o.ref || '').slice(0, 80);
      if (!pid && !ref) return enviar(res, 400, { ok:false, error:'falta el pago' });
      const r = await verificarBold(pid ? { pago:pid } : { ref });
      if (!r.ok) return enviar(res, 400, { ok:false, error:r.error });
      return enviar(res, 200, { ok:true });
    }
    if (p === '/api/bold/volver' && req.method === 'GET'){ // respaldo al volver de Bold, por si el aviso de la central aún no llega
      const ref = String(u.searchParams.get('ref') || '').slice(0, 80); if (!ref) return enviar(res, 400, { ok:false });
      if (frenar('bv:' + ip(req), 30, 10)) return enviar(res, 429, { ok:false, error:'espere' }); fallo('bv:' + ip(req));
      const r = await verificarBold({ ref }); return enviar(res, r.ok ? 200 : 202, { ok:r.ok, estado:r.estado || r.error || 'pendiente' });
    }
    if (p === '/api/recuperar' && req.method === 'POST'){ // recuperación de contraseña por correo (Brevo)
      const b = await leerCuerpo(req); const q = String(b.usuario || '').trim().toLowerCase();
      if (frenar('r:' + ip(req), 6, 60)) return enviar(res, 429, { code:'rate_limited', message:'Demasiados intentos. Espere una hora.' });
      fallo('r:' + ip(req));
      if (!BREVO_KEY || !CORREO_REMITENTE) return enviar(res, 200, { ok:true, sinCorreo:true });
      const us = q && coleccion('usuarios').find(x => x.activo !== false && (x.usuario === q || String(x.correo || '').toLowerCase() === q));
      if (us && destinoClave(us) && !frenar('ru:' + us.id, 3, 60)){
        fallo('ru:' + us.id); enviarEnlaceClave(us, destinoClave(us)).catch(() => {});
      }
      return enviar(res, 200, { ok:true });
    }
    if (p === '/api/restablecer' && req.method === 'POST'){
      const b = await leerCuerpo(req); const t = leerToken(b.token); const us = t && t.t === 'r' && doc('usuarios/' + t.uid);
      if (!us || huellaClave(us) !== t.h) return enviar(res, 400, { code:'enlace', message:'El enlace venció o ya se usó. Pida uno nuevo.' });
      const n = String(b.nueva || ''); if (!claveFuerte(n)) return enviar(res, 400, { code:'clave_debil', message:MSG_CLAVE });
      const sal = crypto.randomBytes(12).toString('hex'); await poner('usuarios/' + t.uid, { ...us, sal, hash:hashClave(n, sal), cambiarClave:false });
      return enviar(res, 200, { ok:true, usuario:us.usuario });
    }
    /* ---------- (31 oct 2026) rutas públicas con enlace firmado: portal del contratista, registro de visitantes y conexión con la IPS ---------- */
    if (p === '/api/contratista/info' && req.method === 'GET'){
      const k = leerToken(u.searchParams.get('t')); const c = k && k.t === 'k' && doc('e/' + k.cid + '/contratistas/' + k.kid); const e = k && doc('empresas/' + k.cid);
      if (!c || !e || Number(c.enlaceV || 0) !== Number(k.v || 0) || c.anulado || cerrada(e)) return enviar(res, 404, { code:'enlace', message:'El enlace no es válido o ya no está activo. Pídale uno nuevo a la empresa.' });
      const docs = Object.fromEntries(Object.entries(c.docs || {}).map(([d, x]) => [d, { vence:x.vence || '', mes:x.mes || '', fecha:x.fecha || '', aplica:!!x.aplica, subido:x.subido ? { fecha:x.subido.fecha, nombre:x.subido.nombre, vence:x.subido.vence || '' } : null }]));
      return enviar(res, 200, { empresa:e.razon, logo:e.logo || '', contratista:c.nombre, servicio:c.servicio || '', docs });
    }
    if (p === '/api/contratista/subir' && req.method === 'POST'){
      if (frenar('ks:' + ip(req), 30, 60)) return enviar(res, 429, { code:'rate_limited', message:'Demasiados envíos. Espere una hora.' }); fallo('ks:' + ip(req));
      const b = await leerCuerpo(req); const k = leerToken(b.t); const ruta = k && k.t === 'k' ? 'e/' + k.cid + '/contratistas/' + k.kid : '';
      const tipoDoc = String(b.doc || ''); const VALIDOS = ['arl','pila','sgsst','alturas','poliza','examenes','otro'];
      const out = await enCola(async () => {
        const c = ruta && doc(ruta); const e = k && doc('empresas/' + k.cid);
        if (!c || !e || Number(c.enlaceV || 0) !== Number(k.v || 0) || c.anulado || cerrada(e)) return { status:404, body:{ code:'enlace', message:'El enlace no es válido o ya no está activo.' } };
        if (!VALIDOS.includes(tipoDoc)) return { status:400, body:{ code:'invalid_argument', message:'Tipo de documento no válido.' } };
        if (frenar('kc:' + k.cid + ':' + k.kid, 25, 24 * 60)) return { status:429, body:{ code:'rate_limited', message:'Llegó al límite de documentos por hoy. Intente mañana o comuníquese con la empresa.' } }; fallo('kc:' + k.cid + ':' + k.kid);
        const a = await guardarArchivo(k.cid, String(b.tipo || ''), b.datos);
        const vence = /^\d{4}-\d{2}-\d{2}$/.test(String(b.vence || '')) ? b.vence : '';
        const subido = { archivo:a.id, nombre:String(b.nombre || 'documento').replace(/[<>]/g, '').slice(0, 120), tipo:String(b.tipo), bytes:a.bytes, fecha:HOY(), en:new Date().toISOString(), vence, porContratista:true };
        const d0 = c.docs?.[tipoDoc] || {};
        await poner(ruta, { ...c, docs:{ ...(c.docs || {}), [tipoDoc]:{ ...d0, subido } }, porRevisar:true });
        await poner('e/' + k.cid + '/evidencias/' + a.id, { col:'contratistas', ref:k.kid, nombre:subido.nombre, tipo:subido.tipo, bytes:a.bytes, fecha:HOY(), por:'Contratista: ' + c.nombre, etiqueta:tipoDoc, archivo:a.id, std:'2.10.1' });
        return { status:200, body:{ ok:true } };
      });
      return enviar(res, out.status, out.body);
    }
    if (p === '/api/visita/info' && req.method === 'GET'){
      const k = leerToken(u.searchParams.get('t')); const e = k && k.t === 'q' && doc('empresas/' + k.cid);
      if (!e || Number(e.visitasV || 0) !== Number(k.v || 0) || cerrada(e)) return enviar(res, 404, { code:'enlace', message:'Este código ya no está activo. Pregunte en la portería.' });
      return enviar(res, 200, { empresa:e.razon, logo:e.logo || '', induccion:String(e.induccionVisita || '').slice(0, 3000), emergencia:e.telefono || '' });
    }
    if (p === '/api/visita' && req.method === 'POST'){
      if (frenar('vi:' + ip(req), 20, 60)) return enviar(res, 429, { code:'rate_limited', message:'Demasiados registros desde esta conexión.' }); fallo('vi:' + ip(req));
      const b = await leerCuerpo(req); const k = leerToken(b.t); const e = k && k.t === 'q' && doc('empresas/' + k.cid);
      if (!e || Number(e.visitasV || 0) !== Number(k.v || 0) || cerrada(e)) return enviar(res, 404, { code:'enlace', message:'Este código ya no está activo.' });
      const t = (x, n) => String(x ?? '').replace(/[<>]/g, '').trim().slice(0, n);
      const v = { nombre:t(b.nombre, 100), documento:t(b.documento, 20).replace(/[^\dA-Za-z]/g, ''), empresaV:t(b.empresaV, 100), motivo:t(b.motivo, 200), visita:t(b.visita, 100), celular:t(b.celular, 20).replace(/[^\d+]/g, ''), eps:t(b.eps, 60), arl:t(b.arl, 60), contactoEmerg:t(b.contactoEmerg, 120), induccion:b.induccion === true, fecha:HOY(), entrada:new Date().toISOString(), medio:'QR' };
      if (v.nombre.length < 3 || v.documento.length < 4 || !v.induccion) return enviar(res, 400, { code:'invalid_argument', message:'Escriba su nombre y documento, y confirme que leyó la inducción.' });
      const id = 'v' + crypto.randomBytes(6).toString('hex'); await poner('e/' + k.cid + '/visitantes/' + id, v); return enviar(res, 200, { ok:true, id });
    }
    if (p === '/api/ips/concepto' && req.method === 'POST'){ // Clínica-IA (u otra IPS) envía el concepto de aptitud: llave de la empresa, sin datos clínicos
      if (frenar('ip:' + ip(req), 300, 60)) return enviar(res, 429, { code:'rate_limited' }); fallo('ip:' + ip(req));
      const b = await leerCuerpo(req); const llave = String(req.headers['x-llave'] || b.llave || ''); const nit = String(b.nit || '').replace(/\D/g, '');
      const e = coleccion('empresas').find(x => String(x.nit) === nit);
      const h = crypto.createHash('sha256').update(llave).digest('hex');
      if (!e || !e.ipsLlave?.hash || llave.length < 20 || !crypto.timingSafeEqual(Buffer.from(h), Buffer.from(e.ipsLlave.hash))) return enviar(res, 401, { code:'llave', message:'NIT o llave no válidos.' });
      const CONC = ['Apto','Apto con recomendaciones','Apto con restricciones','Aplazado','No apto'];
      if (cerrada(e)) return enviar(res, 403, { code:'cerrada', message:'La empresa no tiene el servicio activo.' });
      const docT = String(b.documento || '').replace(/[\s.]/g, '').toUpperCase(); const t = coleccion('e/' + e.id + '/trabajadores').find(x => x.estado !== 'retirado' && String(x.documento).replace(/[\s.]/g, '').toUpperCase() === docT);
      if (!t) return enviar(res, 404, { code:'trabajador', message:'No hay un trabajador con ese documento en la empresa.' });
      if (!CONC.includes(b.concepto) || !/^\d{4}-\d{2}-\d{2}$/.test(String(b.fecha || ''))) return enviar(res, 400, { code:'invalid_argument', message:'Concepto o fecha no válidos. Conceptos: ' + CONC.join(', ') });
      const tx = (x, n) => String(x ?? '').replace(/[<>]/g, '').slice(0, n);
      const ref = tx(b.referencia, 60).replace(/[^A-Za-z0-9_-]/g, '');
      const id = 'ips' + (ref || crypto.randomBytes(6).toString('hex'));
      await poner('e/' + e.id + '/evaluaciones/' + id, { trabajador:t.id, fecha:b.fecha, tipo:tx(b.tipo, 60) || 'Periódica programada', concepto:b.concepto, recomendaciones:tx(b.recomendaciones, 2000), restricciones:tx(b.restricciones, 2000), vigencia:/^\d{4}-\d{2}-\d{2}$/.test(String(b.vigencia || '')) ? b.vigencia : '', ips:tx(b.ips, 100) || 'IPS conectada', origenIPS:{ en:new Date().toISOString(), ref } });
      const e2 = doc('empresas/' + e.id); if (e2?.ipsLlave?.hash === h) await poner('empresas/' + e.id, { ...e2, ipsLlave:{ ...e2.ipsLlave, ultimo:new Date().toISOString() } }); // si la desconectaron mientras tanto, no se revive
      return enviar(res, 200, { ok:true, id });
    }
    let s = sesion(req); if (!s) return enviar(res, 401, { code:'sesion', message:'Inicie sesión de nuevo.' });
    if (p === '/api/pago' && req.method === 'POST'){ // el súper registra un pago (manual o confirmando un aviso de llave) en una sola operación
      if (s.t !== 'u' || s.rol !== 'super') return enviar(res, 403, { code:'forbidden', message:'Solo el administrador de la plataforma registra pagos.' });
      const b = await leerCuerpo(req); const re = 'empresas/' + String(b.empresa || ''); const ra = b.aviso ? 'pagosAviso/' + String(b.aviso) : null;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(b.hasta || ''))) return enviar(res, 400, { code:'invalid_argument', message:'Escriba la fecha "Pagado hasta".' });
      const motivo = String(b.motivo || '').replace(/[<>"']/g, '').trim().slice(0, 300);
      if (!b.aviso && motivo.length < 5) return enviar(res, 400, { code:'invalid_argument', message:'Escriba el motivo de la corrección (por ejemplo, la referencia del pago de Bold que no se aplicó).' });
      const pg0 = b.pago || {}; const valor = Number(pg0.valor || 0);
      const aplicar = (emp, aviso, maxRec) => {
        if (!emp) throw { status:404, code:'not_found', message:'La empresa ya no existe.' };
        if (ra && (!aviso || aviso.estado !== 'pendiente')) throw { status:409, code:'ya_revisado', message:'Este aviso de pago ya fue revisado.' };
        let hasta = b.hasta; // si mientras tanto entró un pago de Bold, se corre la fecha esos meses
        if (b.base && String(emp.vence || '') > String(b.base)){ let n = 0, h = String(b.base); while (h < emp.vence && n < 24){ h = avanzarMeses(h, 1); n++; } hasta = avanzarMeses(hasta, n); }
        const anio = HOY().slice(0, 4); const recibo = valor > 0 ? 'RC-' + anio + '-' + String(maxRec + 1).padStart(4, '0') : null;
        const pago = recibo ? { fecha:String(pg0.fecha || HOY()).slice(0, 10), meses:Number(pg0.meses || 1), valor, ref:String(pg0.ref || '').slice(0, 80), medio:String(pg0.medio || 'Registrado por la plataforma').slice(0, 60), por:s.nombre, hasta, recibo } : null;
        if (pago && motivo) pago.motivo = motivo;
        const correcciones = [...(emp.correcciones || []), { fecha:HOY(), por:s.nombre, motivo:motivo || 'Confirmación de aviso', antes:emp.vence || '', hasta }].slice(-50);
        const e2 = { ...emp, vence:hasta, suspendida:false, correcciones, pagos:pago ? [...(emp.pagos || []), pago] : (emp.pagos || []), ...(emp.prueba ? { prueba:{ ...emp.prueba, cerrada:true } } : {}) };
        const a2 = ra ? { ...aviso, foto:'', estado:'confirmado', recibo, revisado:{ por:s.nombre, en:new Date().toISOString() } } : null;
        return { e2, a2, pago };
      };
      const maxRecMem = () => { const pre = 'RC-' + HOY().slice(0, 4) + '-'; let n = 0; coleccion('empresas').forEach(e => (e.pagos || []).forEach(x => { if (String(x.recibo || '').startsWith(pre)) n = Math.max(n, parseInt(x.recibo.slice(pre.length), 10) || 0); })); return n; };
      let out;
      if (pool){
        const c = await pool.connect();
        try {
          await c.query('begin'); await c.query('select pg_advisory_xact_lock(4242)');
          const e = (await c.query('select datos from docs where ruta = $1 for update', [re])).rows[0]?.datos;
          const av = ra ? (await c.query('select datos from docs where ruta = $1 for update', [ra])).rows[0]?.datos : null;
          const pre = 'RC-' + HOY().slice(0, 4) + '-';
          const mx = (await c.query(`select coalesce(max(substring(p->>'recibo' from $1)::int), 0) n from docs d, jsonb_array_elements(coalesce(d.datos->'pagos','[]'::jsonb)) p where d.coleccion = 'empresas' and p->>'recibo' like $2`, ['^' + pre + '([0-9]+)$', pre + '%'])).rows[0].n;
          out = aplicar(e, av, Number(mx));
          await c.query('update docs set datos = $2, actualizado = now() where ruta = $1', [re, out.e2]);
          if (ra) await c.query('update docs set datos = $2, actualizado = now() where ruta = $1', [ra, out.a2]);
          await c.query('commit');
        } catch(x){ await c.query('rollback').catch(() => {}); throw x; } finally { c.release(); }
        DOCS.set(re, { data:out.e2, ts:tic() }); if (ra) DOCS.set(ra, { data:out.a2, ts:tic() });
      } else {
        out = aplicar(doc(re), ra ? doc(ra) : null, maxRecMem()); await poner(re, out.e2); if (ra) await poner(ra, out.a2);
      }
      return enviar(res, 200, { ok:true, pago:out.pago, empresa:out.e2 });
    }
    if (p === '/api/market/doc' && req.method === 'POST'){ // documento comprado, lleno con los datos de la empresa
      if (s.t !== 'u' || s.cerrada || s.rol !== 'admin' || !s.empresa) return enviar(res, 403, { code:'forbidden', message:'Solo el administrador SG-SST carga los documentos comprados.' });
      const b = await leerCuerpo(req); const cod = String(b.codigo || ''); const e = doc('empresas/' + s.empresa) || {};
      if (!hay(MKT_DOCS, cod)) return enviar(res, 404, { code:'not_found', message:'Ese documento no está en el Market.' });
      if (!e.modulos?.[mktClave(cod)] && !e.modulos?.['doc-todos']) return enviar(res, 402, { code:'sin_compra', message:'Su empresa aún no ha comprado este documento.' });
      const d = documentoMarket(s.empresa, cod); if (!d) return enviar(res, 503, { code:'sin_plantilla', message:'El documento se está preparando. Escríbanos por WhatsApp 304 437 5758 y se lo activamos de inmediato.' });
      return enviar(res, 200, d);
    }
    if (p === '/api/super/plantillas' && req.method === 'POST'){ // el Superadministrador carga las plantillas del Market (archivo que entrega SkyNet Genesis)
      if (s.t !== 'u' || s.rol !== 'super') return enviar(res, 403, { code:'forbidden' });
      const b = await leerCuerpo(req); const pl = b && typeof b.plantillas === 'object' ? b.plantillas : null; if (!pl) return enviar(res, 400, { code:'invalid_argument', message:'El archivo no tiene plantillas.' });
      let n = 0; for (const [cod, d] of Object.entries(pl)){ if (!hay(MKT_DOCS, cod) || !d || typeof d.texto !== 'string') continue; await poner('plantillas/' + cod, { nombre:String(d.nombre || cod).slice(0, 200), tipo:String(d.tipo || '').slice(0, 40), texto:d.texto.slice(0, 400000), version:String(b.version || ''), cargado:new Date().toISOString() }); n++; }
      return enviar(res, 200, { ok:true, cargadas:n, faltan:Object.keys(MKT_DOCS).filter(c => !doc('plantillas/' + c)) });
    }
    if (p === '/api/conteo/tamizajes' && req.method === 'GET'){ // la empresa ve cuántos tamizajes hay, quién los aplicó y cuándo, sin nombres ni resultados
      if (s.t !== 'u' || !s.empresa || s.cerrada) return enviar(res, 403, { code:'forbidden' });
      const y = HOY().slice(0, 4); const t = coleccion('e/' + s.empresa + '/tamizajes'); const ty = t.filter(x => String(x.fecha || '').startsWith(y));
      return enviar(res, 200, { anio:y, total:ty.length, portal:ty.filter(x => !x.aplicadoPor).length, profesional:ty.filter(x => x.aplicadoPor).length, ultima:t.map(x => x.fecha).filter(Boolean).sort().pop() || null, todos:t.length });
    }
    if (p === '/api/super/aplicar-market' && req.method === 'POST'){ // el súper entrega a mano una compra del Market que quedó "para revisar" (con motivo)
      if (s.t !== 'u' || s.rol !== 'super') return enviar(res, 403, { code:'forbidden' });
      const b = await leerCuerpo(req); const rp = 'boldpagos/' + String(b.pago || '').replace(/[^A-Za-z0-9_-]/g, ''); const reg = doc(rp); const motivo = String(b.motivo || '').replace(/[<>]/g, '').trim().slice(0, 300);
      if (!reg || reg.estado !== 'revisar') return enviar(res, 409, { code:'estado', message:'Ese pago no está para revisar.' });
      if (motivo.length < 5) return enviar(res, 400, { code:'invalid_argument', message:'Escriba el motivo.' });
      const mk = /^centinela:(doc-[a-z0-9]+|paq_[a-z0-9_-]+)$/.exec(reg.plan || ''); const claves = mk ? (mk[1].startsWith('paq_') ? mk[1].slice(4).split('_').filter(Boolean) : [mk[1]]) : [];
      if (!claves.length || !claves.every(k => hay(MKT, k))) return enviar(res, 400, { code:'invalid_argument', message:'Ese pago no es una compra de documentos del Market.' });
      const r = await enCola(() => aplicarMarket({ ...reg, motivoSuper:motivo, porSuper:s.nombre }, rp, reg.empresa, [...new Set(claves)], true)); return enviar(res, 200, r);
    }
    if (p === '/api/super/plantillas' && req.method === 'GET'){ if (s.t !== 'u' || s.rol !== 'super') return enviar(res, 403, { code:'forbidden' }); return enviar(res, 200, { cargadas:Object.keys(MKT_DOCS).filter(c => doc('plantillas/' + c)), total:Object.keys(MKT_DOCS).length }); }
    if (p === '/api/votar' && req.method === 'POST'){ // voto secreto: se guarda que el trabajador votó y, por separado, el voto sin su nombre
      if (s.t !== 'w') return enviar(res, 403, { code:'forbidden', message:'Solo los trabajadores votan, desde su portal.' });
      const b = await leerCuerpo(req); const eid = String(b.eleccion || '').replace(/[^A-Za-z0-9_-]/g, ''); const cand = String(b.candidato || '');
      const out = await enCola(async () => {
        const el = doc('e/' + s.cid + '/elecciones/' + eid); const hoy = HOY();
        if (!el || el.estado !== 'votacion' || el.votacionDesde > hoy || el.votacionHasta < hoy) return { status:409, body:{ code:'cerrada', message:'La votación no está abierta.' } };
        if (cand !== 'blanco' && !(el.candidatos || []).includes(cand)) return { status:400, body:{ code:'invalid_argument', message:'Ese candidato no está en la elección.' } };
        const rv = 'e/' + s.cid + '/votos/' + eid + '_' + s.tid; if (doc(rv)) return { status:409, body:{ code:'ya_voto', message:'Usted ya votó en esta elección.' } };
        const ru = 'e/' + s.cid + '/urna/' + eid; const u0 = doc(ru) || { eleccion:eid, conteo:{}, blanco:0, total:0 }; // solo el conteo: no hay un registro por voto
        await poner(ru, { ...u0, conteo:cand === 'blanco' ? u0.conteo : { ...u0.conteo, [cand]:(u0.conteo[cand] || 0) + 1 }, blanco:u0.blanco + (cand === 'blanco' ? 1 : 0), total:u0.total + 1 });
        await poner(rv, { eleccion:eid, trabajador:s.tid, fecha:hoy });
        return { status:200, body:{ ok:true } };
      });
      return enviar(res, out.status, out.body);
    }
    if (p === '/api/asistencia' && req.method === 'POST'){ // el trabajador registra su asistencia con el código que da el facilitador (o el QR)
      if (s.t !== 'w') return enviar(res, 403, { code:'forbidden' });
      if (frenar('as:' + s.cid + ':' + s.tid, 10, 15)) return enviar(res, 429, { code:'rate_limited', message:'Demasiados intentos. Espere 15 minutos.' }); fallo('as:' + s.cid + ':' + s.tid);
      const b = await leerCuerpo(req); const cod = String(b.codigo || '').trim(); const hoy = HOY();
      const out = await enCola(async () => {
        const c = coleccion('e/' + s.cid + '/capacitaciones').find(x => (!b.cap || x.id === String(b.cap)) && codAsis(x.id, x) === cod && x.fecha && dias(x.fecha, hoy) <= 0 && dias(x.fecha, hoy) >= -3);
        if (!c) return { status:404, body:{ code:'codigo', message:'El código no corresponde a una capacitación de los últimos 3 días.' } };
        const { id, ...d } = c; if ((d.asistentes || []).includes(s.tid)) return { status:200, body:{ ok:true, tema:d.tema, ya:true } };
        await poner('e/' + s.cid + '/capacitaciones/' + id, { ...d, asistentes:[...(d.asistentes || []), s.tid] }); return { status:200, body:{ ok:true, tema:d.tema } }; });
      return enviar(res, out.status, out.body);
    }
    if (p === '/api/escrutinio' && req.method === 'POST'){ // cierra la votación y cuenta los votos en el servidor
      if (s.t !== 'u' || s.rol !== 'admin' || !s.empresa || s.cerrada) return enviar(res, 403, { code:'forbidden', message:'Solo el administrador SG-SST hace el escrutinio.' });
      const b = await leerCuerpo(req); const eid = String(b.eleccion || '').replace(/[^A-Za-z0-9_-]/g, ''); const re = 'e/' + s.empresa + '/elecciones/' + eid;
      const out = await enCola(async () => { const el = doc(re); if (!el || el.estado !== 'votacion') return { status:409, body:{ code:'estado', message:'La votación no está abierta.' } };
        const u0 = doc('e/' + s.empresa + '/urna/' + eid) || { conteo:{}, blanco:0, total:0 };
        const resultado = (el.candidatos || []).map(t => ({ tid:t, votos:Number(u0.conteo?.[t] || 0) })).sort((a, b2) => b2.votos - a.votos);
        const habilitados = coleccion('e/' + s.empresa + '/trabajadores').filter(t => t.estado !== 'retirado').length;
        const e2 = { ...el, estado:'cerrada', resultado, blanco:u0.blanco || 0, total:u0.total || 0, habilitados, escrutinio:{ por:s.nombre, en:new Date().toISOString() } };
        await poner(re, e2); return { status:200, body:{ ok:true, eleccion:e2 } }; });
      return enviar(res, out.status, out.body);
    }
    if (p === '/api/asesor/empresa' && req.method === 'POST'){ // el asesor elige la empresa en la que trabaja
      if (!s.asesor) return enviar(res, 403, { code:'forbidden' }); const b = await leerCuerpo(req); const cid = String(b.empresa || '');
      if (cid && !s.asesorDe.includes(cid)) return enviar(res, 403, { code:'forbidden', message:'No tiene acceso a esa empresa.' });
      const us = doc('usuarios/' + s.uid); await poner('usuarios/' + s.uid, { ...us, empresa:cid || null }); return enviar(res, 200, { ok:true });
    }
    if (p === '/api/asesor/invitar' && req.method === 'POST'){ // el administrador de una empresa invita a un asesor por su correo
      if (s.t !== 'u' || s.rol !== 'admin' || s.asesor || s.cerrada) return enviar(res, 403, { code:'forbidden', message:'Solo el administrador SG-SST de la empresa invita asesores.' });
      const b = await leerCuerpo(req); const cor = String(b.correo || '').trim().toLowerCase();
      if (frenar('inv:' + s.empresa, 10, 60)) return enviar(res, 429, { code:'rate_limited', message:'Demasiados intentos. Espere una hora.' }); fallo('inv:' + s.empresa);
      const a = coleccion('usuarios').find(x => x.rol === 'asesor' && x.activo !== false && (String(x.correo || '').toLowerCase() === cor || x.usuario === cor));
      if (!a) return enviar(res, 404, { code:'no_asesor', message:'Ese correo no es de un asesor registrado. El asesor debe pedir su cuenta de asesor a SkyNet Genesis (WhatsApp 304 437 5758).' });
      const { id, ...a2 } = a; await poner('usuarios/' + id, { ...a2, empresas:[...new Set([...(a2.empresas || []), s.empresa])] });
      const e = doc('empresas/' + s.empresa); correoA(a.correo, 'Centinela-IA SST: lo invitaron como asesor', `<p>Hola, ${esc(a.nombre)}.</p><p><b>${esc(e?.razon || '')}</b> le dio acceso como asesor SST. Entre a <a href="${URL_APP}">${URL_APP}</a> y elíjala en "Mis empresas".</p>`);
      return enviar(res, 200, { ok:true });
    }
    if (p === '/api/asesor/quitar' && req.method === 'POST'){
      if (s.t !== 'u' || s.rol !== 'admin' || s.asesor) return enviar(res, 403, { code:'forbidden' });
      const b = await leerCuerpo(req); const ru = 'usuarios/' + String(b.uid || ''); const a = doc(ru);
      if (!a || a.rol !== 'asesor') return enviar(res, 404, { code:'not_found' });
      await poner(ru, { ...a, empresas:(a.empresas || []).filter(x => x !== s.empresa), empresa:a.empresa === s.empresa ? null : a.empresa }); return enviar(res, 200, { ok:true });
    }
    if (p === '/api/orden-ips' && req.method === 'POST'){ // envía por correo a la IPS la orden de exámenes (sin datos clínicos)
      if (s.t !== 'u' || s.cerrada || !['admin','auxiliar','medico'].includes(s.rol)) return enviar(res, 403, { code:'forbidden' });
      const b = await leerCuerpo(req); const ro = 'e/' + s.empresa + '/ordenes/' + String(b.orden || '').replace(/[^A-Za-z0-9_-]/g, ''); const o = doc(ro); if (!o) return enviar(res, 404, { code:'not_found', message:'La orden no existe.' });
      if (frenar('oi:' + s.empresa, 40, 60)) return enviar(res, 429, { code:'rate_limited', message:'Demasiados envíos. Espere una hora.' }); fallo('oi:' + s.empresa);
      const e = doc('empresas/' + s.empresa); const t = doc('e/' + s.empresa + '/trabajadores/' + o.trabajador) || {}; const cg = doc('e/' + s.empresa + '/cargos/' + t.cargo) || {};
      const ips = { correo:'contacto@reinaelizabeth.com', nombre:'Clínica Reina Elizabeth IPS', ...(doc('plataforma/config')?.ips || {}) };
      const fila = (k, v) => `<tr><td style="padding:4px 8px;color:#5D6B78">${k}</td><td style="padding:4px 8px"><b>${esc(String(v || '—'))}</b></td></tr>`;
      const ok = await correoA(ips.correo, 'Orden de exámenes ocupacionales: ' + (t.nombres || '') + ' ' + (t.apellidos || '') + ' (' + (e?.razon || '') + ')', `<p>Cordial saludo. ${esc(e?.razon || '')} solicita la siguiente evaluación médica ocupacional:</p><table>${fila('Trabajador', (t.nombres || '') + ' ' + (t.apellidos || ''))}${fila('Documento', (t.tipoDoc || '') + ' ' + (t.documento || ''))}${fila('Cargo', cg.nombre)}${fila('Tipo de evaluación', o.tipo)}${fila('Exámenes', (o.examenes || []).join(', '))}${fila('Funciones', cg.funciones)}${fila('Peligros', (cg.peligros || []).join(', '))}${fila('Tarea de alto riesgo', cg.altoRiesgo || 'No aplica')}${fila('EPP', cg.epp)}${fila('Observaciones', o.obs)}${fila('Contacto', [e?.responsable, e?.correo, e?.telefono].filter(Boolean).join(' · '))}</table><p>Por favor, envíe el certificado de aptitud a la empresa. Resolución 1843 de 2025.</p>`);
      if (ok) await poner(ro, { ...o, estado:o.estado === 'realizada' ? o.estado : 'enviada', enviada:{ en:new Date().toISOString(), por:s.nombre, medio:'Correo a ' + ips.correo } });
      return enviar(res, 200, { ok:true, enviado:!!ok });
    }
    if (p === '/api/respaldo' && req.method === 'GET'){ // (20 oct 2026, decisión de Ricardo) respaldo COMPLETO de todas las empresas para el Superadministrador, para recuperar datos si una empresa los pierde; incluye las contraseñas cifradas (no se pueden leer)
      if (s.t !== 'u' || s.rol !== 'super') return enviar(res, 403, { code:'forbidden' });
      const out = {}; DOCS.forEach((v, ruta) => { out[ruta] = v.data; }); // incluye la contraseña CIFRADA (sal y hash): al restaurar, cada usuario entra con su misma contraseña; nadie puede leerla
      res.writeHead(200, { 'Content-Type':'application/json; charset=utf-8', 'Content-Disposition':'attachment; filename="respaldo-centinela-ia-' + HOY() + '.json"' }); return res.end(JSON.stringify({ app:'Centinela-IA SST', fecha:new Date().toISOString(), nota:'Respaldo completo de todas las empresas (incluye datos clínicos, confidenciales y las contraseñas cifradas: guárdelo con seguridad). contacto@skynetgenesis.com · WhatsApp 304 437 5758', docs:out }));
    }
    if (p === '/api/firmar' && req.method === 'POST'){ // firma de informes con la contraseña del usuario
      if (s.t !== 'u' || s.cerrada || !['admin','medico','psicologo','super'].includes(s.rol)) return enviar(res, 403, { code:'forbidden', message:'No tiene permiso para firmar.' });
      const b = await leerCuerpo(req); const ruta = String(b.ruta || ''); const prev = doc(ruta); const us = doc('usuarios/' + s.uid);
      if (!prev || partes(ruta)[0].split('/')[2] !== 'informes' || (s.rol !== 'super' && empresaDe(ruta) !== s.empresa) || !puedeLeer(s, ruta, prev)) return enviar(res, 403, { code:'forbidden', message:'No tiene permiso para firmar este informe.' });
      const FIRMAN = { diagnostico:['medico'], pve:['medico','psicologo'], plananual:['admin','super'], rendicion:['admin','super'], revision:['admin','super'] };
      if (!(FIRMAN[prev.tipo] || ['medico','admin','super']).includes(s.rol)) return enviar(res, 403, { code:'forbidden', message:'Su rol no firma este tipo de informe.' });
      if (prev.firma) return enviar(res, 409, { code:'ya_firmado', message:'Este informe ya está firmado.' });
      if (frenar('f:' + s.uid, 6, 15)) return enviar(res, 429, { code:'rate_limited', message:'Demasiados intentos. Espere 15 minutos.' });
      if (hashClave(b.clave || '', us.sal) !== us.hash){ fallo('f:' + s.uid); return enviar(res, 400, { code:'clave', message:'La contraseña no es correcta. La firma no se registró.' }); }
      const secciones = Array.isArray(b.secciones) && b.secciones.length === (prev.secciones || []).length ? b.secciones.map((x, i) => [String(prev.secciones[i][0]), String(x[1] ?? '')]) : prev.secciones;
      const firma = { nombre:us.nombre, cargo:String(b.cargo || '').slice(0, 80), licencia:us.licencia || '', en:new Date().toISOString(), usuario:us.usuario };
      await poner(ruta, { ...prev, secciones, firma }); return enviar(res, 200, { ok:true, firma });
    }
    /* ---------- (31 oct 2026) adjuntos, enlaces, encuestas, cuentas y manuales ---------- */
    if (p === '/api/archivo' && req.method === 'POST'){ // evidencia adjunta (foto reducida o PDF liviano) a un registro de la empresa
      if (s.t !== 'u' || s.cerrada || !s.empresa || !['admin','medico','auxiliar','psicologo','jefe'].includes(s.rol)) return enviar(res, 403, { code:'forbidden', message:'Su perfil no adjunta evidencias.' });
      if (frenar('ar:' + s.uid, 120, 60)) return enviar(res, 429, { code:'rate_limited', message:'Demasiados archivos en una hora.' }); fallo('ar:' + s.uid);
      const b = await leerCuerpo(req); const col = String(b.col || '').replace(/[^A-Za-z]/g, ''); const ref = String(b.ref || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 60);
      if (!col || CLIN.has(col) || ['quejas','sociodemo','usuarios'].includes(col)) return enviar(res, 400, { code:'invalid_argument', message:'Ese registro no admite adjuntos.' });
      if (s.rol === 'jefe' && !JEFE_ESCRIBE.has(col)) return enviar(res, 403, { code:'forbidden' });
      const a = await guardarArchivo(s.empresa, String(b.tipo || ''), b.datos);
      const m = { col, ref, nombre:String(b.nombre || 'evidencia').replace(/[<>]/g, '').slice(0, 120), tipo:String(b.tipo), bytes:a.bytes, fecha:HOY(), por:s.nombre, etiqueta:String(b.etiqueta || '').replace(/[<>]/g, '').slice(0, 60), std:/^\d+(\.\d+){1,2}$/.test(String(b.std || '')) ? String(b.std) : '', archivo:a.id, en:new Date().toISOString() };
      await poner('e/' + s.empresa + '/evidencias/' + a.id, m); return enviar(res, 200, { ok:true, id:a.id, usado:USO.get(s.empresa) || 0, cupo:CUPO_MB * 1048576 });
    }
    if (p === '/api/archivo' && req.method === 'GET'){
      const id = String(u.searchParams.get('id') || '').replace(/[^A-Za-z0-9_-]/g, '');
      if (s.t !== 'u' || s.cerrada || !s.empresa) return enviar(res, 403, { code:'forbidden' });
      const m = doc('e/' + s.empresa + '/evidencias/' + id); if (!m || !puedeLeer(s, 'e/' + s.empresa + '/evidencias/' + id, m)) return enviar(res, 404, { code:'not_found', message:'El archivo no existe.' });
      if (s.rol === 'jefe' && m.col === 'contratistas') return enviar(res, 403, { code:'forbidden' });
      const a = await leerArchivo(id); if (!a || a.empresa !== s.empresa) return enviar(res, 404, { code:'not_found' });
      return enviar(res, 200, { tipo:a.tipo, nombre:m.nombre, datos:Buffer.from(a.datos).toString('base64') });
    }
    if (p === '/api/espacio' && req.method === 'GET'){ if (s.t !== 'u' || !s.empresa) return enviar(res, 403, { code:'forbidden' }); return enviar(res, 200, { usado:USO.get(s.empresa) || 0, cupo:CUPO_MB * 1048576 }); }
    if (p === '/api/contratista/enlace' && req.method === 'POST'){ // enlace para que el contratista suba su PILA, ARL y certificados
      if (s.t !== 'u' || s.cerrada || !s.empresa || !['admin','auxiliar'].includes(s.rol)) return enviar(res, 403, { code:'forbidden' });
      const b = await leerCuerpo(req); const kid = String(b.contratista || '').replace(/[^A-Za-z0-9_-]/g, ''); const ruta = 'e/' + s.empresa + '/contratistas/' + kid; const c = doc(ruta);
      if (!c) return enviar(res, 404, { code:'not_found' });
      const v = b.nuevo || !c.enlaceV ? Number(c.enlaceV || 0) + 1 : Number(c.enlaceV); if (v !== Number(c.enlaceV || 0)) await poner(ruta, { ...c, enlaceV:v });
      return enviar(res, 200, { ok:true, url:URL_APP + '/#contratista=' + firmar({ t:'k', cid:s.empresa, kid, v }, 120 * 864e5), dias:120 });
    }
    if (p === '/api/visita/enlace' && req.method === 'POST'){
      if (s.t !== 'u' || s.cerrada || !s.empresa || !['admin','auxiliar'].includes(s.rol)) return enviar(res, 403, { code:'forbidden' });
      const b = await leerCuerpo(req); const e = doc('empresas/' + s.empresa); let v = Number(e.visitasV || 0);
      if (b.nuevo || !v){ v++; await poner('empresas/' + s.empresa, { ...e, visitasV:v }); }
      return enviar(res, 200, { ok:true, url:URL_APP + '/#visita=' + firmar({ t:'q', cid:s.empresa, v }, 3 * 365 * 864e5) });
    }
    if (p === '/api/ips/llave' && req.method === 'POST'){ // llave para que la IPS (Clínica-IA) envíe los conceptos de aptitud; se ve una sola vez
      if (s.t !== 'u' || s.cerrada || s.rol !== 'admin' || !s.empresa) return enviar(res, 403, { code:'forbidden', message:'Solo el administrador SG-SST genera la llave.' });
      const b = await leerCuerpo(req); const e = doc('empresas/' + s.empresa);
      if (b.quitar){ await poner('empresas/' + s.empresa, { ...e, ipsLlave:undefined }); return enviar(res, 200, { ok:true }); }
      const llave = 'cen_' + crypto.randomBytes(24).toString('base64url');
      await poner('empresas/' + s.empresa, { ...e, ipsLlave:{ hash:crypto.createHash('sha256').update(llave).digest('hex'), creada:new Date().toISOString(), por:s.nombre, ips:String(b.ips || '').replace(/[<>]/g, '').slice(0, 100) } });
      return enviar(res, 200, { ok:true, llave, url:URL_API + '/api/ips/concepto', nit:e.nit });
    }
    if (p === '/api/encuesta' && req.method === 'POST'){ // el trabajador confirma la lectura de un comunicado o responde una encuesta (una vez)
      if (s.t !== 'w') return enviar(res, 403, { code:'forbidden' });
      const b = await leerCuerpo(req); const cid2 = String(b.comunicado || '').replace(/[^A-Za-z0-9_-]/g, '');
      const out = await enCola(async () => {
        const c = doc('e/' + s.cid + '/comunicados/' + cid2); if (!c || !c.publicado || (c.hasta && c.hasta < HOY()) || (c.fecha && c.fecha > HOY())) return { status:404, body:{ code:'not_found', message:'El comunicado no está vigente.' } };
        const rl = 'e/' + s.cid + '/lecturas/' + cid2 + '_' + s.tid; if (doc(rl)?.respondio || (doc(rl) && c.tipo !== 'encuesta')) return { status:200, body:{ ok:true, ya:true } };
        if (c.tipo === 'encuesta'){
          const pr = Array.isArray(c.preguntas) ? c.preguntas : []; const rs = Array.isArray(b.respuestas) ? b.respuestas.map(Number) : [];
          if (rs.length !== pr.length || rs.some((x, i) => !Number.isInteger(x) || x < 0 || x >= (pr[i].op || []).length)) return { status:400, body:{ code:'invalid_argument', message:'Responda todas las preguntas.' } };
          if (c.anonima){ // anónima: solo un conteo por opción (sin un registro por persona); se ve al cerrar la encuesta
            const rt = 'e/' + s.cid + '/encuestaRes/' + cid2 + '_total'; const t0 = doc(rt) || { comunicado:cid2, anonima:true, conteo:pr.map(q => (q.op || []).map(() => 0)), total:0 };
            await poner(rt, { ...t0, conteo:t0.conteo.map((fila, i) => fila.map((n, k) => n + (rs[i] === k ? 1 : 0))), total:t0.total + 1 });
          } else await poner('e/' + s.cid + '/encuestaRes/' + cid2 + '_' + s.tid, { comunicado:cid2, respuestas:rs, fecha:HOY(), trabajador:s.tid });
        }
        await poner(rl, { comunicado:cid2, trabajador:s.tid, respondio:c.tipo === 'encuesta' });
        return { status:200, body:{ ok:true } };
      });
      return enviar(res, out.status, out.body);
    }
    if (p === '/api/manual' && req.method === 'GET'){ // cada usuario abre solo el manual de su perfil (más el general)
      const MAN = { super:['general','superadmin','admin','medico','psicologo','auxiliar','consulta','jefe','trabajador','asesor'], admin:['general','admin'], medico:['general','medico'], psicologo:['general','psicologo'], auxiliar:['general','auxiliar'], consulta:['general','consulta'], jefe:['general','jefe'] };
      const permitidos = s.t === 'w' ? ['trabajador'] : (s.asesor ? ['general','asesor','admin'] : MAN[s.rol] || []); const cual = String(u.searchParams.get('m') || permitidos[permitidos.length - 1] || '');
      if (!permitidos.includes(cual)) return enviar(res, 403, { code:'forbidden', message:'Ese manual no corresponde a su perfil.' });
      const a = await leerArchivo('manual-' + cual); if (!a) return enviar(res, 404, { code:'not_found', message:'El manual se está actualizando. Escríbanos por WhatsApp 304 437 5758.' });
      res.writeHead(200, { 'Content-Type':'application/pdf', 'Content-Disposition':'inline; filename="Manual-Centinela-IA-' + cual + '.pdf"' }); return res.end(Buffer.from(a.datos));
    }
    if (p === '/api/super/manuales' && req.method === 'POST'){
      if (s.t !== 'u' || s.rol !== 'super') return enviar(res, 403, { code:'forbidden' });
      const b = await leerCuerpo(req, 30e6); let n = 0; for (const [k, v] of Object.entries(b.manuales || {})){ if (!/^[a-z]{3,20}$/.test(k)) continue; await guardarArchivo(null, 'application/pdf', v, 'manual-' + k); n++; }
      await poner('plataforma/manuales', { cargados:Object.keys(b.manuales || {}).filter(k => /^[a-z]{3,20}$/.test(k)), version:String(b.version || '').slice(0, 40), en:new Date().toISOString() });
      return enviar(res, 200, { ok:true, cargados:n });
    }
    if (p === '/api/super/interna' && req.method === 'POST'){ // empresas propias del dueño: activas sin prueba ni cobros (con motivo)
      if (s.t !== 'u' || s.rol !== 'super') return enviar(res, 403, { code:'forbidden' });
      const b = await leerCuerpo(req); const re = 'empresas/' + String(b.empresa || '').replace(/[^A-Za-z0-9_-]/g, ''); const e = doc(re); const motivo = String(b.motivo || '').replace(/[<>]/g, '').trim().slice(0, 300);
      if (!e) return enviar(res, 404, { code:'not_found' }); if (motivo.length < 5) return enviar(res, 400, { code:'invalid_argument', message:'Escriba el motivo.' });
      const correcciones = [...(e.correcciones || []), { fecha:HOY(), por:s.nombre, motivo:(b.interna ? 'Empresa interna: ' : 'Deja de ser interna: ') + motivo, antes:e.vence || '', hasta:e.vence || '' }].slice(-50);
      await poner(re, { ...e, interna:b.interna ? { motivo, por:s.nombre, fecha:HOY() } : undefined, suspendida:b.interna ? false : e.suspendida, correcciones }); return enviar(res, 200, { ok:true });
    }
    if (p === '/api/super/enlace' && req.method === 'POST'){ // «Cuentas y accesos»: enviar el enlace para crear o cambiar la contraseña
      if (s.t !== 'u' || s.rol !== 'super') return enviar(res, 403, { code:'forbidden' });
      const b = await leerCuerpo(req); const us = doc('usuarios/' + String(b.uid || '')); if (!us) return enviar(res, 404, { code:'not_found' });
      const para = destinoClave(us); if (!para) return enviar(res, 400, { code:'sin_correo', message:'Ese usuario no tiene correo.' });
      const ok = await enviarEnlaceClave({ ...us, id:String(b.uid) }, para); return enviar(res, 200, { ok:!!ok, para:para === DUENO_CORREO ? 'el Gmail del dueño' : para });
    }
    if (p === '/api/sync'){
      const since = Number(u.searchParams.get('since') || 0); const mismo = u.searchParams.get('epoch') === EPOCH; const desde = mismo ? since : 0;
      const cambios = [];
      DOCS.forEach((v, ruta) => { if (v.ts > desde && puedeLeer(s, ruta, v.data)){ let data = partes(ruta)[0] === 'usuarios' ? limpiarUsuario(v.data) : v.data; if (s.t === 'w' && data && data.codigoAsis){ const { codigoAsis, ...r } = data; data = r; } cambios.push({ ruta, data }); } });
      if (mismo) BORRADOS.forEach((ts, ruta) => { if (ts > desde) cambios.push({ ruta, data:null }); });
      return enviar(res, 200, { epoch:EPOCH, ahora:RELOJ, completo:!mismo || !since, cerrada:!!s.cerrada, cambios });
    }
    if (p === '/api/doc' && req.method === 'PUT'){
      const b = await leerCuerpo(req); if (!b.ruta || !b.data || typeof b.data !== 'object') return enviar(res, 400, { code:'invalid_argument' });
      await guardar(s, b.ruta, b.data); return enviar(res, 200, { ok:true, ahora:RELOJ });
    }
    if (p === '/api/doc' && req.method === 'DELETE'){
      const ruta = u.searchParams.get('ruta') || ''; revisarEscritura(s, ruta, null, true); await quitar(ruta); if (/^e\/[^/]+\/trabajadores\//.test(ruta)) await contarTrabajadores(empresaDe(ruta)); return enviar(res, 200, { ok:true });
    }
    if (p === '/api/clave' && req.method === 'POST'){
      if (s.t !== 'u') return enviar(res, 403, { code:'forbidden' }); const b = await leerCuerpo(req); const us = doc('usuarios/' + s.uid);
      if (hashClave(b.actual || '', us.sal) !== us.hash) return enviar(res, 400, { code:'clave_actual', message:'La contraseña actual no es correcta.' });
      const n = String(b.nueva || ''); if (!claveFuerte(n)) return enviar(res, 400, { code:'clave_debil', message:MSG_CLAVE });
      const sal = crypto.randomBytes(12).toString('hex'); await poner('usuarios/' + s.uid, { ...us, sal, hash:hashClave(n, sal), cambiarClave:false }); return enviar(res, 200, { ok:true });
    }
    return enviar(res, 404, { code:'not_found' });
  } catch(e){
    if (e && e.status) return enviar(res, e.status, { code:e.code, message:e.message });
    console.error(e); return enviar(res, 500, { code:'error', message:'Error del servidor.' });
  }
});
iniciarBD().then(() => server.listen(PORT, () => console.log('Centinela-IA SST escuchando en el puerto', PORT))).catch(e => { console.error('No se pudo iniciar la base de datos', e); process.exit(1); });
