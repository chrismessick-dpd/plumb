// Plumb's projects, in this browser and on GitHub (Chris, 2026-11-24: "a new Plumb project, that can be associated
// with an EE board; by default GitHub stores a project's tests, and stored runs come later").
//
// A Plumb project is one bench: its target definitions and its tests, both text. It names its client project and,
// optionally, the Signoff EE board it tests (as Fabcheck's runs do). The private data repo `plumb_data` holds one
// file per project, shaped like a Signoff review so the engine's GitHubStore syncs it:
//
//   projects/<id>.json   { schema: 1, id, meta: { name, project, board: { id, name } | null, deleted,
//                          updatedAt, updatedBy }, bench: { defs, script }, summary: { … derived … } }
//
// `bench` is the truth; `summary` is derived whenever the file is written. Merging is whole-document and three-way,
// as Loom's systems (loom/assets/store.js): each project's stamp (meta.updatedAt|updatedBy) as of the last sync is
// kept in `bases`, written only when a sync ends, so a tab that didn't sync never writes an older one. Edited here
// means the stamp moved off its base. Then: not edited → GitHub's copy is taken and nothing is written; GitHub's
// still the base → ours; both moved on → the newer wins and the other is kept as a new project named
// "(conflict copy)", so nothing is lost.
//
// Demo (`?demo`) keeps everything in this browser under its own keys and never reaches GitHub.
(function (PL) {
  'use strict';
  const SG = window.Signoff || {};
  const M = () => SG.model || {};
  const DEMO = /[?&]demo\b/.test(location.search);
  let NS = DEMO ? 'plumb.demo.' : 'plumb.v1.';
  const CFG = { owner: 'chrismessick-dpd', dataRepo: 'plumb_data', branch: 'main' };
  const EE_NS = DEMO ? 'signoff.demo.' : 'signoff.v1.';

  const read = (k, d) => { try { const v = JSON.parse(localStorage.getItem(NS + k) || 'null'); return v == null ? d : v; } catch (e) { return d; } };
  const write = (k, v) => { try { localStorage.setItem(NS + k, JSON.stringify(v)); return true; } catch (e) { return false; } };
  const uid = () => 'b' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const nowIso = () => new Date().toISOString();
  function token() {
    const clean = t => String(t || '').replace(/[\s​-‍⁠﻿]/g, '');
    try { return clean(sessionStorage.getItem('signoff.token') || localStorage.getItem('signoff.token') || ''); } catch (e) { return ''; }
  }
  function who() { const w = window.SignoffFoot ? window.SignoffFoot.who() : {}; return w.login ? '@' + w.login : (DEMO ? 'demo visitor' : 'this browser'); }
  const stampKey = d => (d && d.meta ? (d.meta.updatedAt || '') + '|' + (d.meta.updatedBy || '') : '');

  // ── Projects in this browser ──
  let projects = read('projects', {});
  function save() { return write('projects', projects); }
  function list() {
    return Object.keys(projects).map(id => projects[id]).filter(p => p && p.meta && !p.meta.deleted)
      .sort((a, b) => (a.meta.project || '').localeCompare(b.meta.project || '') || (a.meta.name || '').localeCompare(b.meta.name || ''));
  }
  const get = id => (projects[id] && !projects[id].meta.deleted ? projects[id] : null);
  function stamp(p) { p.meta.updatedAt = nowIso(); p.meta.updatedBy = who(); }
  function create(o) {
    const p = { schema: 1, id: o.id || uid(), meta: { name: o.name || 'New bench', project: o.project || '', board: o.board || null }, bench: { defs: o.defs || '', script: o.script || '' } };
    stamp(p); projects[p.id] = p; save();
    return p;
  }
  // Change a project's meta fields or bench text. Nothing changed: nothing stamped, so it isn't "edited".
  function update(id, patch) {
    const p = projects[id]; if (!p) return null;
    let changed = false;
    ['name', 'project', 'board', 'deleted'].forEach(k => {
      if (!(k in patch)) return;
      if (JSON.stringify(p.meta[k] == null ? null : p.meta[k]) !== JSON.stringify(patch[k] == null ? null : patch[k])) { p.meta[k] = patch[k]; changed = true; }
    });
    ['defs', 'script'].forEach(k => { if (k in patch && p.bench[k] !== patch[k]) { p.bench[k] = patch[k]; changed = true; } });
    if (changed) { stamp(p); save(); }
    return p;
  }
  const remove = id => update(id, { deleted: true });   // a tombstone, so the deletion syncs

  // Edited here since the last sync: a project with no base was never synced from this browser.
  const bases = () => read('bases', {});
  // A bench made and deleted here before it ever synced is nobody's business but this browser's: not edited, never
  // written.
  const neverSynced = id => !bases()[id];
  const edited = id => !!projects[id] && stampKey(projects[id]) !== bases()[id] && !(projects[id].meta.deleted && neverSynced(id));
  const unsynced = () => Object.keys(projects).filter(edited);

  // ── Signoff EE's boards, read from EE's working copy in this browser (as Fabcheck's Send does) ──
  let eeBoards = [];
  function loadBoards() {
    const fromMap = map => Object.keys(map || {}).map(slug => map[slug]).filter(p => p && p.id && p.meta && !p.meta.archived && !p.meta.deleted)
      .map(p => ({ id: p.id, name: p.meta.name || p.id, project: p.meta.project || '' }))
      .sort((a, b) => a.project.localeCompare(b.project) || a.name.localeCompare(b.name));
    const L = window.SignoffLocal ? window.SignoffLocal.store(EE_NS) : null;
    const fallback = () => { try { return JSON.parse(localStorage.getItem(EE_NS + 'projects') || '{}'); } catch (e) { return {}; } };
    const p = L ? L.load().then(d => (d && Object.keys(d.projects || {}).length ? d.projects : fallback()), fallback) : Promise.resolve(fallback());
    return p.then(map => { eeBoards = fromMap(map); return eeBoards; });
  }
  const boards = () => eeBoards;

  // ── Sync with plumb_data ──
  function summarize(doc) {
    const defs = doc.bench.defs || '', script = doc.bench.script || '';
    return { v: 1, tool: 'plumb', name: doc.meta.name, project: doc.meta.project || '', board: doc.meta.board || null,
      targets: (defs.match(/^\s*target\s+/gm) || []).length, tests: (script.match(/^\s*test\s+/gm) || []).length };
  }
  function bare(d) { const c = JSON.parse(JSON.stringify(d)); delete c.summary; return c; }
  function conflictCopy(lose) {
    const c = bare(lose);
    c.id = uid(); c.meta.name = (c.meta.name || 'Bench') + ' (conflict copy)'; c.meta.updatedAt = nowIso(); c.meta.updatedBy = who();
    return c;
  }
  function threeWay(local, remote, base, conflicts) {
    if (!local) return remote;
    if (!remote) return local;
    const lk = stampKey(local), rk = stampKey(remote);
    if (lk === rk || (base && lk === base)) return remote;
    if (base && rk === base) return local;
    const win = (local.meta.updatedAt || '') > (remote.meta.updatedAt || '') ? local : remote;
    conflicts.push(conflictCopy(win === local ? remote : local));
    return win;
  }

  // A fetch that reads GitHub for real and records the commit a write would make instead of sending it, so a dry
  // run is the very sync, stopped at the door. Resolves the files it would have written in `rec.files`.
  function dryFetch(real) {
    const rec = { files: [], blobs: {}, n: 0, ref: null };
    const ok = data => new Response(JSON.stringify(data), { status: 201, headers: { 'Content-Type': 'application/json' } });
    rec.fetch = async (url, opts) => {
      const m = (opts && opts.method) || 'GET';
      if (m === 'GET') return real(url, opts);
      const u = new URL(url), body = opts && opts.body ? JSON.parse(opts.body) : {};
      if (/\/git\/blobs$/.test(u.pathname)) {
        const sha = 'dry' + (++rec.n).toString(16).padStart(37, '0');
        rec.blobs[sha] = body.encoding === 'base64' ? decodeURIComponent(escape(atob(body.content))) : body.content;
        return ok({ sha });
      }
      if (/\/git\/trees$/.test(u.pathname)) {
        (body.tree || []).forEach(t => rec.files.push({ path: t.path, text: t.sha === null ? null : (rec.blobs[t.sha] != null ? rec.blobs[t.sha] : t.content) }));
        return ok({ sha: 'drytree' });
      }
      if (/\/git\/commits$/.test(u.pathname)) { rec.message = body.message; return ok({ sha: 'drycommit', html_url: '' }); }
      if (/\/git\/refs\//.test(u.pathname)) { rec.ref = true; return ok({ object: { sha: 'drycommit' } }); }
      return new Response(JSON.stringify({ message: 'dry run: ' + m + ' ' + u.pathname + ' not sent' }), { status: 400 });
    };
    return rec;
  }

  // Sync every project with plumb_data. opts.dry: read for real, write nothing, resolve what would be written.
  // opts.pullOnly: only when nothing here is edited (the page's automatic sync on load and sign-in), so a sync
  //   Chris didn't press never writes (2026-11-24: the first write waits for a Preview he has seen).
  // opts.fetch: a fake GitHub (tests). Resolves { pushed, conflicts, gone, dry: { files, message } | null, skipped }.
  async function sync(opts) {
    opts = opts || {};
    if (DEMO) throw new Error('The demo keeps its benches in this browser');
    const tok = opts.token || token();
    if (!tok) throw new Error('Sign in to GitHub first');
    if (opts.pullOnly && unsynced().length) return { pushed: 0, conflicts: [], gone: [], dry: null, skipped: true };
    const real = opts.fetch || window.fetch.bind(window);
    const rec = opts.dry ? dryFetch(real) : null;
    const base = bases(), conflicts = [];
    const docs = {};
    Object.keys(projects).forEach(id => { if (!(projects[id].meta.deleted && !base[id])) docs[id] = bare(projects[id]); });
    const store = new SG.GitHubStore({ owner: CFG.owner, repo: CFG.dataRepo, branch: CFG.branch, dataPath: '', token: tok,
      summarize }, rec ? rec.fetch : real);
    store.cfg.merge = (l, r, o) => threeWay(l, r, o && o.base, conflicts);
    const isEdited = id => edited(id);
    const res = await store.sync(docs, null, read('cache', null), { dropGone: true, keepLocal: isEdited, edited: isEdited,
      mergeOpts: id => ({ base: base[id] || '' }), message: opts.message || 'Plumb: sync benches' });
    if (rec) return { pushed: 0, conflicts, gone: res.gone || [], dry: { files: rec.files, message: rec.message || null } };
    // Take the merged copies, but keep an edit made here while the sync ran (its stamp moved on meanwhile).
    const next = {}, nextBases = {};
    Object.keys(res.projects).forEach(id => {
      const d = res.projects[id]; if (!d || d.id !== id) return;
      const c = bare(d);
      if (projects[id] && docs[id] && stampKey(projects[id]) !== stampKey(docs[id])) {
        // Edited here while the sync ran. Its base is what GitHub now has only if that is the copy the edit started
        // from; otherwise keep the old base, so the next sync sees both sides moved and keeps a conflict copy.
        next[id] = projects[id];
        nextBases[id] = stampKey(c) === stampKey(docs[id]) ? stampKey(c) : (base[id] || '');
      } else { next[id] = c; nextBases[id] = stampKey(c); }
    });
    (res.gone || []).forEach(id => { delete next[id]; });
    Object.keys(projects).forEach(id => { if (!(id in next) && (res.gone || []).indexOf(id) < 0) next[id] = projects[id]; });
    conflicts.forEach(c => { next[c.id] = c; });   // new, unsynced: the next sync writes them
    projects = next; save();
    write('cache', res.cache); write('bases', nextBases); write('lastSync', { at: nowIso(), by: who(), pushed: res.pushed || 0 });
    return { pushed: res.pushed || 0, conflicts, gone: res.gone || [], commitUrl: res.commitUrl || null, dry: null };
  }
  const lastSync = () => read('lastSync', null);

  // Tests use their own keys.
  function setNamespace(ns) { NS = ns; projects = read('projects', {}); }

  PL.store = { DEMO, CFG, list, get, create, update, remove, edited, unsynced, loadBoards, boards, sync, lastSync,
    summarize, threeWay, dryFetch, stampKey, setNamespace, reload: () => { projects = read('projects', {}); }, token };
})(window.PLUMB = window.PLUMB || {});
