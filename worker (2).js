// ACI Baltic Proxy — v1
// Elering dashboard API (Viron sähkö ja kaasu) + ENTSOG Transparency
// Platform (Suomen ja Baltian kaasun siirto). Molemmat ilman API-avainta.
//
// REITIT
//   /                                   reittihakemisto
//   ?el=<polku>&start=..&end=..         Elering: /api/<polku>, parametrit sellaisinaan
//   ?el_spec=1                          Eleringin OpenAPI-kuvaus (kokeilee tunnetut osoitteet)
//   ?eg=<endpoint>&...                  ENTSOG: /api/v1/<endpoint>, parametrit sellaisinaan
//   ?eg_points=<hakusana>               ENTSOG operatorPointDirections, suodatettu
//
// PERIAATE: välittäjä, ei tulkitsija. Parametreja ei nimetä uudelleen eikä
// arvoja muokata. Kaksi tunnettua hiljaista vikaa tarkistetaan ja niistä
// varoitetaan (_warnings), mutta pyyntöä ei muuteta:
//   1. ENTSOG: ilman `limit`-parametria vastaus katkeaa 100 riviin.
//   2. Elering: `start`/`end` ilman aikavyöhykettä tulkitaan UTC:ksi.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Content-Type': 'application/json; charset=utf-8',
};

const ELERING = 'https://dashboard.elering.ee';
const ENTSOG  = 'https://transparency.entsog.eu/api/v1';

// Eleringin API-ryhmät (elering-py-kirjaston dokumentaation mukaan).
// Polun ensimmäisen osan on oltava jokin näistä.
const EL_GROUPS = new Set([
  'nps', 'system', 'balance', 'transmission', 'gas_system', 'gas-system',
  'gas_transmission', 'gas-transmission', 'gas_trade', 'gas-trade',
  'gas_balance', 'gas-balance', 'gas_border_trade', 'gas-border-trade',
  'capacity', 'nominations', 'green', 'umm',
]);

// ENTSOG-käyttöohjeen (v3.0, 1.10.2025) endpointit.
// Avain pienillä kirjaimilla -> kirjoitusasu kuten käyttöohjeessa.
const EG_ENDPOINTS = new Map([
  'operationalDatas', 'operationalData', 'aggregatedData', 'connectionPoints',
  'interconnections', 'aggregateInterconnections', 'operatorPointDirections',
  'operators', 'balancingZones', 'cmpUnsuccessfulRequests', 'cmpUnavailables',
  'cmpAuctions', 'interruptions', 'urgentMarketMessages',
].map(e => [e.toLowerCase(), e]));

// Välimuisti: data muuttuu tunneittain, luettelot harvoin.
const TTL_DATA = 900;      // 15 min
const TTL_META = 86400;    // 24 h

const json = (obj, status = 200, ttl = 0) => {
  const r = new Response(JSON.stringify(obj), { status, headers: CORS });
  if (ttl && status === 200) r.headers.set('Cache-Control', `public, max-age=${ttl}`);
  return r;
};

// Välitettävät parametrit: kaikki paitsi proxyn omat ohjausparametrit.
function forwardParams(url, own) {
  const out = new URLSearchParams();
  for (const [k, v] of url.searchParams) if (!own.includes(k)) out.append(k, v);
  return out;
}

// URLSearchParams.toString() koodaa välilyönnin '+':ksi. ENTSOGin indikaattorit
// sisältävät välilyöntejä ('Physical Flow'), ja käyttöohjeen esimerkit käyttävät
// %20:tä. Koodataan siksi encodeURIComponentilla.
function qs(params) {
  return [...params].map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
}

