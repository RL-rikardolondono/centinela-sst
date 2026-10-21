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
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || ''; // créditos de API de SkyNet Genesis: nunca se muestra ni se guarda en la base
const IA_MODELO = process.env.IA_MODELO || 'claude-haiku-5-5';
const IA_URL = process.env.IA_URL || 'https://api.anthropic.com/v1/messages';
const IA_TOPE_USD = Number(process.env.IA_TOPE_USD || 40); // tope de gasto mensual de IA de toda la plataforma
const IA_PRECIO_IN = Number(process.env.IA_PRECIO_IN || 0.10), IA_PRECIO_OUT = Number(process.env.IA_PRECIO_OUT || 0.50); // USD por millón de tokens (revisar cada mes)
const IA_PLANES = { ia100:[100, 60000], ia300:[300, 150000], ia1000:[1000, 400000] }; // consultas y precio en pesos (pago único con Bold, vigencia 30 días)
const BOLD_VERIFICAR = process.env.BOLD_VERIFICAR || 'https://skynetgenesis.com/bold-verificar.php'; // central de pagos de SkyNet Genesis
const DIAS_PRUEBA = 15;
const TRAMOS_DEF = [{ hasta:10, precio:89000 }, { hasta:50, precio:159000 }, { hasta:200, precio:289000 }, { hasta:null, precio:490000 }];
const DB_URL = process.env.DATABASE_URL || '';
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
    const r = await pool.query('select ruta, datos from docs');
    r.rows.forEach(x => DOCS.set(x.ruta, { data:x.datos, ts:tic() }));
    console.log('Documentos cargados desde PostgreSQL:', DOCS.size);
  } else if (ARCHIVO && fs.existsSync(ARCHIVO)){
    const o = JSON.parse(fs.readFileSync(ARCHIVO, 'utf8')); Object.entries(o).forEach(([k, v]) => DOCS.set(k, { data:v, ts:tic() }));
    console.log('Documentos cargados desde archivo:', DOCS.size);
  } else console.log('Sin base de datos: modo de prueba en memoria.');
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
  const meses = faltan.filter(x => !x.concepto).reduce((a, x) => a + Number(x.meses ?? 1), 0); // las compras de IA no suman meses
  return { ...d, pagos:[...(d.pagos || []), ...faltan], vence:meses ? avanzarMeses(d.vence || enBase.vence, meses) : (d.vence || enBase.vence), ia:enBase.ia || d.ia, suspendida:meses ? false : d.suspendida };
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
    return { t:'u', uid:p.uid, rol:u.rol, empresa:u.empresa, nombre:u.nombre, usuario:u.usuario, cerrada:u.rol !== 'super' && empresaCerrada(u.empresa) }; }
  if (p.t === 'w'){ const t = doc('e/' + p.cid + '/trabajadores/' + p.tid); if (!t || t.estado === 'retirado' || empresaCerrada(p.cid)) return null; return { t:'w', cid:p.cid, tid:p.tid }; }
  return null;
}

/* ---------- límites de intentos ---------- */
const INTENTOS = new Map();
function frenar(clave, max, ventanaMin){ const ahora = Date.now(); const a = (INTENTOS.get(clave) || []).filter(x => ahora - x < ventanaMin * 60e3); INTENTOS.set(clave, a); return a.length >= max; }
const fallo = clave => INTENTOS.set(clave, [...(INTENTOS.get(clave) || []), Date.now()]);

