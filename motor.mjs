// Motor del robot: entra a SOL, recorre los pasos de pasos.json y descarga el PDF. No guarda ni imprime claves.
import fs from 'node:fs';
import path from 'node:path';

export class ErrCredencial extends Error {}   // SUNAT rechazó usuario/clave: NO reintentar (SOL bloquea tras varios intentos)
export class ErrSinCalibrar extends Error {}  // faltan pasos en pasos.json para esta clase
export class ErrNoEncontrado extends Error {} // el comprobante no apareció en SUNAT
export class ErrTransitorio extends Error {}  // caída, lentitud, página cambiada: se puede reintentar

const sinTildes = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '');
const re = (txt) => new RegExp(sinTildes(txt).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+'), 'i');
const dma = (f) => (f ? String(f).slice(0, 10).split('-').reverse().join('/') : '');

export function llenarPlantilla(texto, p) {
  const num = String(p.numero ?? '');
  const mapa = { serie: p.serie, numero: num, numero_sin_ceros: num.replace(/^0+(?=\d)/, ''), tipo_sunat: p.tipo_sunat, fecha_dma: dma(p.fecha),
    tipo_etiqueta: { '01': 'Factura', '03': 'Boleta de Venta' }[p.tipo_sunat] || '', ruc_emisor: p.emisor_ruc, ruc_receptor: p.receptor_ruc, total: p.total, ruc: p.ruc };
  return String(texto).replace(/\{(\w+)\}/g, (m, k) => (k in mapa && mapa[k] != null ? String(mapa[k]) : ''));
}

// Busca un elemento en la página y en todos sus marcos (SOL usa iframes)
async function buscar(page, selector, { tiempo = 15000, nth = 0 } = {}) {
  const fin = Date.now() + tiempo;
  while (Date.now() < fin) {
    for (const f of page.frames()) {
      const l = f.locator(selector).nth(nth);
      try { if (await l.count() && await l.isVisible()) return l; } catch { /* marco en navegación */ }
    }
    await page.waitForTimeout(250);
  }
  return null;
}
// Busca por texto visible (sin distinguir tildes ni mayúsculas). Prefiere enlaces y botones; marca el elemento y lo devuelve.
async function buscarTexto(page, texto, { tiempo = 15000, exacto = false, nro = 1 } = {}) {
  const fin = Date.now() + tiempo, fuente = exacto ? '^' + re(texto).source + '$' : re(texto).source;
  while (Date.now() < fin) {
    for (const f of page.frames()) {
      let marcado = false;
      try {
        marcado = await f.evaluate(([src, nro]) => {
          const rx = new RegExp(src, 'i'), n = (t) => t.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim();
          document.querySelectorAll('[data-rb-tmp]').forEach((e) => e.removeAttribute('data-rb-tmp'));
          if (nro > 1) {
            const ok = (e) => e.offsetParent !== null && rx.test(n(e.value || e.innerText || ''));
            const hojas = [...document.querySelectorAll('a,button,label,span,td,li,th,div,p,h1,h2,h3,h4')].filter((e) => ok(e) && ![...e.querySelectorAll('*')].some(ok));
            const el = hojas[nro - 1];
            if (el) { el.setAttribute('data-rb-tmp', '1'); return true; }
            return false;
          }
          for (const grupo of ['a,button,input[type=button],input[type=submit]', 'label,span,td,li,th', 'div,p']) {
            const el = [...document.querySelectorAll(grupo)].filter((e) => e.offsetParent !== null && !e.querySelector('a,button') && rx.test(n(e.value || e.innerText || '')))[nro - 1];
            if (el) { el.setAttribute('data-rb-tmp', '1'); return true; }
          }
          return false;
        }, [fuente, nro]);
      } catch { continue; }
      if (marcado) return f.locator('[data-rb-tmp="1"]').first();
    }
    await page.waitForTimeout(300);
  }
  return null;
}

export async function volcar(page, dir, nombre) {
  // Para calibrar: captura + lista de campos, botones y enlaces de cada marco (nunca incluye valores de campos de clave)
  fs.mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, `${nombre}.png`), fullPage: true }).catch(() => {});
  const marcos = [];
  for (const f of page.frames()) {
    try {
      marcos.push(await f.evaluate(() => ({
        url: location.href.replace(/[?#].*$/, ''), titulo: document.title,
        campos: [...document.querySelectorAll('input,select,textarea')].filter((e) => e.type !== 'password' && e.type !== 'hidden').map((e) => ({ tag: e.tagName, id: e.id, name: e.name, type: e.type, etiqueta: (e.labels?.[0]?.innerText || e.placeholder || e.title || '').trim().slice(0, 60), opciones: e.tagName === 'SELECT' ? [...e.options].slice(0, 25).map((o) => `${o.value}=${o.text.trim()}`) : undefined })),
        botones: [...document.querySelectorAll('button,input[type=button],input[type=submit]')].map((e) => ({ id: e.id, texto: (e.value || e.innerText || '').trim().slice(0, 60) })),
        enlaces: [...document.querySelectorAll('a')].filter((e) => e.offsetParent !== null).map((e) => ({ id: e.id, texto: e.innerText.trim().slice(0, 70), href: (e.getAttribute('href') || '').slice(0, 80) })).filter((e) => e.texto).slice(0, 80),
        hojas: [...document.querySelectorAll('a,button,label,span,td,li,th,div,p,h3,h4')].filter((e) => e.offsetParent !== null && !e.querySelector('*') && (e.innerText || '').trim()).slice(0, 120).map((e) => ({ tag: e.tagName, id: e.id, clase: String(e.className || '').slice(0, 40), texto: e.innerText.trim().slice(0, 70), padre: (e.parentElement?.tagName || '') + (e.parentElement?.className ? '.' + String(e.parentElement.className).slice(0, 30) : '') })),
        texto: document.body.innerText.replace(/\s+/g, ' ').slice(0, 1500),
      })));
    } catch { /* marco cerrado */ }
  }
  fs.writeFileSync(path.join(dir, `${nombre}.json`), JSON.stringify(marcos, null, 1));
}

export async function entrar(page, cfg, p, usuario, clave) {
  const L = cfg.login;
  await page.goto(L.url, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch((e) => { throw new ErrTransitorio('No se pudo abrir SUNAT: ' + e.message); });
  const c = L.campos;
  const r = await buscar(page, c.ruc), u = await buscar(page, c.usuario), k = await buscar(page, c.clave);
  if (!r || !u || !k) throw new ErrTransitorio('No apareció el formulario de ingreso de SOL (¿cambió la página?)');
  await r.fill(String(p.ruc)); await u.fill(usuario); await k.fill(clave);
  await (await buscar(page, L.enviar)).click();
  const fin = Date.now() + 25000, rxOk = new RegExp(L.ok_texto, 'i'), rxMal = new RegExp(L.error_texto, 'i');
  while (Date.now() < fin) {
    await page.waitForTimeout(700);
    let textoMal = '';
    for (const f of page.frames()) {
      let t = ''; try { t = sinTildes(await f.evaluate(() => document.body?.innerText || '')); } catch { continue; }
      if (rxOk.test(t)) return;                                   // ya entró: lo primero que se revisa
      const m = rxMal.exec(t);
      if (m && !textoMal) textoMal = t.slice(Math.max(0, m.index - 60), m.index + 100).replace(/\s+/g, ' ');
    }
    // Solo es «clave rechazada» si, además del mensaje, SOL sigue mostrando el formulario de ingreso (si ya cambió de pantalla, es otro texto)
    if (textoMal && (await buscar(page, c.clave, { tiempo: 1200 }))) {
      await page.waitForTimeout(1500);                            // confirma que el mensaje no desaparece
      if (await buscar(page, c.clave, { tiempo: 800 })) throw new ErrCredencial('SUNAT rechazó el usuario o la clave del usuario secundario (SOL dijo: «' + textoMal.trim() + '»)');
    }
  }
  throw new ErrTransitorio('SOL no respondió después de ingresar');
}

async function paso(page, ctx, s, p, modo) {
  if (s.clic_texto) { const l = await buscarTexto(page, llenarPlantilla(s.clic_texto, p), { exacto: !!s.exacto, nro: s.nro || 1 }); if (!l) throw new ErrTransitorio(`No encontré «${s.clic_texto}» en pantalla`); await l.click(); }
  else if (s.clic) { const l = await buscar(page, s.clic, { nth: s.nth || 0 }); if (!l) throw new ErrTransitorio(`No encontré el botón ${s.clic}`); await l.click(); }
  else if (s.llenar) { const l = await buscar(page, s.llenar, { nth: s.nth || 0 }); if (!l) throw new ErrTransitorio(`No encontré el campo ${s.llenar}`); await l.fill(llenarPlantilla(s.valor, p)); }
  else if (s.elegir) { const l = await buscar(page, s.elegir); if (!l) throw new ErrTransitorio(`No encontré la lista ${s.elegir}`); await l.selectOption(s.etiqueta ? { label: llenarPlantilla(s.etiqueta, p) } : llenarPlantilla(s.valor, p)); }
  else if (s.esperar_ms) await page.waitForTimeout(Math.min(Number(s.esperar_ms), 20000));
  else if (s.esperar_texto) { if (!(await buscarTexto(page, s.esperar_texto, { tiempo: 20000 }))) throw new ErrTransitorio(`No apareció «${s.esperar_texto}»`); }
  else if (s.si_no_hay_texto) { if (await buscarTexto(page, s.si_no_hay_texto, { tiempo: 6000 })) return; throw new ErrNoEncontrado(s.mensaje || 'SUNAT no mostró el comprobante'); }
  else if (s.sin_resultados) { if (await buscarTexto(page, s.sin_resultados, { tiempo: 4000 })) throw new ErrNoEncontrado('SUNAT no encontró un comprobante con esa serie y número'); }
  else throw new Error('Paso desconocido en pasos.json: ' + JSON.stringify(s));
}

// Ejecuta la secuencia y devuelve los bytes del PDF. El último paso lleva "descargar": { "clic_texto" | "clic" }.
export async function bajarPdf(page, context, cfg, p, { calibrar = false, dirCalib = './calibracion', desdeInicio = false } = {}) {
  const pasos = [...(cfg.menu || []), ...((cfg.clases || {})[p.clase] || [])];
  const clasePasos = (cfg.clases || {})[p.clase];
  if (JSON.stringify(clasePasos || []).includes('{tipo_etiqueta}') && !llenarPlantilla('{tipo_etiqueta}', p)) throw new ErrSinCalibrar('Por ahora el robot solo baja facturas y boletas (no notas de crédito/débito ni otros tipos).');
  const nombreClase = p.clase === 'COMPRA' ? 'compras' : p.clase === 'VENTA' ? 'ventas' : 'recibos por honorarios';
  if (!clasePasos || !clasePasos.length || clasePasos.some((s) => s.pendiente)) {
    if (calibrar) {
      // Calibración: recorre el menú que ya se conoce y deja una captura de cada pantalla para escribir los pasos que faltan
      if (desdeInicio) await page.goto(cfg.inicio_url || cfg.login.url, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
      await page.waitForTimeout(2500);
      await volcar(page, dirCalib, `${p.clase}-00-inicio`);
      let k = 0;
      const antes = clasePasos ? clasePasos.slice(0, Math.max(0, clasePasos.findIndex((s) => s.pendiente))) : [];
      for (const s of [...(cfg.menu || []), ...antes]) {
        k++;
        try { await paso(page, context, s, p); await page.waitForTimeout(s.espera_ms ?? 1500); }
        catch (e) { await volcar(page, dirCalib, `${p.clase}-${String(k).padStart(2, '0')}-error`); throw new ErrSinCalibrar(`No pude seguir el menú en el paso ${k} (${JSON.stringify(s)}): ${e.message}. Revisa la carpeta calibracion.`); }
        await volcar(page, dirCalib, `${p.clase}-${String(k).padStart(2, '0')}`);
      }
    }
    throw new ErrSinCalibrar(`El robot aún no está calibrado para ${nombreClase}.`);
  }
  // Desde el segundo pedido de la misma sesión se vuelve al menú principal (la sesión de SOL sigue abierta)
  if (desdeInicio) await page.goto(cfg.inicio_url || cfg.login.url, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch((e) => { throw new ErrTransitorio('No se pudo volver al menú de SOL: ' + e.message); });
  let n = 0;
  for (const s of pasos) {
    n++;
    if (s.descargar) {
      // Si el selector apunta a varios botones parecidos (iconos sin texto), prueba uno por uno hasta recibir un PDF verdadero
      const intentos = s.descargar.clic ? Math.max(1, Number(s.descargar.probar) || 1) : 1, motivos = [];
      for (let k = 0; k < intentos; k++) {
        const l = s.descargar.clic ? await buscar(page, s.descargar.clic, { nth: k, tiempo: k ? 3000 : 15000 }) : await buscarTexto(page, llenarPlantilla(s.descargar.clic_texto, p));
        if (!l) { if (!k) throw new ErrTransitorio('No encontré el botón de descarga del PDF'); break; }
        let pdfResp = null;
        const alResponder = (r) => { try { if (/pdf/i.test(r.headers()['content-type'] || '')) pdfResp = r; } catch { /* sin cabeceras */ } };
        context.on('response', alResponder);
        const esperaDescarga = page.waitForEvent('download', { timeout: 20000 }).catch(() => null);
        const esperaPagina = context.waitForEvent('page', { timeout: 20000 }).catch(() => null);
        await l.click();
        const d = await Promise.race([esperaDescarga, esperaPagina]);
        let bytes = null, como = 'nada';
        try {
          if (d && typeof d.createReadStream === 'function') { como = `descarga «${d.suggestedFilename()}»`; const ch = []; for await (const b of await d.createReadStream()) ch.push(b); bytes = Buffer.concat(ch); }
          else if (d) {
            await d.waitForLoadState('load', { timeout: 15000 }).catch(() => {}); await page.waitForTimeout(1500);
            como = `pestaña nueva ${String(d.url()).slice(0, 90)}`;
            if (pdfResp) { bytes = Buffer.from(await pdfResp.body()); como += ' (respuesta PDF)'; }
            else { const r = await context.request.get(d.url()); bytes = Buffer.from(await r.body()); }
            await d.close().catch(() => {});
          }
        } catch (e) { como += ` [${e.message.slice(0, 60)}]`; }
        context.off('response', alResponder);
        const esPdf = bytes && bytes.length >= 200 && bytes.subarray(0, 5).toString('latin1') === '%PDF-';
        if (esPdf) return bytes;
        const ini = bytes ? JSON.stringify(bytes.subarray(0, 70).toString('latin1')) : '—';
        motivos.push(`botón ${k + 1}: ${como}, empieza con ${ini}`);
        if (calibrar && bytes) { try { fs.writeFileSync(path.join(dirCalib, `descarga-${p.id.slice(0, 8)}-${k + 1}.bin`), bytes); } catch { /* sin disco */ } }
        await page.keyboard.press('Escape').catch(() => {});
      }
      throw new ErrTransitorio('SUNAT no entregó un PDF (' + motivos.join('; ') + ')');
    }
    await paso(page, context, s, p);
    await page.waitForTimeout(s.espera_ms ?? 600);
    if (calibrar) await volcar(page, dirCalib, `${p.clase}-${String(n).padStart(2, '0')}`);
  }
  throw new Error('pasos.json de ' + p.clase + ' no termina con «descargar»');
}

// Cierra la sesión de SOL (botón «Salir») para no dejar sesiones abiertas: SOL limita las sesiones simultáneas del mismo usuario.
export async function salir(page) {
  try { const l = await buscarTexto(page, 'Salir', { tiempo: 3000, exacto: true }); if (l) { await l.click({ timeout: 3000 }); await page.waitForTimeout(1500); } } catch { /* ya cerrada */ }
}
