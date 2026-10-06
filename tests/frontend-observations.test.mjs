import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const html = await readFile(new URL('../dashboard/public/jarvis.html', import.meta.url), 'utf8');
const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].at(-1)[1];
const fredIds = ['VIXCLS', 'BAMLH0A0HYM2', 'DTWEXBGS', 'ICSA', 'MORTGAGE30US', 'M2SL'];
const riskLabels = ['VIX (Fear)', 'HY Spread', 'USD Index', 'Jobless Claims', '30Y Mortgage', 'M2 Supply', 'Nat. Debt'];
const spaceLabels = ['New Objects (30d)', 'Military Sats', 'Starlink', 'OneWeb', 'TEST'];

function fixture() {
  return {
    meta: { quality: { sources: [] } }, air: [], thermal: [], chokepoints: [], nuke: [], who: [], fred: [],
    tg: { posts: 0, urgent: [], topPosts: [] }, sdr: { total: 0, directoryOnly: true },
    acled: { totalEvents: 0, totalFatalities: 0 }, treasury: {},
    space: { iss: {}, constellations: {}, militaryByCountry: { TEST: null }, signals: [] },
  };
}

function render(data) {
  const rail = { innerHTML: '' };
  const context = vm.createContext({
    fixtureData: data, location: { protocol: 'https:' }, window: { innerWidth: 1440 },
    localStorage: { getItem: () => null },
    document: { addEventListener() {}, getElementById(id) { assert.equal(id, 'leftRail'); return rail; } },
  });
  new vm.Script(script).runInContext(context);
  vm.runInContext('D = fixtureData; renderLeftRail();', context);
  const rows = new Map([...rail.innerHTML.matchAll(/<div class="econ-row"><span class="elabel"[^>]*>(.*?)<\/span><span class="eval"[^>]*>(.*?)<\/span><\/div>/gs)].map(match => [match[1], match[2]]));
  const layers = new Map([...rail.innerHTML.matchAll(/<div class="layer-item">[\s\S]*?<div class="layer-name">([^<]*)<\/div><div class="layer-sub">([^<]*)<\/div>[\s\S]*?<div class="layer-count">([^<]*)<\/div><\/div>/g)].map(match => [match[1], { sub: match[2], count: match[3] }]));
  return { rows, layers, html: rail.innerHTML };
}

function setNumbers(data, value) {
  data.fred = fredIds.map(id => ({ id, value }));
  data.treasury.totalDebt = value;
  data.space.totalNewObjects = value;
  data.space.militarySats = value;
  data.space.constellations = { starlink: value, oneweb: value };
  data.space.militaryByCountry.TEST = value;
  data.space.iss = { apogee: value, perigee: value };
}

test('missing live observations show N/A without fabricated zeroes or units', () => {
  const output = render(fixture());
  for (const label of [...riskLabels, ...spaceLabels]) assert.equal(output.rows.get(label), 'N/A', label);
  assert.equal(output.rows.get('ISS'), 'ALT N/A');
  assert.doesNotMatch(output.html, /NaN|Infinity|undefined|null|\$N\/A|N\/A%|N\/A km/);
});

test('nonfinite and malformed observations cannot render NaN or coerce missing altitude to zero', () => {
  for (const value of [NaN, Infinity, -Infinity, null, undefined, '', ' ', 'not-a-number', '12invalid', false]) {
    const data = fixture();
    setNumbers(data, value);
    data.space.iss.perigee = 420; // Both orbital bounds are required; one valid bound is insufficient.
    const output = render(data);
    for (const label of [...riskLabels, ...spaceLabels]) assert.equal(output.rows.get(label), 'N/A', label);
    assert.equal(output.rows.get('ISS'), 'ALT N/A');
    assert.doesNotMatch(output.html, /NaN|Infinity|undefined|null/);
  }
});

test('genuine measured zeroes keep their numeric formatting and units', () => {
  const data = fixture();
  setNumbers(data, 0);
  const { rows } = render(data);
  const expected = { 'VIX (Fear)': '0', 'HY Spread': '0', 'USD Index': '0.0', 'Jobless Claims': '0',
    '30Y Mortgage': '0%', 'M2 Supply': '$0.0T', 'Nat. Debt': '$0.00T', ISS: 'ALT 0 km',
    'New Objects (30d)': '0', 'Military Sats': '0', Starlink: '0', OneWeb: '0', TEST: '0 mil sats' };
  for (const [label, value] of Object.entries(expected)) assert.equal(rows.get(label), value, label);
});

test('finite observations and numeric source strings preserve their values', () => {
  const data = fixture();
  const values = [24.54, 3.16, 120.8851, 202000, 6.46, 22667.3];
  data.fred = fredIds.map((id, i) => ({ id, value: values[i] }));
  data.treasury.totalDebt = '40242446619209.33';
  data.space = { totalNewObjects: 170, militarySats: 24, constellations: { starlink: 11116, oneweb: 651 },
    iss: { apogee: '420', perigee: '400' }, militaryByCountry: { TEST: 24 }, signals: [] };
  const { rows } = render(data);
  assert.equal(rows.get('M2 Supply'), '$22.7T');
  assert.equal(rows.get('Nat. Debt'), '$40.24T');
  assert.equal(rows.get('ISS'), 'ALT 410 km');
  assert.equal(rows.get('USD Index'), '120.9');
  assert.equal(rows.get('Jobless Claims'), (202000).toLocaleString());
  assert.equal(rows.get('VIX (Fear)'), '24.54');
  assert.equal(rows.get('HY Spread'), '3.16');
  assert.equal(rows.get('30Y Mortgage'), '6.46%');
  assert.equal(rows.get('Starlink'), '11116');
  assert.equal(rows.get('TEST'), '24 mil sats');
});

test('unavailable FIRMS and ACLED sources are explicit while measured zero counts remain zero', () => {
  for (const state of ['unavailable', 'data']) {
    const data = fixture();
    data.meta.quality.sources = ['FIRMS', 'ACLED'].map(name => ({ name, state }));
    data.thermal = [{ det: 0, night: 0 }];
    const { layers } = render(data);
    const unavailable = state === 'unavailable';
    assert.deepEqual(layers.get('Thermal Spikes'), { count: unavailable ? 'Unavailable' : '0', sub: unavailable ? 'Source unavailable' : '0 night det.' });
    assert.deepEqual(layers.get('Conflict Events'), { count: unavailable ? 'Unavailable' : '0', sub: unavailable ? 'Source unavailable' : '0 fatalities' });
  }
});
