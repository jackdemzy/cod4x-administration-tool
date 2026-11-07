import { useEffect, useRef, useState } from 'react';
import { b3PluginMessage } from './b3-plugin-messages.mjs';

// Block 16b: "Plugins" section of the B3 view. Config text needs config.manage,
// code text and custom-plugin creation need b3.plugins.code; without the
// matching permission the text is never fetched and never rendered.
const STATE_TEXT = {
  ENABLED: ['Aktiv', 'Enabled'],
  DISABLED: ['Inaktiv', 'Disabled'],
  NOT_APPROVED: ['Nicht freigegeben', 'Not approved'],
  INTEGRITY_MISMATCH: ['Datei verändert', 'File changed'],
  MISSING: ['Datei fehlt', 'File missing'],
  UNAVAILABLE: ['Nicht verfügbar', 'Unavailable'],
};
const EXTRA_REASON = { B3_PLUGIN_PARSER_UNSUPPORTED: ['Nicht unterstützt (Parser fehlt).', 'Not supported (parser missing).'] };
const WARNING = ['Dieser Code läuft mit den Rechten des B3-Prozesses.', 'This code runs with the rights of the B3 process.'];
const TRUST = ['Ich habe diese Datei geprüft und vertraue ihr', 'I checked this file and trust it'];
const RELOAD = ['Neu laden', 'Reload'];
const PY_NOTE = ['Python-Module werden beim B3-Start geprüft.', 'Python modules are checked at B3 start.'];
const REQUIRES = ['Benötigt', 'Requires'];
// A trust tick only counts for the exact file content the user saw.
export const trustKey = (name, sha256) => `${name}:${sha256}`;
const reasonText = (code, lang) => (EXTRA_REASON[code] ? EXTRA_REASON[code][lang === 'en' ? 1 : 0] : b3PluginMessage(code, lang));

function EditorForm({ editor, de, busy, onSave, onClose, onReload }) {
  const [text, setText] = useState(editor.text);
  return <div role="group" aria-label={`${editor.kind} ${editor.name}`}>
    <p><strong>{editor.name}</strong> – {editor.kind === 'code' ? (de ? 'Code' : 'Code') : (de ? 'Konfiguration' : 'Config')}</p>
    {editor.kind === 'code' && <p role="note">{WARNING[de ? 0 : 1]}</p>}
    <textarea spellCheck={false} style={{ fontFamily: 'monospace', width: '100%', minHeight: 220 }} value={text} disabled={busy} onChange={event => setText(event.target.value)} aria-label={`${editor.kind} ${editor.name}`}/>
    <button disabled={busy} onClick={() => onSave(text)}>{de ? 'Speichern' : 'Save'}</button>
    {editor.conflict && <p role="alert">{b3PluginMessage('B3_PLUGIN_FILE_CHANGED', de ? 'de' : 'en')}</p>}
    {editor.conflict && <button disabled={busy} onClick={() => onReload()}>{RELOAD[de ? 0 : 1]}</button>}
    <button disabled={busy} onClick={onClose}>{de ? 'Schließen' : 'Close'}</button>
  </div>;
}

