'use strict';
// Printer features: merging driver capabilities, Windows and the device.
const assert = require('assert');
const { deriveFeatures, settingProblem } = require('../lib/printerFeatures');

const opt = (name, label = '') => ({ name, label });
const feature = (name, ...options) => ({ name, label: '', options });
const by = (d, key) => d.features.find((f) => f.key === key);
let passed = 0;
function test(name, fn) { fn(); passed++; console.log(`ok - ${name}`); }

test('driver schema answers duplex, colour, paper and finishing, with sources', () => {
  const d = deriveFeatures({
    windows: {
      capabilities: ['Copies', 'Color', 'Duplex'], paper_names: ['A4'],
      features: [
        feature('psk:JobDuplexAllDocumentsContiguously', opt('psk:OneSided'), opt('psk:TwoSidedLongEdge')),
        feature('psk:PageOutputColor', opt('psk:Color'), opt('psk:Monochrome')),
        feature('psk:PageMediaSize', opt('psk:ISOA4'), opt('psk:NorthAmericaLetter'), opt('ns0000:Env10', 'Envelope #10')),
        feature('psk:JobStapleAllDocuments', opt('psk:None'), opt('psk:StapleTopLeft', 'Top left')),
        feature('psk:JobHolePunch', opt('psk:None'))
      ]
    },
    device: { duplex_path: true, colorants: ['black', 'cyan'] }
  });
  assert.deepStrictEqual([by(d, 'two_sided').status, by(d, 'two_sided').value], ['yes', 'long edge']);
  assert.deepStrictEqual(by(d, 'two_sided').sources, ['Driver', 'Windows', 'Printer']);
  assert.strictEqual(by(d, 'colour').status, 'yes');
  assert.strictEqual(by(d, 'paper_sizes').value, 'A4, Letter, Envelope #10');
  assert.deepStrictEqual([by(d, 'staple').status, by(d, 'staple').value], ['yes', 'Top left']);
  assert.strictEqual(by(d, 'hole_punch').status, 'no');
  // Settings narrowed to what the printer takes
  assert.deepStrictEqual(d.settings.duplex, ['OneSided', 'TwoSidedLongEdge']);
  assert.deepStrictEqual(d.settings.paper_size, ['A4', 'Letter']);
});

test('"no" only when a source lists the alternatives; otherwise unknown', () => {
  const mono = deriveFeatures({ windows: { features: [feature('psk:PageOutputColor', opt('psk:Monochrome'), opt('psk:Grayscale')), feature('psk:JobDuplexAllDocumentsContiguously', opt('psk:OneSided'))] } });
  assert.strictEqual(by(mono, 'colour').status, 'no');
  assert.strictEqual(by(mono, 'two_sided').status, 'no');
  assert.deepStrictEqual(mono.settings, { duplex: ['OneSided'], color: [false], paper_size: ['A4', 'A3', 'A5', 'Letter', 'Legal'] });
  const blank = deriveFeatures(null);
  assert.strictEqual(by(blank, 'two_sided').status, 'unknown');
  assert.strictEqual(by(blank, 'colour').status, 'unknown');
  assert.strictEqual(blank.settings.duplex.length, 3, 'unknown keeps every option');
});

test('rated speed from the device vs measured speed; slow printing is pointed out', () => {
  const d = deriveFeatures({ device: { rated_ppm: 40 } }, {}, { speed: { ppm: 12, source: 'learned' } });
  assert.strictEqual(by(d, 'speed').value, 'rated 40 pages/min · measured 12 pages/min');
  assert.ok(by(d, 'speed').detail.includes('under half'));
});

test('settings this printer cannot take are refused with a reason', () => {
  const d = deriveFeatures({ windows: { features: [feature('psk:PageOutputColor', opt('psk:Monochrome')), feature('psk:JobDuplexAllDocumentsContiguously', opt('psk:OneSided')), feature('psk:PageMediaSize', opt('psk:ISOA4'))] } });
  assert.strictEqual(settingProblem(d, { duplex: 'TwoSidedLongEdge' }), "This printer can't print on both sides.");
  assert.strictEqual(settingProblem(d, { color: true }), 'This printer only prints black and white.');
  assert.strictEqual(settingProblem(d, { paper_size: 'A3' }), "This printer doesn't list A3 paper.");
  assert.strictEqual(settingProblem(d, { paper_size: 'A4', duplex: 'OneSided', color: false }), null);
});

console.log(`\n${passed} passed`);
