/* Centinela SST · servidor (Render + Neon). Una aplicación de SkyNet Genesis.
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
    pool = new Pool({ connectionString:DB_URL, ssl: /localhost|127\.0\.0\.1/.test(DB_URL) ? false : { rejectUnauthorized:false }, max:3, idleTimeoutMillis:10000 });
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
async function poner(ruta, data){ await persistir(ruta, data); DOCS.set(ruta, { data, ts:tic() }); BORRADOS.delete(ruta); }
async function quitar(ruta){ await persistir(ruta, null); DOCS.delete(ruta); BORRADOS.set(ruta, tic()); }
const doc = ruta => DOCS.get(ruta)?.data;
const coleccion = col => [...DOCS.entries()].filter(([k]) => partes(k)[0] === col).map(([k, v]) => ({ id:partes(k)[1], ...v.data }));

/* ---------- sesiones firmadas ---------- */
const b64 = s => Buffer.from(s).toString('base64url');
function firmar(p){ const c = b64(JSON.stringify({ ...p, exp:Date.now() + 12 * 3600e3 })); return c + '.' + crypto.createHmac('sha256', SECRETO).update(c).digest('base64url'); }
function leerToken(t){
  if (!t) return null; const [c, f] = String(t).split('.'); if (!c || !f) return null;
  const ok = crypto.createHmac('sha256', SECRETO).update(c).digest('base64url');
  if (ok.length !== f.length || !crypto.timingSafeEqual(Buffer.from(ok), Buffer.from(f))) return null;
  const p = JSON.parse(Buffer.from(c, 'base64url').toString()); if (p.exp < Date.now()) return null; return p;
}
const hashClave = (clave, sal) => crypto.pbkdf2Sync(String(clave), String(sal), 120000, 32, 'sha256').toString('hex');
function sesion(req){
  const p = leerToken((req.headers.authorization || '').replace(/^Bearer\s+/i, '')); if (!p) return null;
  if (p.t === 'u'){ const u = doc('usuarios/' + p.uid); if (!u || u.activo === false) return null; return { t:'u', uid:p.uid, rol:u.rol, empresa:u.empresa, nombre:u.nombre }; }
  if (p.t === 'w'){ const t = doc('e/' + p.cid + '/trabajadores/' + p.tid); if (!t || t.estado === 'retirado') return null; return { t:'w', cid:p.cid, tid:p.tid }; }
  return null;
}

/* ---------- límites de intentos ---------- */
const INTENTOS = new Map();
function frenar(clave, max, ventanaMin){ const ahora = Date.now(); const a = (INTENTOS.get(clave) || []).filter(x => ahora - x < ventanaMin * 60e3); INTENTOS.set(clave, a); return a.length >= max; }
const fallo = clave => INTENTOS.set(clave, [...(INTENTOS.get(clave) || []), Date.now()]);