export function B3PluginsPanel({ data, permissions = {}, de, busy, editor, onToggle, onApprove, onOpenConfig, onOpenCode, onSaveEditor, onReloadEditor, onReloadList, staleList, onCloseEditor, onCreate, onDelete, initialTrusted = {} }) {
  const [trusted, setTrusted] = useState(initialTrusted);
  const [newName, setNewName] = useState('');
  const lang = de ? 'de' : 'en';
  const { manage, code } = permissions;
  const plugins = data?.plugins || [];
  // Editor content is only rendered for a viewer holding the matching permission.
  const visibleEditor = editor && ((editor.kind === 'config' && manage) || (editor.kind === 'code' && code)) ? editor : null;
  const upload = async event => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    const text = await file.text();
    onCreate({ name: file.name.replace(/\.py$/i, '').toLowerCase(), code: text });
  };
  return <fieldset>
    <legend>{de ? 'Plugins' : 'Plugins'}</legend>
    {staleList && <p role="alert">{b3PluginMessage('B3_PLUGIN_FILE_CHANGED', lang)} <button disabled={busy} onClick={onReloadList}>{RELOAD[de ? 0 : 1]}</button></p>}
    {data?.restart && <p role="status">{b3PluginMessage(data.restart, lang)}</p>}
    <table>
      <thead><tr>
        <th>{de ? 'Plugin' : 'Plugin'}</th><th>{de ? 'Quelle' : 'Source'}</th><th>{de ? 'Voraussetzungen' : 'Requirements'}</th><th>{de ? 'Status' : 'State'}</th><th>{de ? 'Aktionen' : 'Actions'}</th>
      </tr></thead>
      <tbody>{plugins.map(plugin => {
        const fixed = plugin.source === 'fixed';
        const custom = plugin.source === 'custom';
        const tick = trustKey(plugin.name, plugin.sha256);
        // A shipped module that changed again after its approval can be approved again (custom code is re-trusted by saving it).
        const approvable = Boolean(plugin.sha256) && (plugin.state === 'NOT_APPROVED' || (plugin.state === 'INTEGRITY_MISMATCH' && plugin.source === 'shipped'));
        const stateText = (STATE_TEXT[plugin.state] || [plugin.state, plugin.state])[de ? 0 : 1];
        const needs = plugin.requires?.plugins || [], modules = plugin.requires?.pythonModules || [];
        const missing = needs.filter(need => !plugins.some(other => other.name === need && (other.source === 'fixed' || other.state === 'ENABLED')));
        return <tr key={plugin.name} style={fixed ? { opacity: 0.6 } : undefined}>
          <td>{plugin.name}</td>
          <td>{plugin.source}</td>
          <td>{needs.length > 0 && <div>{REQUIRES[de ? 0 : 1]}: {needs.join(', ')}</div>}
            {modules.length > 0 && <div>Python: {modules.join(', ')} – {PY_NOTE[de ? 0 : 1]}</div>}
            {missing.length > 0 && <div role="alert">{b3PluginMessage('B3_PLUGIN_REQUIRES_PLUGIN', lang)} ({missing.join(', ')})</div>}</td>
          <td>{stateText}
            {plugin.reason && <div>{reasonText(plugin.reason, lang)}</div>}
            {approvable && <div>
              <code>{plugin.sha256}</code>
              {plugin.modulePath && <div>{de ? 'Pfad' : 'Path'}: <code>{plugin.modulePath}</code></div>}
              {manage && <label style={{ display: 'block' }}><input type="checkbox" checked={Boolean(trusted[tick])} disabled={busy} onChange={event => setTrusted({ ...trusted, [tick]: event.target.checked })}/> {TRUST[de ? 0 : 1]}</label>}
              {manage && <button disabled={busy || !trusted[tick]} onClick={() => onApprove(plugin.name, plugin.sha256)}>{de ? 'Freigeben' : 'Approve'}</button>}
            </div>}
          </td>
          <td>
            {!fixed && manage && (plugin.enabled
              ? <button disabled={busy} onClick={() => onToggle(plugin.name, false)}>{de ? 'Deaktivieren' : 'Disable'}</button>
              : <button disabled={busy || plugin.state === 'UNAVAILABLE'} onClick={() => onToggle(plugin.name, true)}>{de ? 'Aktivieren' : 'Enable'}</button>)}
            {!fixed && manage && plugin.configType && <button disabled={busy} onClick={() => onOpenConfig(plugin.name)}>{de ? 'Konfiguration' : 'Config'}</button>}
            {custom && code && <button disabled={busy} onClick={() => onOpenCode(plugin.name)}>{de ? 'Code' : 'Code'}</button>}
            {custom && code && <button disabled={busy} onClick={() => onDelete(plugin.name)}>{de ? 'Löschen' : 'Delete'}</button>}
          </td>
        </tr>;
      })}</tbody>
    </table>
    {visibleEditor && <EditorForm key={`${visibleEditor.kind}:${visibleEditor.name}:${visibleEditor.sha256}`} editor={visibleEditor} de={de} busy={busy} onSave={onSaveEditor} onClose={onCloseEditor} onReload={onReloadEditor}/>}
    {code && <div>
      <h4>{de ? 'Eigene Plugins' : 'Custom plugins'}</h4>
      <p role="note">{WARNING[de ? 0 : 1]}</p>
      <label>{de ? 'Pluginname' : 'Plugin name'} <input type="text" value={newName} maxLength={32} disabled={busy} onChange={event => setNewName(event.target.value)}/></label>
      <button disabled={busy || !newName} onClick={() => { onCreate({ name: newName, from: 'template' }); setNewName(''); }}>{de ? 'Neues Plugin aus Vorlage' : 'New plugin from template'}</button>
      <label style={{ display: 'block' }}>{de ? '.py-Datei hochladen' : 'Upload .py file'} <input type="file" accept=".py" disabled={busy} onChange={upload}/></label>
    </div>}
  </fieldset>;
}

