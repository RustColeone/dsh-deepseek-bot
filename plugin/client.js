// dsh-hub's page in DSH (the desktop app, or DSH's web page): Plugins → dsh-hub. It shows what this computer is (off,
// the hub, or a computer of a hub), how it is doing (the hub's address and its setup code until it has an account; a
// node's connection), and its settings, which it saves through the plugin's routes (plugin/control.js) into the same
// settings file `dsh-hub config` writes. Plain JavaScript and React, which is all DSH's page lends a plugin.
window.__ModuleLoader__.load({
  id: 'dsh-hub',
  factory: require => {
    const module = { exports: {} }
    const imported = require('react')
    const React = typeof imported.createElement === 'function' ? imported : imported.default
    const { useCallback, useEffect, useState } = React
    const h = React.createElement

    const PACKAGE = 'dsh-hub'
    const NS = 'dsh-hub'
    const API = { state: 'api/dsh-hub.state', settings: 'api/dsh-hub.settings', join: 'api/dsh-hub.join', forget: 'api/dsh-hub.forget' }

    const EN = {
      'role.title': 'This computer',
      'role.off': 'Not in a hub',
      'role.hub': 'The hub',
      'role.node': 'A computer of a hub',
      'role.offHelp': 'dsh-hub does nothing here until you choose.',
      'role.hubHelp': 'Serves the chat page for your phone and browsers; your other computers join it.',
      'role.nodeHelp': 'Joins your hub, so its bots can use this computer: its commands, files and agents.',
      'status.off': 'This computer is not part of a hub.',
      'status.starting': 'Starting…',
      'status.hub': 'The hub is running.',
      'status.open': 'Open from your phone or another computer at',
      'status.computers': '{online} of {total} computers online',
      'status.setup': 'No account yet. Make the owner\'s account at {url} with this setup code:',
      'status.setupNote': 'It works once, until the hub restarts. Accounts are always required, even at home.',
      'status.notJoined': 'Not joined to a hub yet.',
      'status.connected': 'Connected to {hub} as “{name}”.',
      'status.away': 'Joined {hub} as “{name}”, not connected right now.',
      'open': 'Open the hub',
      'copy': 'Copy',
      'copied': 'Copied',
      'join.title': 'Join a hub',
      'join.help': 'On the hub\'s page: ⚙️ Settings → Computers → Add gives a pairing code.',
      'join.hub': 'Hub address',
      'join.code': 'Pairing code',
      'join.go': 'Join',
      'join.joining': 'Joining…',
      'forget': 'Forget this hub',
      'forget.confirm': 'Forget the hub this computer joined? It can join one again with a new pairing code.',
      'hub.title': 'Hub settings',
      'hub.port': 'Port',
      'hub.portHelp': 'The page and the computers\' connections (4180).',
      'hub.access': 'Who may reach the sign-in page',
      'hub.access.lan': 'Home network and Tailscale',
      'hub.access.anywhere': 'Anywhere (still behind accounts)',
      'hub.accessHelp': 'For use away from home, Tailscale or WireGuard is safest. Anywhere without https sends passwords readable.',
      'hub.name': 'Page title',
      'hub.hostnames': 'Names it is opened by',
      'hub.hostnamesHelp': 'Comma separated, like rog.tail1234.ts.net. Addresses on this network work without.',
      'hub.upload': 'Largest attachment (MB)',
      'hub.permission': 'The hub\'s bots, on this computer',
      'node.title': 'What the hub may do here',
      'node.exec': 'Commands',
      'node.exec.any': 'Any',
      'node.exec.allowlist': 'Only those matching a pattern',
      'node.exec.never': 'None',
      'node.allow': 'Patterns',
      'node.allowHelp': 'Comma separated regular expressions, like ^nvidia-smi, ^video2x ',
      'node.files': 'Files the hub may take from here',
      'node.files.any': 'Any',
      'node.files.folders': 'Only from these folders',
      'node.files.never': 'None',
      'node.folders': 'Folders',
      'node.foldersHelp': 'Comma separated, like ~/Videos, ~/Downloads',
      'node.inbox': 'Where files from the hub land',
      'node.inboxHelp': 'Empty: {folder}',
      'node.bots': 'Bots added from the hub',
      'node.bots.any': 'May live here',
      'node.bots.own': 'Only this computer\'s own',
      'node.tasks': 'Tasks from hub bots',
      'node.tasks.any': 'Taken',
      'node.tasks.never': 'Refused',
      'node.permission': 'Agents living here',
      'permission.workspace-write': 'Work in their folder, ask before the rest',
      'permission.danger-full-access': 'May do anything without asking',
      'permission.help': 'DSH\'s approvals show up as cards in the hub\'s chat.',
      'locked': 'set in this profile\'s cordis.patch.yml',
      'save': 'Save',
      'saving': 'Saving…',
      'saved': 'Saved. The change is running.',
      'cli': 'On the command line too: dsh-hub config (settings in {file}).',
      'error.load': 'Couldn\'t read dsh-hub\'s state: {error}',
    }

    const format = (text, values) => String(text).replace(/\{(\w+)\}/g, (all, key) => (values && values[key] !== undefined ? values[key] : all))
    const wordsOf = words => (key, values) => {
      const found = typeof words === 'function' ? words(key) : undefined
      return format(found && found !== key ? found : (EN[key] ?? key), values)
    }

    async function get (route) {
      const response = await fetch(route, { cache: 'no-store', credentials: 'same-origin' })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`)
      return body
    }
    async function post (route, body) {
      const response = await fetch(route, { method: 'POST', cache: 'no-store', credentials: 'same-origin',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) })
      const answer = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(answer.error || `HTTP ${response.status}`)
      return answer
    }

    const joined = value => (Array.isArray(value) ? value.join(', ') : value ?? '')
    /** The page's draft of the settings file: strings for the fields, as the inputs hold them. */
    function draftOf (settings) {
      const hub = settings.hub || {}
      const node = settings.node || {}
      const policy = node.policy || {}
      return {
        role: settings.role || '',
        hub: { port: hub.port ?? '', access: hub.access ?? '', title: hub.title ?? '', hostnames: joined(hub.hostnames),
          maxUploadMB: hub.maxUploadMB ?? '', permission: hub.permission ?? '' },
        node: { hub: node.hub ?? '', permission: node.permission ?? '',
          policy: { exec: policy.exec ?? '', allow: joined(policy.allow), files: policy.files ?? '', folders: joined(policy.folders),
            inbox: policy.inbox ?? '', bots: policy.bots ?? '', tasks: policy.tasks ?? '' } },
      }
    }
    const at = (object, where) => where.split('.').reduce((value, key) => (value == null ? undefined : value[key]), object)
    function withValue (object, where, value) {
      const copy = JSON.parse(JSON.stringify(object))
      const keys = where.split('.')
      let place = copy
      for (const key of keys.slice(0, -1)) place = place[key]
      place[keys.at(-1)] = value
      return copy
    }

    function Copy ({ text, t }) {
      const [done, setDone] = useState(false)
      return h('button', { type: 'button', className: 'dh-button', onClick: () => {
        navigator.clipboard?.writeText(text).then(() => { setDone(true); setTimeout(() => setDone(false), 1500) }).catch(() => {})
      } }, done ? t('copied') : t('copy'))
    }

    function Status ({ state, t, onForget }) {
      const status = state.status || {}
      if (state.role === 'hub') {
        if (!status.running) {
          return h('div', { className: `dh-status${status.error ? ' dh-bad' : ''}` }, status.error || t('status.starting'))
        }
        const others = (status.urls || []).filter(url => !/localhost|127\.0\.0\.1|\[::1\]/.test(url))
        const local = `http://localhost:${status.port}/`
        return h('div', { className: 'dh-status dh-good' },
          h('div', { className: 'dh-line' }, h('strong', null, t('status.hub')), ' ',
            t('status.computers', { online: status.computers?.online ?? 0, total: status.computers?.total ?? 0 })),
          others.length > 0 && h('div', { className: 'dh-line' }, t('status.open'), ' ',
            others.map(url => h('code', { key: url, className: 'dh-code' }, url))),
          status.setupCode && h('div', { className: 'dh-setup' },
            h('div', null, t('status.setup', { url: `${local}setup` })),
            h('div', { className: 'dh-row' }, h('code', { className: 'dh-big' }, status.setupCode), h(Copy, { text: status.setupCode, t })),
            h('div', { className: 'dh-help' }, t('status.setupNote'))),
          h('div', { className: 'dh-row' }, h('a', { className: 'dh-button dh-primary', href: status.setupCode ? `${local}setup` : local,
            target: '_blank', rel: 'noreferrer' }, t('open'))))
      }
      if (state.role === 'node') {
        if (!status.joined) {
          return h('div', { className: `dh-status${status.error ? ' dh-bad' : ''}` }, status.error || status.problem || t('status.notJoined'))
        }
        return h('div', { className: `dh-status ${status.connected ? 'dh-good' : 'dh-bad'}` },
          h('div', { className: 'dh-line' }, t(status.connected ? 'status.connected' : 'status.away', { hub: status.hub, name: status.name })),
          !status.connected && status.problem && h('div', { className: 'dh-help' }, status.problem),
          h('div', { className: 'dh-row' }, h('button', { type: 'button', className: 'dh-button dh-danger', onClick: onForget }, t('forget'))))
      }
      return h('div', { className: 'dh-status' }, t('status.off'))
    }

    function Field ({ label, help, locked, t, children }) {
      return h('label', { className: 'dh-field' },
        h('span', { className: 'dh-label' }, label, locked && h('span', { className: 'dh-locked' }, ` · ${t('locked')}`)),
        children,
        help && h('span', { className: 'dh-help' }, help))
    }

    /** `initial`: a state to start from instead of the first read (the tests render the page with one). */
    function HubSettings ({ t: words, initial = null }) {
      const t = wordsOf(words)
      const [state, setState] = useState(initial)
      const [draft, setDraft] = useState(initial ? draftOf(initial.settings || {}) : null)
      const [dirty, setDirty] = useState(false)
      const [busy, setBusy] = useState('')
      const [message, setMessage] = useState(null) // { text, bad }
      const [join, setJoin] = useState({ hub: '', code: '' })

      const load = useCallback(async ({ keep } = {}) => {
        try {
          const next = await get(API.state)
          setState(next)
          if (!keep) setDraft(draftOf(next.settings || {}))
          return next
        } catch (error) {
          setMessage({ text: t('error.load', { error: error.message }), bad: true })
        }
      }, [])
      useEffect(() => { load() }, [load])
      // the status moves on its own (computers come and go, the account gets made): read it again now and then
      useEffect(() => {
        const timer = setInterval(() => { if (!document.hidden) load({ keep: true }) }, 3000)
        return () => clearInterval(timer)
      }, [load])

      if (!state || !draft) return h('div', { className: 'dh-page' }, message ? h('div', { className: 'dh-message dh-bad' }, message.text) : t('status.starting'))

      const locked = where => (state.locked || []).includes(where)
      const shown = where => (locked(where) ? joined(at(state.config, where.split('.').slice(1).join('.'))) : at(draft, where))
      const role = locked('role') ? state.role : (draft.role || state.role)
      const set = (where, value) => { setDraft(withValue(draft, where, value)); setDirty(true); setMessage(null) }

      const input = (where, props = {}) => h('input', {
        className: `dh-input${props.mono ? ' dh-mono' : ''}`, value: shown(where), disabled: locked(where) || Boolean(busy),
        placeholder: props.placeholder, inputMode: props.inputMode, spellCheck: false,
        onChange: event => set(where, event.target.value),
      })
      const choice = (where, options, fallback) => h('select', {
        className: 'dh-input dh-select', value: shown(where) || fallback, disabled: locked(where) || Boolean(busy),
        onChange: event => set(where, event.target.value),
      }, options.map(([value, label]) => h('option', { key: value, value }, label)))
      const permission = where => choice(where, [['workspace-write', t('permission.workspace-write')], ['danger-full-access', t('permission.danger-full-access')]], 'workspace-write')

      const act = async (what, work) => {
        setBusy(what)
        setMessage(null)
        try {
          const next = await work()
          setState(next)
          setDraft(draftOf(next.settings || {}))
          setDirty(false)
          return next
        } catch (error) {
          setMessage({ text: error.message, bad: true })
        } finally { setBusy('') }
      }
      const save = () => act('save', async () => {
        const next = await post(API.settings, { ...draft, role })
        setMessage({ text: t('saved') })
        return next
      })
      const doJoin = () => act('join', async () => {
        const next = await post(API.join, join)
        setJoin({ hub: '', code: '' })
        return next
      })
      const forget = () => {
        if (!window.confirm(t('forget.confirm'))) return
        act('forget', () => post(API.forget))
      }

      const roles = ['off', 'hub', 'node']
      const policy = draft.node.policy
      const nodeJoined = state.role === 'node' && state.status?.joined
      return h('div', { className: 'dh-page' },
        h(Status, { state, t, onForget: forget }),

        h('section', { className: 'dh-section' },
          h('h3', null, t('role.title'), locked('role') && h('span', { className: 'dh-locked' }, ` · ${t('locked')}`)),
          h('div', { className: 'dh-roles', role: 'radiogroup' }, roles.map(id => h('button', {
            key: id, type: 'button', role: 'radio', 'aria-checked': role === id,
            className: `dh-role${role === id ? ' dh-on' : ''}`, disabled: locked('role') || Boolean(busy),
            onClick: () => { setDraft({ ...draft, role: id }); setDirty(true); setMessage(null) },
          }, h('strong', null, t(`role.${id}`)), h('span', null, t(`role.${id}Help`)))))),

        role === 'hub' && h('section', { className: 'dh-section' },
          h('h3', null, t('hub.title')),
          h('div', { className: 'dh-grid' },
            h(Field, { label: t('hub.port'), help: t('hub.portHelp'), locked: locked('hub.port'), t }, input('hub.port', { placeholder: '4180', inputMode: 'numeric' })),
            h(Field, { label: t('hub.access'), help: t('hub.accessHelp'), locked: locked('hub.access'), t },
              choice('hub.access', [['lan', t('hub.access.lan')], ['anywhere', t('hub.access.anywhere')]], 'lan')),
            h(Field, { label: t('hub.name'), locked: locked('hub.title'), t }, input('hub.title', { placeholder: 'Hub' })),
            h(Field, { label: t('hub.upload'), locked: locked('hub.maxUploadMB'), t }, input('hub.maxUploadMB', { placeholder: '2048', inputMode: 'numeric' })),
            h(Field, { label: t('hub.hostnames'), help: t('hub.hostnamesHelp'), locked: locked('hub.hostnames'), t }, input('hub.hostnames', { mono: true })),
            h(Field, { label: t('hub.permission'), help: t('permission.help'), locked: locked('hub.permission'), t }, permission('hub.permission')))),

        role === 'node' && !nodeJoined && h('section', { className: 'dh-section' },
          h('h3', null, t('join.title')),
          h('div', { className: 'dh-help' }, t('join.help')),
          h('div', { className: 'dh-grid' },
            h(Field, { label: t('join.hub'), t }, h('input', { className: 'dh-input dh-mono', value: join.hub, placeholder: 'http://192.168.1.10:4180',
              spellCheck: false, disabled: Boolean(busy), onChange: event => setJoin({ ...join, hub: event.target.value }) })),
            h(Field, { label: t('join.code'), t }, h('input', { className: 'dh-input dh-mono', value: join.code, placeholder: 'ABCD-EFGH',
              spellCheck: false, autoCapitalize: 'characters', disabled: Boolean(busy), onChange: event => setJoin({ ...join, code: event.target.value }) }))),
          h('div', { className: 'dh-row' }, h('button', { type: 'button', className: 'dh-button dh-primary',
            disabled: Boolean(busy) || !join.hub.trim() || !join.code.trim(), onClick: doJoin }, busy === 'join' ? t('join.joining') : t('join.go')))),

        role === 'node' && h('section', { className: 'dh-section' },
          h('h3', null, t('node.title')),
          h('div', { className: 'dh-grid' },
            h(Field, { label: t('node.exec'), locked: locked('node.policy.exec'), t },
              choice('node.policy.exec', [['any', t('node.exec.any')], ['allowlist', t('node.exec.allowlist')], ['never', t('node.exec.never')]], 'any')),
            (shown('node.policy.exec') === 'allowlist') && h(Field, { label: t('node.allow'), help: t('node.allowHelp'), locked: locked('node.policy.allow'), t }, input('node.policy.allow', { mono: true })),
            h(Field, { label: t('node.files'), locked: locked('node.policy.files'), t },
              choice('node.policy.files', [['any', t('node.files.any')], ['folders', t('node.files.folders')], ['never', t('node.files.never')]], 'any')),
            (shown('node.policy.files') === 'folders') && h(Field, { label: t('node.folders'), help: t('node.foldersHelp'), locked: locked('node.policy.folders'), t }, input('node.policy.folders', { mono: true })),
            h(Field, { label: t('node.inbox'), help: t('node.inboxHelp', { folder: `${state.folder}${state.folder.includes('\\') ? '\\' : '/'}inbox` }), locked: locked('node.policy.inbox'), t }, input('node.policy.inbox', { mono: true })),
            h(Field, { label: t('node.bots'), locked: locked('node.policy.bots'), t }, choice('node.policy.bots', [['any', t('node.bots.any')], ['own', t('node.bots.own')]], 'any')),
            h(Field, { label: t('node.tasks'), locked: locked('node.policy.tasks'), t }, choice('node.policy.tasks', [['any', t('node.tasks.any')], ['never', t('node.tasks.never')]], 'any')),
            h(Field, { label: t('node.permission'), help: t('permission.help'), locked: locked('node.permission'), t }, permission('node.permission')))),

        h('div', { className: 'dh-row dh-save' },
          h('button', { type: 'button', className: 'dh-button dh-primary', disabled: Boolean(busy) || !dirty, onClick: save },
            busy === 'save' ? t('saving') : t('save')),
          message && h('span', { className: `dh-message${message.bad ? ' dh-bad' : ''}`, role: message.bad ? 'alert' : 'status' }, message.text)),
        h('div', { className: 'dh-help' }, t('cli', { file: state.file })))
    }

    const CSS = `
.dh-page { display: flex; flex-direction: column; gap: 12px; max-width: 860px; color: var(--dsw-alias-label-primary, inherit) }
.dh-section { display: flex; flex-direction: column; gap: 10px; padding: 12px 14px; border-radius: 12px;
  border: .5px solid var(--dsw-alias-border-l2, rgba(128,128,128,.25)) }
.dh-section h3 { margin: 0; font-size: 13px; letter-spacing: .02em }
.dh-status { display: flex; flex-direction: column; gap: 8px; padding: 12px 14px; border-radius: 12px; font-size: 13px;
  background: var(--dsw-alias-bg-layer-1, rgba(128,128,128,.06)); border: .5px solid var(--dsw-alias-border-l2, rgba(128,128,128,.25)) }
.dh-status.dh-good { border-left: 3px solid var(--dsw-alias-state-business-primary, #4d6bfe) }
.dh-status.dh-bad { border-left: 3px solid var(--dsw-alias-state-error-primary, #e5484d) }
.dh-line { line-height: 1.6 }
.dh-code { margin-right: 8px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; user-select: all }
.dh-setup { display: flex; flex-direction: column; gap: 6px; padding: 10px 12px; border-radius: 10px;
  background: var(--dsw-alias-bg-layer-3, rgba(128,128,128,.12)) }
.dh-big { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 18px; letter-spacing: .08em; user-select: all }
.dh-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px }
.dh-roles { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px }
.dh-role { display: flex; flex-direction: column; gap: 4px; padding: 10px 12px; text-align: left; border-radius: 10px; cursor: pointer;
  font: inherit; color: inherit; background: transparent; border: .5px solid var(--dsw-alias-border-l4, rgba(128,128,128,.5)) }
.dh-role span { font-size: 12px; color: var(--dsw-alias-label-secondary, #666) }
.dh-role:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.1)) }
.dh-role.dh-on { border-color: var(--dsw-alias-state-business-primary, #4d6bfe); box-shadow: inset 0 0 0 1px var(--dsw-alias-state-business-primary, #4d6bfe) }
.dh-role:disabled { cursor: default; opacity: .7 }
.dh-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px 16px }
.dh-field { display: flex; flex-direction: column; gap: 4px; min-width: 0 }
.dh-label { font-size: 12px; color: var(--dsw-alias-label-secondary, #666) }
.dh-locked { color: var(--dsw-alias-label-tertiary, #888) }
.dh-help { font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-tertiary, #888) }
.dh-input { height: 30px; min-width: 0; box-sizing: border-box; padding: 0 9px; border-radius: 8px; font: inherit; font-size: 13px; color: inherit;
  background: var(--dsw-alias-bg-layer-3, transparent); border: .5px solid var(--dsw-alias-border-l4, rgba(128,128,128,.5)) }
.dh-input:disabled { opacity: .6 }
.dh-select { cursor: pointer }
.dh-mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px }
.dh-button { display: inline-flex; align-items: center; height: 30px; padding: 0 13px; border-radius: 8px; font: inherit; font-size: 13px;
  cursor: pointer; color: inherit; white-space: nowrap; text-decoration: none; background: transparent;
  border: .5px solid var(--dsw-alias-border-l4, rgba(128,128,128,.5)) }
.dh-button:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.1)) }
.dh-button:disabled { opacity: .5; cursor: default }
.dh-primary { color: var(--dsw-alias-label-primary-foreground, #fff); border-color: transparent;
  background: var(--dsw-alias-state-business-primary, #4d6bfe) }
.dh-primary:hover:not(:disabled) { background: var(--dsw-alias-state-business-primary, #4d6bfe); filter: brightness(1.08) }
.dh-danger { color: var(--dsw-alias-state-error-primary, #e5484d) }
.dh-save { position: sticky; bottom: 0; padding: 8px 0; background: var(--dsw-alias-bg-base, transparent) }
.dh-message { font-size: 13px; color: var(--dsw-alias-label-secondary, #666) }
.dh-message.dh-bad, .dh-status.dh-bad > :first-child { color: var(--dsw-alias-state-error-primary, #e5484d) }
@media (max-width: 640px) {
  .dh-roles, .dh-grid { grid-template-columns: 1fr }
}`

    const inject = ['slots', 'locale']

    function apply (ctx) {
      ctx.effect(() => {
        const tag = document.createElement('style')
        tag.dataset.plugin = PACKAGE
        tag.textContent = CSS
        document.head.appendChild(tag)
        return () => tag.remove()
      }, 'dsh-hub: style')
      ctx.effect(() => ctx.locale.register(NS, { en: EN }), 'dsh-hub: words')
      ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({ name: 'plugins.bundle.config', key: PACKAGE, locale: NS }, HubSettings))
    }

    module.exports = { inject, apply, EN, HubSettings, draftOf }
    return module.exports
  }
})