/* ---------- permisos ---------- */
const CLIN = new Set(['hc','tamizajes','casos','autoreportes','bateriaInd']);
const PORTAL_PROPIOS = new Set(['evaluaciones','tamizajes','cursosRes','epp','reportes','autoreportes']);
const PORTAL_TODOS = new Set(['cargos','cursos','capacitaciones']);
const esClin = r => r === 'medico' || r === 'psicologo';
function puedeLeer(s, ruta, d){
  const [col, id] = partes(ruta);
  if (s.t === 'w'){
    if (ruta === 'empresas/' + s.cid || ruta === 'plataforma/config') return true;
    const cid = empresaDe(ruta); if (cid !== s.cid) return false; const c = col.split('/')[2];
    if (c === 'trabajadores') return id === s.tid;
    if (PORTAL_TODOS.has(c)) return true;
    if (PORTAL_PROPIOS.has(c)) return d && d.trabajador === s.tid;
    return false;
  }
  if (col === 'usuarios') return s.rol === 'super' || (d && d.empresa === s.empresa) || id === s.uid;
  if (col === 'empresas') return s.rol === 'super' || id === s.empresa;
  if (col === 'plataforma' || col === 'normas') return true;
  if (col === 'soporte') return s.rol === 'super' || (d && d.empresa === s.empresa);
  const cid = empresaDe(ruta); if (!cid) return false;
  if (s.rol !== 'super' && cid !== s.empresa) return false;
  const c = col.split('/')[2];
  if (CLIN.has(c)) return esClin(s.rol);
  if (c === 'quejas') return ['admin','psicologo','super'].includes(s.rol);
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
    if (c === 'capacitaciones'){ if (!prev) no(); const a0 = prev.asistentes || [], a1 = d.asistentes || []; if (!iguales(sinCampos(prev, ['asistentes']), sinCampos(d, ['asistentes'])) || !iguales([...a0, s.tid], a1)) no(); return d; }
    if (prev) no();
    if (['tamizajes','cursosRes','autoreportes'].includes(c)){ if (d.trabajador !== s.tid) no(); return d; }
    if (c === 'reportes'){ if (d.trabajador && d.trabajador !== s.tid) no(); return d; }
    if (c === 'tareas'){ if (d.trabajador !== s.tid) no(); return d; }
    if (c === 'casos'){ if (d.trabajador !== s.tid) no(); return { __caso:true, ...d }; }
    no();
  }
  const R = s.rol;
  if (col === 'usuarios'){
    if (borrar){ if (R !== 'super') no(); return null; }
    const otro = coleccion('usuarios').find(u => u.usuario === d.usuario && u.id !== id); if (otro) throw { status:409, code:'usuario_existe', message:'Ese usuario ya existe. Elija otro.' };
    const base = { ...d }; if (!base.hash && prev?.hash){ base.sal = prev.sal; base.hash = prev.hash; }
    if (R === 'super') return base;
    if (R === 'admin' && d.empresa === s.empresa && d.rol !== 'super' && (!prev || prev.empresa === s.empresa)) return base;
    if (id === s.uid && prev) return { ...base, rol:prev.rol, empresa:prev.empresa, activo:prev.activo, usuario:prev.usuario };
    no();
  }
  if (col === 'empresas'){
    if (R === 'super') return borrar ? null : d;
    if (borrar || id !== s.empresa || !prev || R === 'consulta') no();
    return { ...d, pagos:prev.pagos, vence:prev.vence, creado:prev.creado, nit:prev.nit };
  }
  if (col === 'plataforma' || col === 'normas'){ if (R !== 'super') no(); return borrar ? null : d; }
  if (col === 'soporte'){
    if (R === 'super') return borrar ? null : d;
    if (borrar || d.empresa !== s.empresa || (prev && prev.empresa !== s.empresa)) no(); return d;
  }
  const cid = empresaDe(ruta); if (!cid || !doc('empresas/' + cid)) no();
  if (R !== 'super' && cid !== s.empresa) no();
  const c = col.split('/')[2];
  if (c === 'bitacora') return borrar ? no() : d;
  if (R === 'consulta') no();
  if (CLIN.has(c) && !esClin(R) && R !== 'super') no(); // el súper solo escribe (empresa de ejemplo), nunca lee lo clínico
  if (c === 'quejas' && !['admin','psicologo','super'].includes(R)) no();
  return borrar ? null : d;
}
async function guardar(s, ruta, d){
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
  return poner(ruta, r);
}

