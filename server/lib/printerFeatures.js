// ---------------------------------------------------------------
// Printer features
//
// What a particular printer can do, worked out from every source the agent
// can read and labelled with where each answer came from:
//   * the driver's Print Schema capabilities (Get-PrintConfiguration's
//     PrintCapabilitiesXML): duplex, colour, paper sizes, trays, stapling,
//     hole punch, booklet, pages per sheet, resolution, media types…
//   * Windows' own capability list and paper names (Win32_Printer);
//   * the device itself over SNMP: colorants, duplex media paths, rated
//     speed, print languages, output bins, trays, serial number;
//   * what the app has measured: print speed, toner, photocopies.
// A "no" is only given when a source positively lists the alternatives
// (e.g. the driver offers One side only); missing data stays "unknown".
// The settings a printer offers are narrowed to what it supports.
// ---------------------------------------------------------------

const strip = (n) => String(n || '').replace(/^[^:]*:/, '');
const MEDIA = { ISOA4: 'A4', ISOA3: 'A3', ISOA5: 'A5', ISOA6: 'A6', ISOB5: 'B5', JISB5: 'B5 (JIS)', NorthAmericaLetter: 'Letter', NorthAmericaLegal: 'Legal', NorthAmericaExecutive: 'Executive', NorthAmericaTabloid: 'Tabloid' };
const humanize = (n) => strip(n).replace(/([a-z])([A-Z0-9])/g, '$1 $2').replace(/\s+/g, ' ').trim();
const optLabel = (o) => (o.label && o.label.trim()) || MEDIA[strip(o.name)] || humanize(o.name);
const uniq = (list) => [...new Set(list.filter(Boolean))];
const COLOURS = ['cyan', 'magenta', 'yellow', 'red', 'green', 'blue', 'light cyan', 'light magenta'];
const SETTABLE_PAPER = ['A4', 'A3', 'A5', 'Letter', 'Legal'];
const SOURCE_LABEL = { driver: 'Driver', windows: 'Windows', printer: 'Printer', app: 'Measured' };

function schema(info) {
  const map = new Map();
  for (const f of (info && info.windows && info.windows.features) || []) map.set(strip(f.name), f);
  return map;
}

function optionNames(feature) {
  return (feature && feature.options ? feature.options : []).map((o) => strip(o.name));
}

/**
 * info: { windows, device } from the agent's printer_info command (may be null);
 * state: the printer's latest snapshot; extra: { speed, supplies, copies }.
 */