/* ---------- permisos ---------- */
const CLIN = new Set(['hc','tamizajes','casos','autoreportes','bateriaInd','paraclinicos']);
const PORTAL_PROPIOS = new Set(['evaluaciones','tamizajes','cursosRes','epp','reportes','autoreportes','cambios','practicaRes','votos','sociodemo']);
const PORTAL_TODOS = new Set(['cargos','cursos','capacitaciones','elecciones']);
/* respuestas correctas de los simulacros por casos (deben coincidir con CASOS_PR del cliente) */
const CLAVES_CASOS = { b1:[0,1,0,1], b2:[1,0,0], b3:[1,0,1], v1:[1,0,1], v2:[1,1,0], v3:[1,1,1], c1:[1,1,1], c2:[1,0,1], c3:[1,1,0] };
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
    if (PORTAL_PROPIOS.has(c)) return d && d.trabajador === s.tid;
    return false;
  }
  if (s.cerrada) return ruta === 'empresas/' + s.empresa || ruta === 'usuarios/' + s.uid || col === 'plataforma';
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
  if (c === 'quejas') return ['admin','psicologo','super'].includes(s.rol);
  if (c === 'sociodemo') return ['admin','medico','psicologo'].includes(s.rol);
  if (c === 'urna'){ const el = doc('e/' + cid + '/elecciones/' + id); return !!el && el.estado === 'cerrada'; } // el conteo se ve solo después del escrutinio
  return true;
}
const limpiarUsuario = d => { if (!d) return d; const { sal, hash, ...r } = d; return r; };
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
    if (c === 'tareas'){ if (d.trabajador !== s.tid) no(); return d; }
    if (c === 'casos'){ if (d.trabajador !== s.tid) no(); return { __caso:true, ...d, nivel:['bajo','medio','alto'].includes(d.nivel) ? d.nivel : 'medio' }; }
    no();
  }
  const R = s.rol;
  if (col === 'pagosAviso'){ // (oct 2026) la mensualidad se paga solo con Bold: ya no hay avisos "Ya pagué"
    if (R === 'super') return borrar ? null : d;
    throw { status:403, code:'solo_bold', message:'La mensualidad se paga en línea con Bold.' };
  }
  if (col === 'boldpagos' || col === 'pruebas'){ if (R !== 'super' || !borrar) no(); return null; } // los escribe solo el servidor
  if (s.cerrada) throw { status:402, code:'cerrada', message:'El acceso de su empresa está cerrado por pago pendiente.' };
  if (col === 'usuarios'){
    if (borrar){ if (R !== 'super') no(); return null; }
    const otro = coleccion('usuarios').find(u => u.usuario === d.usuario && u.id !== id); if (otro) throw { status:409, code:'usuario_existe', message:'Ese usuario ya existe. Elija otro.' };
    const cor = String(d.correo || '').trim().toLowerCase();
    if (cor && coleccion('usuarios').some(u => u.id !== id && (String(u.correo || '').toLowerCase() === cor || u.usuario === cor))) throw { status:409, code:'correo_existe', message:'Ese correo ya lo usa otra cuenta.' };
    if (String(d.usuario || '').includes('@') && d.usuario !== cor && !(prev && prev.usuario === d.usuario)) throw { status:400, code:'invalid_argument', message:'Si el usuario es un correo, debe ser el mismo correo del usuario.' };
    const base = { ...d }; if (!base.hash && prev?.hash){ base.sal = prev.sal; base.hash = prev.hash; }
    if (prev?.rol === 'asesor' || d.rol === 'asesor'){ // las empresas de un asesor solo cambian por invitación del administrador de cada empresa
      if (R === 'super' && !s.asesor) return prev ? { ...base, empresas:prev.empresas || [], empresa:prev.empresa || null } : { ...base, empresas:[], empresa:null };
      if (id === s.uid && prev) return { ...base, rol:prev.rol, empresa:prev.empresa, empresas:prev.empresas || [], activo:prev.activo, usuario:prev.usuario };
      no();
    }
    if (R === 'super') return base;
    if (R === 'admin' && s.empresa && d.empresa === s.empresa && d.rol !== 'super' && (!prev || (prev.empresa === s.empresa && prev.rol !== 'super'))) return base;
    if (id === s.uid && prev) return { ...base, rol:prev.rol, empresa:prev.empresa, activo:prev.activo, usuario:prev.usuario };
    no();
  }
  if (col === 'empresas' && !borrar && d.logo && !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(String(d.logo))) throw { status:400, code:'invalid_argument', message:'El logo no es una imagen válida.' };
  if (col === 'empresas'){
    if (R === 'super'){ if (borrar) return null;
      if (prev) return { ...d, trabajadoresActivos:prev.trabajadoresActivos, ia:prev.ia, correcciones:prev.correcciones, vence:prev.vence, pagos:prev.pagos || [], prueba:prev.prueba }; // el súper no regala: fechas y pagos solo con Bold o una corrección con motivo
      const hoy = HOY(); const d0 = new Date(hoy + 'T12:00:00Z'); d0.setUTCDate(d0.getUTCDate() + DIAS_PRUEBA - 1); const hp = d0.toISOString().slice(0, 10);
      return { ...d, trabajadoresActivos:0, pagos:[], vence:hp, prueba:{ desde:hoy, hasta:hp }, ia:undefined, correcciones:undefined }; }
    if (borrar || id !== s.empresa || !prev || R === 'consulta') no();
    return { ...d, pagos:prev.pagos, vence:prev.vence, creado:prev.creado, nit:prev.nit, suspendida:prev.suspendida, trabajadoresActivos:prev.trabajadoresActivos, inicioUso:prev.inicioUso, prueba:prev.prueba, ia:prev.ia, correcciones:prev.correcciones };
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
/* Créditos de IA: pago único, se suman a los vigentes y todos vencen 30 días después de la última compra */
async function aplicarCreditosIA(reg, rp, cid, k, [n, precio]){
  const re = 'empresas/' + cid; await refrescarEmpresas(cid); const e0 = doc(re);
  if (!e0 || reg.valor < precio || !tienePagos(e0)){ await poner(rp, { ...reg, estado:'revisar', motivo:!e0 ? 'La empresa no existe' : reg.valor < precio ? 'El valor no cubre el paquete de IA (' + precio + ')' : 'La empresa aún no ha pagado su primera mensualidad' }); correoA(CORREO_DUENO, 'Centinela-IA SST: compra de IA para revisar', `<p>Pago ${esc(reg.pago_id)} de $${reg.valor.toLocaleString('es-CO')} (${esc(k)}) para revisar en el panel.</p>`); return { ok:true, estado:'revisar' }; }
  const hoy = HOY(); const vence = (() => { const d = new Date(hoy + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + 30); return d.toISOString().slice(0, 10); })();
  const aplicar = (e, maxRec) => { const ia0 = e.ia && e.ia.vence >= hoy ? Number(e.ia.creditos || 0) : 0; const recibo = 'RC-' + hoy.slice(0, 4) + '-' + String(maxRec + 1).padStart(4, '0');
    const pago = { fecha:hoy, meses:0, valor:reg.valor, ref:reg.ref || reg.pago_id, medio:'Bold', por:'Pago en línea con Bold', hasta:e.vence || '', recibo, pago_id:reg.pago_id, concepto:'Créditos de IA: ' + n + ' consultas' };
    return { e2:{ ...e, ia:{ creditos:ia0 + n, vence, compras:Number(e.ia?.compras || 0) + 1, ultima:hoy }, pagos:[...(e.pagos || []), pago] }, pago }; };
  let out;
  if (pool){
    const c = await pool.connect();
    try {
      await c.query('begin'); await c.query('select pg_advisory_xact_lock(4242)');
      if ((await c.query('select 1 from docs where ruta = $1', [rp])).rows.length){ await c.query('rollback'); return { ok:true, estado:'aplicado' }; }
      const e = (await c.query('select datos from docs where ruta = $1 for update', [re])).rows[0]?.datos || e0; const pre = 'RC-' + hoy.slice(0, 4) + '-';
      const mx = (await c.query(`select coalesce(max(substring(p->>'recibo' from $1)::int), 0) n from docs d, jsonb_array_elements(coalesce(d.datos->'pagos','[]'::jsonb)) p where d.coleccion = 'empresas' and p->>'recibo' like $2`, ['^' + pre + '([0-9]+)$', pre + '%'])).rows[0].n;
      out = aplicar(e, Number(mx));
      await c.query('update docs set datos = $2, actualizado = now() where ruta = $1', [re, out.e2]);
      await c.query(`insert into docs (ruta, coleccion, empresa, datos, actualizado) values ($1,'boldpagos',null,$2,now())`, [rp, { ...reg, estado:'aplicado', recibo:out.pago.recibo, creditos:n }]);
      await c.query('commit');
    } catch(x){ await c.query('rollback').catch(() => {}); throw x; } finally { c.release(); }
    DOCS.set(re, { data:out.e2, ts:tic() }); DOCS.set(rp, { data:{ ...reg, estado:'aplicado', recibo:out.pago.recibo, creditos:n }, ts:tic() });
  } else {
    const pre = 'RC-' + hoy.slice(0, 4) + '-'; let mx = 0; coleccion('empresas').forEach(e => (e.pagos || []).forEach(x => { if (String(x.recibo || '').startsWith(pre)) mx = Math.max(mx, parseInt(x.recibo.slice(pre.length), 10) || 0); }));
    out = aplicar(e0, mx); await poner(re, out.e2); await poner(rp, { ...reg, estado:'aplicado', recibo:out.pago.recibo, creditos:n });
  }
  correoA(e0.correo, 'Centinela-IA SST: créditos de IA cargados', `<p>Recibimos el pago de <b>${esc(e0.razon)}</b> por $${reg.valor.toLocaleString('es-CO')} (Bold, recibo ${out.pago.recibo}). Quedaron cargadas <b>${n} consultas</b> del asistente con IA, vigentes hasta el ${vence}.</p>`);
  return { ok:true, estado:'aplicado', recibo:out.pago.recibo };
}
/* Filtro de tema sin IA: solo llegan a la IA preguntas del SG-SST (o seguimientos cortos de una conversación que ya era del tema) */
const PALABRAS_SST = /seguridad|salud|trabaj|sst|sg-?sst|riesg|peligr|accident|incident|incapacid|ausent|enfermedad|m[eé]dic|examen|ex[aá]menes|evaluaci|aptitud|restricci|reintegr|copasst|vig[ií]a|comit|convivencia|acoso|brigad|emergenc|simulacr|evacu|extintor|botiqu|epp|protecci[oó]n|casco|guante|arn[eé]s|altura|confinad|caliente|el[eé]ctric|qu[ií]mic|sustanc|fds|ruido|ilumin|ergonom|postur|osteomusc|psicosoc|estr[eé]s|bater[ií]a|tamiz|vigilancia|pesv|vial|veh[ií]cul|conduct|capacit|inducci|curso|norma|decreto|resoluci|ley |ministerio|arl|eps|furat|investigaci|matriz|gtc|est[aá]ndar|indicador|auditor|plan anual|pol[ií]tica|objetiv|presupuest|acci[oó]n (correctiva|preventiva|de mejora)|acpm|inspecci|lista de chequeo|contratist|document|acta|informe|permiso|ats|profesiograma|cargo|empleador|empresa|sanci[oó]n|multa|pausas activas|tarea|pendiente|vence/i;
function temaSST(msgs){
  const ult = msgs[msgs.length - 1]?.content || ''; if (PALABRAS_SST.test(ult)) return true;
  const previa = msgs.slice(0, -1).some(m => m.role === 'assistant'); return previa && ult.length <= 120 && msgs.slice(1, -1).some(m => m.role === 'user' && PALABRAS_SST.test(m.content)); /* el primer mensaje son las reglas del asistente */
}
/* Asistente con IA: reserva 1 crédito antes de llamar a Anthropic y lo devuelve si la llamada falla; tope mensual de gasto de la plataforma */
async function consultarIA(s, b){
  if (s.t !== 'u' || s.cerrada || !s.empresa) throw { status:403, code:'forbidden', message:'No tiene permiso para usar el asistente.' };
  if (!ANTHROPIC_KEY) throw { status:503, code:'ia_no_config', message:'El asistente con IA aún no está activo. Escríbanos por WhatsApp 304 437 5758.' };
  const msgs = (Array.isArray(b.mensajes) ? b.mensajes : []).slice(-12).map(m => ({ role:m.role === 'assistant' ? 'assistant' : 'user', content:String(m.content || '').slice(0, 12000) })).filter(m => m.content);
  while (msgs.length && msgs[0].role !== 'user') msgs.shift();
  if (!msgs.length) throw { status:400, code:'invalid_argument', message:'Escriba su pregunta.' };
  if (!temaSST(msgs)) return { text:'Esa pregunta no parece ser de seguridad y salud en el trabajo. El asistente solo responde temas del SG-SST de su empresa, así que no se descontó ningún crédito. Pregunte, por ejemplo, por accidentes, exámenes médicos, comités, riesgos, capacitaciones o normas.', creditos:null, fueraDeTema:true }; // (directiva 20 oct 2026) filtro propio sin IA ni costo
  if (msgs.reduce((n, m) => n + m.content.length, 0) > 40000) throw { status:400, code:'prompt_too_large', message:'La consulta es demasiado larga.' };
  const mes = HOY().slice(0, 7); const uso = doc('iauso/' + mes) || { usd:0, consultas:0 };
  if (uso.usd >= IA_TOPE_USD) throw { status:429, code:'ia_tope', message:'El asistente alcanzó el límite de uso de este mes. Intente de nuevo el próximo mes o escríbanos por WhatsApp 304 437 5758.' };
  if (frenar('ia:' + s.empresa, 30, 10)) throw { status:429, code:'rate_limited', message:'Demasiadas consultas seguidas. Espere unos minutos.' }; fallo('ia:' + s.empresa);
  const re = 'empresas/' + s.empresa;
  const mover = n => enCola(async () => { await refrescarEmpresas(s.empresa); const e = doc(re); const hoy = HOY(); const disp = e?.ia && e.ia.vence >= hoy ? Number(e.ia.creditos || 0) : 0;
    if (n < 0 && disp < 1) throw { status:402, code:'sin_creditos', message:'Su empresa no tiene créditos de IA. El administrador SG-SST los puede comprar en el menú Asistente IA.' };
    await poner(re, { ...e, ia:{ ...(e.ia || {}), creditos:disp + n } }); return disp + n; });
  const quedan = await mover(-1);
  let j;
  try {
    const r = await fetch(IA_URL, { method:'POST', headers:{ 'x-api-key':ANTHROPIC_KEY, 'anthropic-version':'2023-06-01', 'content-type':'application/json' }, body:JSON.stringify({ model:IA_MODELO, max_tokens:1500, messages:msgs }), signal:AbortSignal.timeout(60000) });
    j = await r.json().catch(() => null); if (!r.ok || !j) throw new Error('ia ' + r.status + ' ' + JSON.stringify(j || {}).slice(0, 200));
  } catch(x){ console.error('IA:', x.message); await mover(1).catch(() => {}); throw { status:502, code:'ia_error', message:'El asistente no respondió. No se descontó el crédito. Intente de nuevo.' }; }
  const text = (j.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n').trim();
  const usd = ((j.usage?.input_tokens || 0) * IA_PRECIO_IN + (j.usage?.output_tokens || 0) * IA_PRECIO_OUT) / 1e6;
  await enCola(() => { const u0 = doc('iauso/' + mes) || { usd:0, consultas:0 }; return poner('iauso/' + mes, { usd:Math.round((u0.usd + usd) * 1e6) / 1e6, consultas:(u0.consultas || 0) + 1, actualizado:new Date().toISOString() }); });
  if (uso.usd + usd >= IA_TOPE_USD * 0.8 && uso.usd < IA_TOPE_USD * 0.8) correoA(CORREO_DUENO, 'Centinela-IA SST: la IA llegó al 80 % del tope del mes', `<p>Gasto de IA de ${mes}: US$${(uso.usd + usd).toFixed(2)} de US$${IA_TOPE_USD}.</p>`);
  return { text:text || '(Sin respuesta)', creditos:quedan };
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
  const pIA = IA_PLANES[plan.slice(10)];
  if (pIA) return aplicarCreditosIA(reg, rp, cid, plan.slice(10), pIA);
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

/* ---------- utilidades http ---------- */
function cors(req, res){
  const o = req.headers.origin; const ok = ORIGENES.includes('*') ? '*' : (o && ORIGENES.includes(o) ? o : ORIGENES[0]);
  res.setHeader('Access-Control-Allow-Origin', ok); res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization'); res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
}
const enviar = (res, status, obj) => { res.writeHead(status, { 'Content-Type':'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };
const leerCuerpo = req => new Promise((ok, no) => { let b = ''; req.on('data', c => { b += c; if (b.length > 8e6){ no({ status:413, code:'too_large', message:'Archivo demasiado grande.' }); req.destroy(); } }); req.on('end', () => { try { ok(b ? JSON.parse(b) : {}); } catch(e){ no({ status:400, code:'invalid_argument', message:'Datos no válidos.' }); } }); });
const ip = req => { const x = String(req.headers['x-forwarded-for'] || '').split(',').map(t => t.trim()).filter(Boolean); return x.length ? x[x.length - 1] : (req.socket.remoteAddress || ''); }; // la última la pone el proxy de Render; las primeras las puede inventar el cliente

/* ---------- correo diario (Brevo) ---------- */
const HOY = () => new Intl.DateTimeFormat('en-CA', { timeZone:'America/Bogota' }).format(new Date());
const finMes = iso => { const d = new Date(iso + 'T12:00:00Z'); d.setUTCMonth(d.getUTCMonth() + 1, 0); return d.toISOString().slice(0, 10); };
const dias = (iso, hoy) => Math.round((new Date(iso + 'T12:00:00') - new Date(hoy + 'T12:00:00')) / 864e5);
/* Regla de cobro de SkyNet Genesis (oct 2026): "Pagado hasta" fin de mes; si no se paga, el acceso se cierra el día 5
   del mes siguiente (sin cuenta regresiva). Prueba gratis de 15 días: se cierra al terminar si no se paga. Lo aplica el servidor. */
const pagadoHasta = e => e.vence || finMes(String(e.creado?.en || e.creado || HOY()).slice(0, 10));
const tienePagos = e => (e.pagos || []).some(x => Number(x.valor || 0) > 0);
const enPrueba = e => !!(e && e.prueba?.hasta && !e.prueba.cerrada && !tienePagos(e)); // una cortesía o un "Pagado hasta" del Superadministrador cierra la prueba
const cerrada = e => !e || !!e.suspendida || (enPrueba(e) ? dias(e.prueba.hasta, HOY()) < 0 : dias(pagadoHasta(e), HOY()) <= -5);
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
  const L = c => coleccion('e/' + cid + '/' + c); const out = [];
  const add = (f, t) => { if (f && dias(f, hoy) <= 7) out.push([f, t]); };
  L('tareas').filter(t => t.estado !== 'cumplida').forEach(t => add(t.vence, 'Tarea: ' + t.texto + (t.responsable ? ' (' + t.responsable + ')' : '')));
  L('acpm').filter(a => a.estado !== 'cerrada').forEach(a => add(a.vence, 'Acción ' + (a.codigo || '') + ': ' + a.accion));
  L('vehiculos').forEach(v => { add(v.soat, 'SOAT del vehículo ' + v.placa); if (!v.rtmNoAplica) add(v.rtm, 'Revisión técnico-mecánica del vehículo ' + v.placa); });
  L('conductores').forEach(c => add(c.vence, 'Licencia de conducción de un conductor'));
  L('contratistas').filter(c => !c.fin || c.fin >= hoy).forEach(c => add(c.docs?.arl?.vence, 'ARL del contratista ' + c.nombre));
  L('documentos').filter(d => d.estado === 'aprobado').forEach(d => add(d.revision, 'Revisión del documento ' + d.codigo));
  L('accidentes').filter(a => a.tipo !== 'Incidente' && !a.reporteARL).forEach(a => out.push([a.fecha, 'Accidente sin reporte a la ARL (FURAT)']));
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
    if (p === '/api/estado') return enviar(res, 200, { hayUsuarios:coleccion('usuarios').length > 0, epoch:EPOCH });
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
      if (u2.activo === false) return enviar(res, 403, { code:'inactivo', message:'Este usuario está desactivado. Hable con el administrador de su empresa.' });
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
      if (!CLAVE_CRON || u.searchParams.get('clave') !== CLAVE_CRON) return enviar(res, 403, { code:'forbidden' });
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
      if (us && us.correo && !frenar('ru:' + us.id, 3, 60)){
        fallo('ru:' + us.id);
        const t = firmar({ t:'r', uid:us.id, h:huellaClave(us) }, 60 * 60e3);
        correo(us.correo, 'Centinela-IA SST: cambie su contraseña', `<p>Hola, ${esc(us.nombre)}.</p><p>Recibimos una solicitud para cambiar la contraseña del usuario <b>${esc(us.usuario)}</b>. El enlace sirve durante 1 hora y una sola vez.</p><p><a href="${URL_APP}/#recuperar=${t}" style="background:#0B4F8A;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none">Cambiar mi contraseña</a></p><p>Si usted no la pidió, ignore este correo; su contraseña sigue igual.</p>`).catch(() => {});
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
    if (p === '/api/ia' && req.method === 'POST') return enviar(res, 200, await consultarIA(s, await leerCuerpo(req)));
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