async function upstream(target, ttl, warnings, extra = {}) {
  let resp;
  try {
    resp = await fetch(target, {
      headers: { 'Accept': 'application/json', 'User-Agent': 'ACI-Baltic-Proxy/1.0' },
    });
  } catch (e) {
    return json({ error: `fetch failed: ${e.message}`, upstream: target }, 502);
  }
  const text = await resp.text();
  if (!resp.ok) {
    // Virhe näytetään virheenä — ei tyhjänä datana.
    return json({ error: `upstream ${resp.status}`, upstream: target,
                  preview: text.slice(0, 300) }, resp.status === 429 ? 429 : 502);
  }
  let data;
  try { data = JSON.parse(text); }
  catch { return json({ error: 'upstream ei palauttanut JSONia', upstream: target,
                        preview: text.slice(0, 300) }, 502); }
  const body = { upstream: target, fetched: new Date().toISOString(), ...extra, data };
  if (warnings.length) body._warnings = warnings;
  return json(body, 200, ttl);
}

// ── Elering ─────────────────────────────────────────────────────────
async function elering(url) {
  const raw = (url.searchParams.get('el') || '').replace(/^\/+/, '').replace(/^api\//, '');
  const group = raw.split('/')[0];
  if (!raw || !EL_GROUPS.has(group)) {
    return json({ error: `el: tuntematon ryhmä '${group}'`, allowed_groups: [...EL_GROUPS],
                  hint: 'Hae oikeat polut: ?el_spec=1' }, 400);
  }
  if (raw.includes('..')) return json({ error: 'el: polussa ei saa olla ..' }, 400);
  const params = forwardParams(url, ['el']);
  const warnings = [];
  for (const k of ['start', 'end']) {
    const v = params.get(k);
    if (v && !/(Z|[+-]\d{2}:?\d{2})$/.test(v)) {
      warnings.push(`${k}='${v}' ilman aikavyöhykettä — Elering tulkitsee UTC:ksi`);
    }
  }
  const q = qs(params);
  return upstream(`${ELERING}/api/${raw}${q ? '?' + q : ''}`,
                  raw.startsWith('umm') ? TTL_DATA : TTL_DATA, warnings);
}

async function eleringSpec() {
  // Speksin osoitetta ei tunneta varmasti: kokeillaan ja kerrotaan mikä toimi.
  const candidates = ['/v3/api-docs', '/api-docs', '/v2/api-docs', '/api/v3/api-docs',
                      '/swagger.json', '/openapi.json'];
  const tried = [];
  for (const p of candidates) {
    try {
      const r = await fetch(ELERING + p, { headers: { 'Accept': 'application/json',
                                                      'User-Agent': 'ACI-Baltic-Proxy/1.0' } });
      tried.push({ path: p, status: r.status });
      if (!r.ok) continue;
      const spec = JSON.parse(await r.text());
      const paths = Object.keys(spec.paths || {}).sort();
      if (!paths.length) continue;
      return json({ upstream: ELERING + p, path_count: paths.length, paths,
                    tried }, 200, TTL_META);
    } catch (e) { tried.push({ path: p, error: e.message }); }
  }
  return json({ error: 'OpenAPI-kuvausta ei löytynyt mistään kokeillusta osoitteesta',
                tried }, 404);
}

// ── ENTSOG ──────────────────────────────────────────────────────────
async function entsog(url) {
  const ep = (url.searchParams.get('eg') || '').toLowerCase().replace(/\.(json|xml|csv|xlsx)$/, '');
  if (!EG_ENDPOINTS.has(ep)) {
    return json({ error: `eg: tuntematon endpoint '${ep}'`, allowed: [...EG_ENDPOINTS.values()] }, 400);
  }
  const epName = EG_ENDPOINTS.get(ep);
  const params = forwardParams(url, ['eg']);
  const warnings = [];
  if (!params.has('limit')) {
    warnings.push("ei 'limit'-parametria: ENTSOG katkaisee vastauksen 100 riviin. " +
                  "Käytä limit=-1 kaikille riveille.");
  }
  if (ep === 'aggregateddata') {
    for (const k of ['pointDirection', 'from', 'to', 'indicator', 'periodType']) {
      if (!params.has(k)) warnings.push(`aggregatedData vaatii parametrin '${k}'`);
    }
  }
  const tz = params.get('timezone') || params.get('timeZone');
  if (tz && tz.toUpperCase() !== 'WET') {
    warnings.push(`timezone=${tz}: ENTSOG lupaa johdonmukaisen muunnoksen vain WET:lle`);
  }
  const q = qs(params);
  const ttl = ['operationaldatas', 'operationaldata', 'aggregateddata', 'interruptions',
               'urgentmarketmessages'].includes(ep) ? TTL_DATA : TTL_META;
  return upstream(`${ENTSOG}/${epName}${q ? '?' + q : ''}`, ttl, warnings);
}

async function entsogPoints(url) {
  // Pistetunnukset (pointDirection) eivät ole arvattavissa. Haetaan luettelo
  // ja suodatetaan hakusanalla nimestä, operaattorista ja tunnuksesta.
  const term = (url.searchParams.get('eg_points') || '').toLowerCase().trim();
  if (!term) return json({ error: 'eg_points vaatii hakusanan, esim. eg_points=balticconnector' }, 400);
  const target = `${ENTSOG}/operatorPointDirections?limit=-1&hasData=1`;
  let resp;
  try { resp = await fetch(target, { headers: { 'Accept': 'application/json',
                                                'User-Agent': 'ACI-Baltic-Proxy/1.0' } }); }
  catch (e) { return json({ error: `fetch failed: ${e.message}` }, 502); }
  if (!resp.ok) return json({ error: `upstream ${resp.status}`, upstream: target }, 502);
  const all = JSON.parse(await resp.text());
  const rows = all.operatorpointdirections || all.operatorPointDirections || all.data || [];
  const pick = (o, ...ks) => { for (const k of ks) if (o[k] != null) return o[k]; return null; };
  // Kenttiä ei koota itse: id palautetaan sellaisenaan, koska ENTSOGin
  // pointDirection-koodin muodostus vaihtelee operaattoreittain.
  const hits = rows.filter(r => JSON.stringify(r).toLowerCase().includes(term)).map(r => ({
    id: pick(r, 'id'),
    pointLabel: pick(r, 'pointLabel', 'pointName'),
    operatorLabel: pick(r, 'operatorLabel'),
    directionKey: pick(r, 'directionKey'),
    pointKey: pick(r, 'pointKey'),
    operatorKey: pick(r, 'operatorKey'),
  }));
  return json({ upstream: target, term, total_rows: rows.length, count: hits.length,
                hits, _note: 'total_rows 0 = luettelon avain on eri kuin oletettu; tarkista ' +
                '?eg=operatorpointdirections&limit=-1. pointDirection-parametrina käytetään ' +
                'yleensä id-kenttää — varmista yhdellä haulla ennen sarjan rakentamista.' },
              200, TTL_META);
}

// ── reititys ────────────────────────────────────────────────────────
export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const url = new URL(request.url);
    const sp = url.searchParams;
    if (sp.has('el_spec')) return eleringSpec();
    if (sp.has('el')) return elering(url);
    if (sp.has('eg_points')) return entsogPoints(url);
    if (sp.has('eg')) return entsog(url);
    return json({
      service: 'aci-baltic-proxy',
      note: 'Välittäjä, ei tulkitsija. Parametrit välitetään sellaisinaan.',
      elering: {
        data: '?el=<ryhmä>/<polku>&start=2026-11-02T00:00:00Z&end=2026-11-03T00:00:00Z',
        spec: '?el_spec=1  — hae polut ensin, älä arvaa',
        groups: [...EL_GROUPS],
      },
      entsog: {
        data: '?eg=operationalDatas&pointDirection=<koodi>&indicator=Physical%20Flow&from=2026-11-01&to=2026-11-03&periodType=day&timezone=WET&limit=-1',
        points: '?eg_points=balticconnector  — pistetunnusten haku',
        traps: ['ilman limit-parametria 100 riviä', 'timezone luotettava vain WET', 'indicator on kirjainkoko-tarkka'],
      },
    }, 200, TTL_META);
  },
};
