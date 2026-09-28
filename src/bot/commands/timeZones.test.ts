import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { REGIONS, timeZoneName, zoneLabel } from './timeZones';

describe('timeZoneName', () => {
  it('stores the current name in its own letter case, not the old one ICU reports', () => {
    assert.equal(timeZoneName('europe/kyiv'), 'Europe/Kyiv');
    assert.equal(timeZoneName('ASIA/KOLKATA'), 'Asia/Kolkata');
    assert.equal(timeZoneName('utc'), 'UTC');
  });

  it('takes a zone that has no button', () => {
    assert.equal(timeZoneName('pacific/tahiti'), 'Pacific/Tahiti');
  });

  it('refuses a zone that does not exist', () => {
    assert.equal(timeZoneName('Mars/Olympus'), null);
    assert.equal(timeZoneName('Київ'), null);
  });
});

describe('time zone buttons', () => {
  it('offer only zones that exist, each fitting in the 64 bytes of callback data', () => {
    for (const [zone] of REGIONS.flatMap((region) => region.zones)) {
      assert.equal(timeZoneName(zone), zone, zone);
      assert.ok(Buffer.byteLength(`tz-z${zone}`) <= 64, zone);
    }
  });
});

describe('zoneLabel', () => {
  it('names a zone by its city where /timezone has a button for it', () => {
    assert.equal(zoneLabel('Europe/Kyiv'), 'Київ');
    assert.equal(zoneLabel('UTC'), 'UTC');
  });

  it('falls back to the last part of the name', () => {
    assert.equal(zoneLabel('Pacific/Tahiti'), 'Tahiti');
    assert.equal(zoneLabel('America/Argentina/Ushuaia'), 'Ushuaia');
    assert.equal(zoneLabel('America/Port_of_Spain'), 'Port of Spain');
  });
});