/* ---------- utilidades http ---------- */
function cors(req, res){
  const o = req.headers.origin; const ok = ORIGENES.includes('*') ? '*' : (o && ORIGENES.includes(o) ? o : ORIGENES[0]);
  res.setHeader('Access-Control-Allow-Origin', ok); res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization'); res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
}
const enviar = (res, status, obj) => { res.writeHead(status, { 'Content-Type':'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };
const leerCuerpo = req => new Promise((ok, no) => { let b = ''; req.on('data', c => { b += c; if (b.length > 8e6){ no({ status:413, code:'too_large', message:'Archivo demasiado grande.' }); req.destroy(); } }); req.on('end', () => { try { ok(b ? JSON.parse(b) : {}); } catch(e){ no({ status:400, code:'invalid_argument', message:'Datos no válidos.' }); } }); });
const ip = req => (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();

/* ---------- correo diario (Brevo) ---------- */
const HOY = () => new Intl.DateTimeFormat('en-CA', { timeZone:'America/Bogota' }).format(new Date());
const dias = (iso, hoy) => Math.round((new Date(iso + 'T12:00:00') - new Date(hoy + 'T12:00:00')) / 864e5);
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
  const hoy = HOY(); const res = [];
  for (const e of coleccion('empresas')){
    const p = pendientesEmpresa(e.id, hoy); if (!p.length || !e.correo) { res.push({ empresa:e.razon, pendientes:p.length, enviado:false }); continue; }
    const venc = p.filter(x => dias(x[0], hoy) < 0).length;
    const html = `<div style="font-family:Arial,sans-serif;color:#15232B;max-width:620px"><div style="background:#1E3A4C;color:#fff;padding:14px 18px;border-radius:8px 8px 0 0"><b style="font-size:18px">Centinela SST</b><br><span style="font-size:13px">${e.razon}</span></div>
      <div style="border:1px solid #D2DBDA;border-top:0;padding:16px 18px;border-radius:0 0 8px 8px"><p>Tiene <b>${venc}</b> pendientes vencidos y <b>${p.length - venc}</b> que vencen en los próximos 7 días:</p><ul>${p.slice(0, 40).map(([f, t]) => `<li style="margin:4px 0"><b style="color:${dias(f, hoy) < 0 ? '#B93A27' : '#946A00'}">${f}</b> · ${t.replace(/</g, '&lt;')}</li>`).join('')}</ul>
      <p><a href="${URL_APP}" style="background:#1E3A4C;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none">Abrir Centinela SST</a></p><p style="font-size:12px;color:#56676F">Centinela SST · Una aplicación de SkyNet Genesis · contacto@skynetgenesis.com · WhatsApp 304 437 5758</p></div></div>`;
    let enviado = false;
    if (BREVO_KEY && CORREO_REMITENTE){
      try { const r = await fetch('https://api.brevo.com/v3/smtp/email', { method:'POST', headers:{ 'api-key':BREVO_KEY, 'Content-Type':'application/json', accept:'application/json' }, body:JSON.stringify({ sender:{ name:'Centinela SST', email:CORREO_REMITENTE }, to:[{ email:e.correo, name:e.razon }], subject:`Centinela SST: ${venc} vencidos y ${p.length - venc} por vencer`, htmlContent:html }) }); enviado = r.ok; } catch(err){ enviado = false; }
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
    if (p === '/' || p === '/api/ping') return enviar(res, 200, { ok:true, app:'Centinela SST', hora:new Date().toISOString() });
    if (p === '/api/estado') return enviar(res, 200, { hayUsuarios:coleccion('usuarios').length > 0, epoch:EPOCH });
    if (p === '/api/setup' && req.method === 'POST'){
      if (coleccion('usuarios').length) return enviar(res, 409, { code:'ya_configurado', message:'La plataforma ya tiene administrador.' });
      const b = await leerCuerpo(req); if (!b.usuario || !b.sal || !b.hash || !b.nombre) return enviar(res, 400, { code:'invalid_argument' });
      const uid = 'u' + crypto.randomBytes(8).toString('hex');
      await poner('usuarios/' + uid, { usuario:String(b.usuario).toLowerCase(), nombre:b.nombre, rol:'super', empresa:null, sal:b.sal, hash:b.hash, activo:true, creado:new Date().toISOString() });
      return enviar(res, 200, { token:firmar({ t:'u', uid }), uid });
    }
    if (p === '/api/login' && req.method === 'POST'){
      const b = await leerCuerpo(req); const us = String(b.usuario || '').trim().toLowerCase(); const k = 'l:' + ip(req) + ':' + us;
      if (frenar(k, 8, 15)) return enviar(res, 429, { code:'rate_limited', message:'Demasiados intentos. Espere 15 minutos.' });
      const u2 = coleccion('usuarios').find(x => x.usuario === us);
      if (!u2 || hashClave(b.clave || '', u2.sal) !== u2.hash){ fallo(k); return enviar(res, 401, { code:'credenciales', message:'Usuario o contraseña incorrectos.' }); }
      if (u2.activo === false) return enviar(res, 403, { code:'inactivo', message:'Este usuario está desactivado. Hable con el administrador de su empresa.' });
      return enviar(res, 200, { token:firmar({ t:'u', uid:u2.id }), uid:u2.id });
    }
    if (p === '/api/portal/login' && req.method === 'POST'){
      const b = await leerCuerpo(req); const nit = String(b.nit || '').replace(/\D/g, ''), dc = String(b.doc || '').replace(/\s/g, ''), cod = String(b.cod || '').trim(); const k = 'w:' + nit + ':' + dc;
      if (frenar(k, 5, 60) || frenar('wip:' + ip(req), 30, 60)) return enviar(res, 429, { code:'rate_limited', message:'Demasiados intentos. Espere una hora o pida ayuda al área de SST.' });
      const e = coleccion('empresas').find(x => String(x.nit) === nit);
      if (!e){ fallo(k); fallo('wip:' + ip(req)); return enviar(res, 404, { code:'empresa', message:'No encontramos una empresa con ese NIT.' }); }
      if (e.vence && e.vence < HOY() && dias(e.vence, HOY()) < -5) return enviar(res, 403, { code:'bloqueada', message:'El servicio de su empresa no está activo en este momento.' });
      const t = coleccion('e/' + e.id + '/trabajadores').find(x => String(x.documento) === dc && String(x.codigo) === cod && x.estado !== 'retirado');
      if (!t){ fallo(k); fallo('wip:' + ip(req)); return enviar(res, 401, { code:'credenciales', message:'El documento o el código no coinciden. Pida su código al área de SST.' }); }
      return enviar(res, 200, { token:firmar({ t:'w', cid:e.id, tid:t.id }), cid:e.id, tid:t.id });
    }
    if (p === '/api/cron/diario'){
      if (!CLAVE_CRON || u.searchParams.get('clave') !== CLAVE_CRON) return enviar(res, 403, { code:'forbidden' });
      return enviar(res, 200, { ok:true, resultado:await correoDiario() });
    }
    const s = sesion(req); if (!s) return enviar(res, 401, { code:'sesion', message:'Inicie sesión de nuevo.' });
    if (p === '/api/sync'){
      const since = Number(u.searchParams.get('since') || 0); const mismo = u.searchParams.get('epoch') === EPOCH; const desde = mismo ? since : 0;
      const cambios = [];
      DOCS.forEach((v, ruta) => { if (v.ts > desde && puedeLeer(s, ruta, v.data)) cambios.push({ ruta, data:partes(ruta)[0] === 'usuarios' ? limpiarUsuario(v.data) : v.data }); });
      if (mismo) BORRADOS.forEach((ts, ruta) => { if (ts > desde) cambios.push({ ruta, data:null }); });
      return enviar(res, 200, { epoch:EPOCH, ahora:RELOJ, completo:!mismo || !since, cambios });
    }
    if (p === '/api/doc' && req.method === 'PUT'){
      const b = await leerCuerpo(req); if (!b.ruta || !b.data || typeof b.data !== 'object') return enviar(res, 400, { code:'invalid_argument' });
      await guardar(s, b.ruta, b.data); return enviar(res, 200, { ok:true, ahora:RELOJ });
    }
    if (p === '/api/doc' && req.method === 'DELETE'){
      const ruta = u.searchParams.get('ruta') || ''; revisarEscritura(s, ruta, null, true); await quitar(ruta); return enviar(res, 200, { ok:true });
    }
    if (p === '/api/clave' && req.method === 'POST'){
      if (s.t !== 'u') return enviar(res, 403, { code:'forbidden' }); const b = await leerCuerpo(req); const us = doc('usuarios/' + s.uid);
      if (hashClave(b.actual || '', us.sal) !== us.hash) return enviar(res, 400, { code:'clave_actual', message:'La contraseña actual no es correcta.' });
      const n = String(b.nueva || ''); if (n.length < 8 || !/[a-zA-Z]/.test(n) || !/\d/.test(n)) return enviar(res, 400, { code:'clave_debil', message:'La nueva contraseña debe tener mínimo 8 caracteres, con letras y números.' });
      const sal = crypto.randomBytes(12).toString('hex'); await poner('usuarios/' + s.uid, { ...us, sal, hash:hashClave(n, sal), cambiarClave:false }); return enviar(res, 200, { ok:true });
    }
    return enviar(res, 404, { code:'not_found' });
  } catch(e){
    if (e && e.status) return enviar(res, e.status, { code:e.code, message:e.message });
    console.error(e); return enviar(res, 500, { code:'error', message:'Error del servidor.' });
  }
});
iniciarBD().then(() => server.listen(PORT, () => console.log('Centinela SST escuchando en el puerto', PORT))).catch(e => { console.error('No se pudo iniciar la base de datos', e); process.exit(1); });