export function InstanceB3Plugins({ instance, request, de }) {
  const [data, setData] = useState(null), [permissions, setPermissions] = useState({ manage: false, code: false });
  const [editor, setEditor] = useState(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(null), [staleList, setStaleList] = useState(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const base = `/api/instances/${encodeURIComponent(instance.id)}/b3/plugins`;
  const lang = de ? 'de' : 'en';
  async function call(route, body, method = body === undefined ? 'GET' : 'POST') {
    const response = await request(route, method === 'GET' ? undefined : { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const result = await response.json();
    if (!response.ok) throw Object.assign(new Error(result.code || `HTTP ${response.status}`), { line: result.line });
    return result;
  }
  async function run(task) {
    setBusy(true); setError(null); setStaleList(false);
    try { await task(); } catch (failure) { if (mounted.current) setError({ code: failure.message, line: failure.line }); }
    finally { if (mounted.current) setBusy(false); }
  }
  const refresh = async () => { const result = await call(base); if (mounted.current) setData(result); };
  const load = () => run(async () => {
    const me = await call('/api/rbac/me');
    if (mounted.current) setPermissions({ manage: me.permissions?.includes('config.manage') === true, code: me.permissions?.includes('b3.plugins.code') === true });
    await refresh();
  });
  const name = encodeURIComponent;
  return <details style={{ marginTop: 12 }} onToggle={event => { if (event.currentTarget.open && !data) void load(); }}>
    <summary>{de ? 'Plugins (eBc-B3)' : 'Plugins (eBc-B3)'}</summary>
    {error && <p role="alert">{b3PluginMessage(error.code, lang)}{Number.isInteger(error.line) && ` (${de ? 'Zeile' : 'line'} ${error.line})`}</p>}
    {data && <B3PluginsPanel data={data} permissions={permissions} de={de} busy={busy} editor={editor} staleList={staleList}
      onToggle={(plugin, enabled) => run(async () => { await call(`${base}/${name(plugin)}/${enabled ? 'enable' : 'disable'}`, {}); await refresh(); })}
      onApprove={(plugin, sha256) => run(async () => {
        try { await call(`${base}/${name(plugin)}/approve`, { sha256 }); } catch (failure) {
          // The file changed after the hash was shown: say so and re-read the list.
          if (failure.message === 'B3_PLUGIN_CONFLICT') { if (mounted.current) setStaleList(true); await refresh(); return; }
          throw failure;
        }
        await refresh();
      })}
      onReloadList={() => run(async () => { await refresh(); })}
      onOpenConfig={plugin => run(async () => { const { config } = await call(`${base}/${name(plugin)}/config`); if (mounted.current) setEditor({ kind: 'config', name: plugin, text: config.text, sha256: config.sha256 }); })}
      onOpenCode={plugin => run(async () => { const { code } = await call(`${base}/custom/${name(plugin)}/code`); if (mounted.current) setEditor({ kind: 'code', name: plugin, text: code.code, sha256: code.sha256 }); })}
      onSaveEditor={text => run(async () => {
        let saved;
        try {
          saved = editor.kind === 'config'
            ? (await call(`${base}/${name(editor.name)}/config`, { text, expectedSha256: editor.sha256 }, 'PUT')).config
            : (await call(`${base}/custom/${name(editor.name)}/code`, { code: text, expectedSha256: editor.sha256 }, 'PUT')).code;
        } catch (failure) {
          // Stale hash: keep the editor (and its draft) open and offer a reload instead of a misleading name error.
          if (failure.message === 'B3_PLUGIN_CONFLICT') { if (mounted.current) setEditor({ ...editor, conflict: true }); return; }
          throw failure;
        }
        if (mounted.current) setEditor({ ...editor, text, sha256: saved.sha256, conflict: false });
        await refresh();
      })}
      onReloadEditor={() => run(async () => {
        const current = editor.kind === 'config'
          ? (await call(`${base}/${name(editor.name)}/config`)).config
          : (await call(`${base}/custom/${name(editor.name)}/code`)).code;
        if (mounted.current) setEditor({ kind: editor.kind, name: editor.name, text: editor.kind === 'config' ? current.text : current.code, sha256: current.sha256 });
      })}
      onCloseEditor={() => setEditor(null)}
      onCreate={body => run(async () => { await call(`${base}/custom`, body); await refresh(); })}
      onDelete={plugin => run(async () => { await call(`${base}/custom/${name(plugin)}`, undefined, 'DELETE'); if (mounted.current && editor?.name === plugin) setEditor(null); await refresh(); })}/>}
  </details>;
}
