// Robot de PDF oficiales de SUNAT para INTAXIS.
//   node worker.mjs               → trabaja en bucle (pide pedidos, baja los PDF, los entrega)
//   node worker.mjs --una-vez     → una sola vuelta (útil para probar)
//   node worker.mjs --calibrar    → igual, pero guarda capturas y listas de campos de cada pantalla en ./calibracion
import fs from 'node:fs';
import { chromium } from 'playwright';
import { entrar, bajarPdf, volcar, salir, ErrCredencial, ErrSinCalibrar, ErrNoEncontrado, ErrTransitorio } from './motor.mjs';

const URL_FN = process.env.INTAXIS_URL;               // https://<proyecto>.supabase.co/functions/v1/robot-sunat
const TOKEN = process.env.ROBOT_SUNAT_TOKEN;
const WORKER = process.env.ROBOT_NOMBRE || 'robot-1';
const PAUSA = Math.max(5, Number(process.env.INTERVALO_SEG) || 20) * 1000;
const ENTRE_PEDIDOS = Math.max(3, Number(process.env.ENTRE_PEDIDOS_SEG) || 5) * 1000;
const CALIBRAR = process.argv.includes('--calibrar'), UNA_VEZ = process.argv.includes('--una-vez') || CALIBRAR;
const CFG = JSON.parse(fs.readFileSync(process.env.PASOS || new URL('./pasos.json', import.meta.url), 'utf8'));
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString(), ...a);   // NUNCA se registran usuarios ni claves

if (!URL_FN || !TOKEN) { console.error('Faltan INTAXIS_URL y ROBOT_SUNAT_TOKEN.'); process.exit(1); }

async function api(accion, cuerpo = {}) {
  const r = await fetch(URL_FN, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-robot-token': TOKEN }, body: JSON.stringify({ accion, ...cuerpo }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`INTAXIS respondió ${r.status}: ${j.error || 'sin detalle'}`);
  return j;
}
const fallo = (id, error, extra = {}) => api('fallo', { pedido_id: id, error, ...extra }).catch((e) => log('No pude reportar el fallo:', e.message));

async function atender(browser, lote) {
  // Un navegador limpio por empresa (sin cookies de otras) y una sola entrada a SOL para todos sus pedidos
  const nuevo = async () => { const c = await browser.newContext({ acceptDownloads: true, locale: 'es-PE', viewport: { width: 1366, height: 900 } }); return [c, await c.newPage()]; };
  let [ctx, page] = await nuevo();
  const { ruc, usuario, clave } = lote[0];
  try {
    try { await entrar(page, CFG, { ruc }, usuario, clave); }
    catch (e) {
      // Un rechazo de clave desactiva la cuenta: se confirma con un segundo intento en un navegador limpio antes de hacerlo
      if (!(e instanceof ErrCredencial)) throw e;
      log(`Empresa ${ruc}: SOL no aceptó el ingreso (${e.message}). Confirmo con un segundo intento…`);
      await salir(page); await ctx.close().catch(() => {}); await dormir(8000);
      [ctx, page] = await nuevo();
      await entrar(page, CFG, { ruc }, usuario, clave);
    }
    log(`Empresa ${ruc}: ingresó a SOL (${lote.length} pedido/s)`);
  } catch (e) {
    const cred = e instanceof ErrCredencial;
    log(`Empresa ${ruc}: ${cred ? 'SUNAT RECHAZÓ LA CLAVE dos veces (cuenta desactivada, sin reintentos). ' + e.message : 'no pudo ingresar: ' + e.message}`);
    if (CALIBRAR) await volcar(page, './calibracion', 'ingreso-sin-resultado').catch(() => {});   // captura de lo que mostró SOL, para ajustar el robot
    for (const p of lote) await fallo(p.id, e.message, { credencial_mala: cred, reintentable: !cred });
    await salir(page); await ctx.close().catch(() => {}); return;
  }
  let primero = true;
  for (const p of lote) {
    try {
      const pdf = await bajarPdf(page, ctx, CFG, p, { calibrar: CALIBRAR, desdeInicio: !primero });
      primero = false;
      await api('subir', { pedido_id: p.id, pdf_b64: pdf.toString('base64') });
      log(`Pedido ${p.id.slice(0, 8)} (${p.clase} ${p.serie}-${p.numero}): PDF entregado (${pdf.length} bytes)`);
    } catch (e) {
      primero = false;
      const reint = e instanceof ErrTransitorio, definitivo = e instanceof ErrNoEncontrado || e instanceof ErrSinCalibrar;
      log(`Pedido ${p.id.slice(0, 8)} (${p.clase} ${p.serie}-${p.numero}): ${e.message}`);
      if (!definitivo && !reint) log('  (error no previsto; se reintenta)');
      await fallo(p.id, e.message, { reintentable: !definitivo });
      if (CALIBRAR) await page.screenshot({ path: `./calibracion/error-${p.id.slice(0, 8)}.png`, fullPage: true }).catch(() => {});
    }
    await dormir(ENTRE_PEDIDOS);
  }
  await salir(page); await ctx.close().catch(() => {});
}

async function vuelta(browser) {
  const { pedidos } = await api('tomar', { limite: 5, worker: WORKER });
  if (!pedidos.length) return 0;
  const porEmpresa = new Map();
  for (const p of pedidos) porEmpresa.set(p.empresa_id, [...(porEmpresa.get(p.empresa_id) || []), p]);
  for (const lote of porEmpresa.values()) await atender(browser, lote);
  return pedidos.length;
}

// NAVEGADOR=chrome (o msedge) usa el Chrome/Edge ya instalado en el equipo y evita descargar el Chromium de Playwright.
const opcionesNav = { headless: process.env.HEADLESS !== '0' };
if (process.env.NAVEGADOR) opcionesNav.channel = process.env.NAVEGADOR;
const browser = await chromium.launch(opcionesNav);
log(`Robot ${WORKER} listo${CALIBRAR ? ' (MODO CALIBRACIÓN)' : ''}.`);
for (;;) {
  try { const n = await vuelta(browser); if (UNA_VEZ) { if (!n) log('No hay pedidos en cola. En INTAXIS abre un comprobante sin PDF, pulsa «Bajar PDF oficial» y vuelve a ejecutar este comando.'); break; } if (!n) await dormir(PAUSA); }
  catch (e) { log('Error en la vuelta:', e.message); if (UNA_VEZ) break; await dormir(PAUSA * 3); }
}
await browser.close();