function deriveFeatures(info, state = {}, extra = {}) {
  const win = (info && info.windows) || {};
  const dev = (info && info.device && !info.device.error && info.device) || {};
  const caps = (win.capabilities || []).map((c) => String(c).toLowerCase());
  const sch = schema(info);
  const features = [];
  const add = (key, label, status, value, sources, detail = '') => features.push({ key, label, status, value, sources: uniq(sources).map((s) => SOURCE_LABEL[s] || s), detail });

  // Two-sided printing
  const duplex = sch.get('JobDuplexAllDocumentsContiguously') || sch.get('JobDuplexAllDocuments');
  const duplexOpts = optionNames(duplex);
  const twoSided = duplexOpts.filter((n) => /^TwoSided/.test(n));
  if (twoSided.length) {
    add('two_sided', 'Two-sided printing', 'yes', twoSided.map((n) => (/Short/.test(n) ? 'short edge' : 'long edge')).join(' and '), ['driver', caps.includes('duplex') && 'windows', dev.duplex_path && 'printer']);
  } else if (duplexOpts.length) {
    add('two_sided', 'Two-sided printing', 'no', 'One side only', ['driver']);
  } else if (caps.includes('duplex') || dev.duplex_path) {
    add('two_sided', 'Two-sided printing', 'yes', '', [caps.includes('duplex') && 'windows', dev.duplex_path && 'printer']);
  } else {
    add('two_sided', 'Two-sided printing', 'unknown', '', []);
  }

  // Colour
  const colourOpts = optionNames(sch.get('PageOutputColor'));
  const deviceColour = (dev.colorants || []).some((c) => COLOURS.includes(c));
  const supplyColour = (extra.supplies || []).some((s) => COLOURS.includes(String(s.colorant || '').toLowerCase()));
  if (colourOpts.includes('Color') || deviceColour || supplyColour || caps.includes('color')) {
    add('colour', 'Colour', 'yes', deviceColour || supplyColour ? 'Colour toner or ink fitted' : '',
      [colourOpts.includes('Color') && 'driver', caps.includes('color') && 'windows', deviceColour && 'printer', supplyColour && 'printer']);
  } else if (colourOpts.length || (dev.colorants || []).length) {
    add('colour', 'Colour', 'no', 'Black and white only', [colourOpts.length && 'driver', (dev.colorants || []).length && 'printer']);
  } else {
    add('colour', 'Colour', 'unknown', '', []);
  }

  // Paper sizes
  const sizes = uniq(((sch.get('PageMediaSize') || {}).options || []).map(optLabel));
  const paperNames = uniq(win.paper_names || []);
  const paper = sizes.length ? sizes : paperNames;
  add('paper_sizes', 'Paper sizes', paper.length ? 'yes' : 'unknown', paper.length ? `${paper.slice(0, 10).join(', ')}${paper.length > 10 ? ` +${paper.length - 10} more` : ''}` : '', [sizes.length && 'driver', !sizes.length && paperNames.length && 'windows']);

  // Paper trays and output bins
  const bins = uniq(((sch.get('JobInputBin') || sch.get('PageInputBin') || {}).options || []).map(optLabel)).filter((b) => !/auto/i.test(b));
  const trays = uniq(((state.device && state.device.trays) || []).map((t) => t.name));
  const trayList = trays.length ? trays : bins;
  if (trayList.length) add('trays', 'Paper trays', 'yes', `${trayList.length}: ${trayList.slice(0, 6).join(', ')}`, [trays.length && 'printer', bins.length && 'driver']);
  const outBins = uniq([...((sch.get('JobOutputBin') || {}).options || []).map(optLabel), ...(dev.output_bins || [])]);
  if (outBins.length) add('output_bins', 'Output trays', 'yes', outBins.slice(0, 6).join(', '), [sch.get('JobOutputBin') && 'driver', (dev.output_bins || []).length && 'printer']);

  // Finishing: only a "no" when the driver lists the choices and they're all None
  for (const [key, label, names] of [
    ['staple', 'Stapling', ['JobStapleAllDocuments', 'DocumentStaple']],
    ['hole_punch', 'Hole punch', ['JobHolePunch', 'DocumentHolePunch']],
    ['booklet', 'Booklet', ['JobBindAllDocuments', 'DocumentBinding']]
  ]) {
    const f = names.map((n) => sch.get(n)).find(Boolean);
    if (!f) continue;
    const real = (f.options || []).filter((o) => !/^None$/i.test(strip(o.name)));
    add(key, label, real.length ? 'yes' : 'no', real.map(optLabel).slice(0, 4).join(', '), ['driver']);
  }

  const nup = uniq(((sch.get('JobNUpAllDocumentsContiguously') || sch.get('DocumentNUp') || {}).options || []).map(optLabel));
  if (nup.length > 1) add('pages_per_sheet', 'Pages per sheet', 'yes', nup.slice(0, 8).join(', '), ['driver']);

  const res = uniq(((sch.get('PageResolution') || {}).options || []).map(optLabel));
  const winRes = win.resolution && win.resolution.x > 0 ? `${win.resolution.x} × ${win.resolution.y} dpi` : '';
  if (res.length || winRes) add('resolution', 'Resolution', 'yes', res.length ? res.slice(0, 4).join(', ') : winRes, [res.length && 'driver', !res.length && 'windows']);

  const media = uniq(((sch.get('PageMediaType') || {}).options || []).map(optLabel));
  if (media.length) add('media_types', 'Paper types', 'yes', media.slice(0, 8).join(', '), ['driver']);

  if (caps.includes('collate') || sch.get('DocumentCollate')) add('collate', 'Collate copies', 'yes', '', [caps.includes('collate') && 'windows', sch.get('DocumentCollate') && 'driver']);
  if ((dev.languages || []).length) add('languages', 'Print languages', 'yes', dev.languages.join(', '), ['printer']);

  // Speed: what the maker rates vs what this shop's jobs actually get
  const measured = extra.speed && extra.speed.source === 'learned' ? extra.speed.ppm : null;
  if (dev.rated_ppm || measured) {
    const parts = [dev.rated_ppm && `rated ${dev.rated_ppm} pages/min`, measured && `measured ${measured} pages/min`].filter(Boolean);
    const slow = dev.rated_ppm && measured && measured < dev.rated_ppm * 0.5;
    add('speed', 'Speed', 'yes', parts.join(' · '), [dev.rated_ppm && 'printer', measured && 'app'],
      slow ? 'Jobs here print at under half the rated speed: large or complex documents, or a slow connection to the PC.' : '');
  }
  if (dev.technology) add('technology', 'Print technology', 'yes', dev.technology, ['printer']);
  if ((extra.supplies || []).length) add('supplies', 'Toner / ink levels', 'yes', `${extra.supplies.length} supplies reported`, ['printer']);
  if (extra.copies) add('photocopies', 'Photocopy counting', 'yes', `${extra.copies} copied pages detected in 30 days`, ['app']);

  // Settings this printer can actually take
  const duplexChoices = twoSided.length
    ? ['OneSided', ...['TwoSidedLongEdge', 'TwoSidedShortEdge'].filter((v) => twoSided.includes(v))]
    : features.find((f) => f.key === 'two_sided').status === 'no' ? ['OneSided'] : ['OneSided', 'TwoSidedLongEdge', 'TwoSidedShortEdge'];
  const colourStatus = features.find((f) => f.key === 'colour').status;
  const paperChoices = paper.length ? SETTABLE_PAPER.filter((s) => paper.some((p) => new RegExp(`^${s}\\b`, 'i').test(p))) : SETTABLE_PAPER;

  const identity = {
    model: dev.model || '',
    serial: dev.serial || '',
    host: state.host || '',
    network_name: dev.name || '',
    location: dev.location || win.location || '',
    driver: win.driver || null,
    port: win.port || state.port || '',
    shared: !!win.shared,
    share_name: win.share_name || '',
    page_count: Number.isFinite(dev.page_count) ? dev.page_count : null,
    uptime_hours: Number.isFinite(dev.uptime_hours) ? dev.uptime_hours : null,
    comment: win.comment || ''
  };

  return {
    features,
    identity,
    settings: {
      duplex: duplexChoices,
      color: colourStatus === 'no' ? [false] : [true, false],
      paper_size: paperChoices.length ? paperChoices : SETTABLE_PAPER
    },
    properties: (win.properties || []).slice(0, 80)
  };
}

/** Why a default setting can't be applied to this printer, or null. */
function settingProblem(derived, params) {
  if (!derived) return null;
  const s = derived.settings;
  if (params.duplex && !s.duplex.includes(params.duplex)) return params.duplex === 'OneSided' ? 'Unsupported sides setting' : "This printer can't print on both sides.";
  if (params.color === true && !s.color.includes(true)) return 'This printer only prints black and white.';
  if (params.paper_size && !s.paper_size.includes(params.paper_size)) return `This printer doesn't list ${params.paper_size} paper.`;
  return null;
}

module.exports = { deriveFeatures, settingProblem };
