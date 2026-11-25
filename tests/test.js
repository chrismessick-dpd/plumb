// Plumb's tests: benches synced with a fake plumb_data (tests/fake-github.js). Two browsers are two storage
// namespaces. Sets the page title to PASS, FAIL, or ERROR, as the suite's test pages do.
(async function () {
  'use strict';
  const ST = window.PLUMB.store;
  const out = document.getElementById('out');
  let pass = 0, fail = 0;
  const say = (cls, text) => { const s = document.createElement('span'); s.className = cls; s.textContent = text + '\n'; out.appendChild(s); };
  function ok(cond, name, detail) { if (cond) { pass++; say('ok', '✓ ' + name); } else { fail++; say('bad', '✗ ' + name + (detail ? ': ' + detail : '')); } }
  const tick = () => new Promise((r) => setTimeout(r, 5));
  const A = 'plumb.test.a.', B = 'plumb.test.b.';
  const clear = () => Object.keys(localStorage).filter((k) => k.indexOf('plumb.test.') === 0).forEach((k) => localStorage.removeItem(k));
  const files = (gh) => [...gh.trees.get(gh.commits.get(gh.head).tree).keys()].sort();
  const fileJson = (gh, path) => { const t = gh.trees.get(gh.commits.get(gh.head).tree); const e = t.get(path); return e ? JSON.parse(new TextDecoder().decode(gh.blobs.get(e.sha))) : null; };
  const sync = (gh, o) => ST.sync(Object.assign({ token: 'x', fetch: gh.fetch }, o || {}));

  try {
    clear();
    const gh = window.FakeGitHub();

    // A new bench is edited until it has synced.
    ST.setNamespace(A);
    const p1 = ST.create({ name: 'Main PCBA bring-up', project: 'Smart Thermostat', board: { id: 'pdemo7', name: 'Main PCBA' }, defs: 'target PSU "Supply"\n', script: 'suite S\n  test T-01 One\n    log "hi"\n' });
    await tick();
    const p2 = ST.create({ name: 'Display bench', project: 'Smart Thermostat', defs: '', script: '' });
    ok(ST.edited(p1.id) && ST.unsynced().length === 2, 'new benches count as unsynced');

    // Dry run: reads, writes nothing, says what it would write.
    const commitsBefore = gh.stats.commits, headBefore = gh.head;
    const dry = await sync(gh, { dry: true });
    ok(gh.stats.commits === commitsBefore && gh.head === headBefore, 'a dry run commits nothing');
    ok(dry.dry && dry.dry.files.map((f) => f.path).sort().join() === ['projects/' + p1.id + '.json', 'projects/' + p2.id + '.json'].sort().join(), 'a dry run lists the two files it would write', JSON.stringify(dry.dry && dry.dry.files.map((f) => f.path)));
    const dj = JSON.parse(dry.dry.files.find((f) => f.path.indexOf(p1.id) > 0).text);
    ok(dj.summary && dj.summary.tool === 'plumb' && dj.summary.targets === 1 && dj.summary.tests === 1 && dj.summary.board.id === 'pdemo7', 'the file carries a derived summary', JSON.stringify(dj.summary));
    ok(ST.unsynced().length === 2, 'a dry run leaves the benches unsynced');

    // The real sync writes one commit; the dry run's files match it byte for byte.
    const r1 = await sync(gh);
    ok(r1.pushed === 2 && gh.stats.commits === commitsBefore + 1, 'sync writes both benches in one commit', JSON.stringify(r1));
    const wrote = new TextDecoder().decode(gh.blobs.get(gh.trees.get(gh.commits.get(gh.head).tree).get('projects/' + p1.id + '.json').sha));
    ok(wrote === dry.dry.files.find((f) => f.path.indexOf(p1.id) > 0).text, 'the dry run showed exactly what sync wrote');
    ok(ST.unsynced().length === 0, 'nothing is unsynced after the sync');
    ok(!('summary' in ST.get(p1.id)), 'the summary is not kept in the browser copy');

    // An untouched browser doesn't write.
    const r2 = await sync(gh);
    ok(r2.pushed === 0 && gh.stats.commits === commitsBefore + 1, 'a sync with nothing edited writes nothing');

    // Browser B pulls both.
    ST.setNamespace(B);
    await sync(gh);
    ok(ST.list().length === 2 && ST.get(p1.id).bench.script.indexOf('T-01') > 0, 'another browser pulls both benches');
    ok(ST.unsynced().length === 0, 'pulled benches are not unsynced');

    // B edits, syncs; A (unedited) takes B's copy and writes nothing.
    await tick();
    ST.update(p1.id, { script: 'suite S\n  test T-01 One, edited in B\n    log "hi"\n' });
    await sync(gh);
    ST.setNamespace(A);
    const c0 = gh.stats.commits;
    await sync(gh);
    ok(ST.get(p1.id).bench.script.indexOf('edited in B') > 0 && gh.stats.commits === c0, 'an unedited browser takes the newer copy and writes nothing');

    // Both edit the same bench: the newer wins, the other becomes a conflict copy, nothing is lost.
    await tick(); ST.update(p1.id, { name: 'Main PCBA bring-up (A)' });
    ST.setNamespace(B); await tick(); ST.update(p1.id, { name: 'Main PCBA bring-up (B)' }); await sync(gh);
    ST.setNamespace(A);
    const r3 = await sync(gh);
    const names = ST.list().map((p) => p.meta.name);
    ok(r3.conflicts.length === 1, 'an edit on both sides makes one conflict copy', JSON.stringify(names));
    ok(names.indexOf('Main PCBA bring-up (B)') >= 0 && names.some((n) => n === 'Main PCBA bring-up (A) (conflict copy)'), 'the newer copy wins and the older is kept as a copy', JSON.stringify(names));
    const r4 = await sync(gh);
    ok(files(gh).length === 3 && r4.pushed === 1, 'the conflict copy reaches GitHub on the next sync', JSON.stringify(files(gh)));

    // Deleting syncs as a tombstone.
    ST.remove(p2.id);
    await sync(gh);
    const t = fileJson(gh, 'projects/' + p2.id + '.json');
    ok(t && t.meta.deleted === true, 'a deleted bench is written as a tombstone');
    ST.setNamespace(B); await sync(gh);
    ok(!ST.get(p2.id) && ST.list().every((p) => p.id !== p2.id), 'the other browser stops listing it');

    // An edit to a meta field that doesn't change it stamps nothing.
    const before = ST.stampKey(ST.get(p1.id));
    ST.update(p1.id, { name: ST.get(p1.id).meta.name });
    ok(ST.stampKey(ST.get(p1.id)) === before && !ST.edited(p1.id), 'an unchanged save is not an edit');

    // The page's automatic sync (pullOnly) never writes: with an edited bench it does nothing at all.
    await tick(); ST.update(p1.id, { name: 'Edited, not pressed' });
    const c1 = gh.stats.commits;
    const auto = await sync(gh, { pullOnly: true });
    ok(auto.skipped && gh.stats.commits === c1 && ST.edited(p1.id), 'the automatic sync skips while a bench is edited, and writes nothing');
    await sync(gh);
    // A bench made and deleted before it ever synced is never written, and isn't counted as unsynced.
    const ghost = ST.create({ name: 'Never synced', project: 'Smart Thermostat' });
    ST.remove(ghost.id);
    ok(!ST.edited(ghost.id) && ST.unsynced().length === 0, 'a never-synced deleted bench is not unsynced');
    const c2 = gh.stats.commits;
    const rg = await sync(gh);
    ok(rg.pushed === 0 && gh.stats.commits === c2 && !files(gh).some((f) => f.indexOf(ghost.id) >= 0), 'a never-synced deleted bench is never written', JSON.stringify(files(gh)));
    // With nothing edited, the automatic sync pulls another browser's change.
    ST.setNamespace(A); await sync(gh);
    ST.setNamespace(B); await tick(); ST.update(p1.id, { project: 'Smart Thermostat 2' }); await sync(gh);
    ST.setNamespace(A);
    const c3 = gh.stats.commits;
    await sync(gh, { pullOnly: true });
    ok(ST.get(p1.id).meta.project === 'Smart Thermostat 2' && gh.stats.commits === c3, 'the automatic sync pulls when nothing here is edited');

    // Signed out: sync refuses.
    let refused = false; try { await ST.sync({ token: '', fetch: gh.fetch }); } catch (e) { refused = /Sign in/.test(e.message); }
    ok(refused, 'sync without a token refuses');
  } catch (e) {
    fail++; say('bad', 'ERROR ' + (e && e.stack || e));
    document.title = 'ERROR';
  } finally {
    clear();
  }
  say(fail ? 'bad' : 'ok', pass + ' passed, ' + fail + ' failed');
  if (document.title !== 'ERROR') document.title = fail ? 'FAIL' : 'PASS';
})();
