// This computer's dsh-hub settings, kept in <DSH home>/dsh-hub/settings.json: which role it plays (off, hub or node)
// and that role's options. DSH's Plugins page (plugin/client.js) and `dsh-hub config` (bin/dsh-hub.js) both write it,
// and a running DSH picks a change up within seconds. Anything a profile's cordis.patch.yml sets wins over the file,
// and is shown as locked.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const ROLES = ['off', 'hub', 'node']
const PERMISSIONS = ['workspace-write', 'danger-full-access']

const text = (value, name, max = 200) => {
  const result = String(value ?? '').trim()
  if (result.length > max) throw new RangeError(`${name} is at most ${max} characters`)
  return result
}
const list = (value, name) => {
  const items = Array.isArray(value) ? value : String(value ?? '').split(/[,\n]/)
  return items.map(item => text(item, name, 400)).filter(Boolean)
}
const oneOf = (choices, name) => value => {
  const result = String(value ?? '').trim()
  if (!choices.includes(result)) throw new RangeError(`${name} is ${choices.join(', ').replace(/, ([^,]*)$/, ' or $1')}`)
  return result
}
const whole = (low, high, name) => value => {
  const result = Number(value)
  if (!Number.isInteger(result) || result < low || result > high) throw new RangeError(`${name} is a whole number from ${low} to ${high}`)
  return result
}
const address = value => {
  const result = text(value, 'the hub\'s address', 400).replace(/\/+$/, '')
  let url
  try { url = new URL(/^https?:\/\//i.test(result) ? result : `http://${result}`) } catch { throw new RangeError('the hub\'s address is like http://192.168.1.10:4180') }
  if (!['http:', 'https:'].includes(url.protocol)) throw new RangeError('the hub\'s address starts with http:// or https://')
  return url.origin
}

/** Every setting there is: its path, how it's checked, and what it means (the page and the CLI show these). */
export const FIELDS = {
  'hub.port': { check: whole(1, 65535, 'port'), help: 'the port of the hub\'s page and of its computers\' connections (4180)' },
  'hub.access': { check: oneOf(['lan', 'anywhere'], 'access'), help: 'who may reach the sign-in page: lan (home network and Tailscale) or anywhere (still behind accounts)' },
  'hub.title': { check: value => text(value, 'title', 60), help: 'the page\'s title (Hub)' },
  'hub.hostnames': { check: value => list(value, 'a hostname'), help: 'names of yours the hub is opened by, comma separated' },
  'hub.maxUploadMB': { check: whole(1, 1024 * 1024, 'the upload limit'), help: 'the largest file one may attach, in MB (2048)' },
  'hub.permission': { check: oneOf(PERMISSIONS, 'permission'), help: 'what the hub\'s bots may do on this computer without asking: workspace-write or danger-full-access' },
  'node.hub': { check: address, help: 'the hub this computer joined (set by joining it)' },
  'node.policy.exec': { check: oneOf(['any', 'allowlist', 'never'], 'commands'), help: 'commands the hub may run here: any, allowlist (node.policy.allow) or never' },
  'node.policy.allow': { check: value => list(value, 'a pattern'), help: 'with allowlist: patterns a command must match, comma separated (^nvidia-smi, ^video2x )' },
  'node.policy.files': { check: oneOf(['any', 'folders', 'never'], 'files'), help: 'files the hub may take from here: any, folders (node.policy.folders) or never' },
  'node.policy.folders': { check: value => list(value, 'a folder'), help: 'with folders: the folders it may take files from, comma separated' },
  'node.policy.inbox': { check: value => text(value, 'the inbox', 400), help: 'where files from the hub land (<DSH home>/dsh-hub/inbox)' },
  'node.policy.bots': { check: oneOf(['any', 'own'], 'bots'), help: 'any: the hub\'s owner may add bots to live here; own: only this computer\'s own' },
  'node.policy.tasks': { check: oneOf(['any', 'never'], 'tasks'), help: 'any: hub bots may hand this computer tasks; never: they can\'t' },
  'node.permission': { check: oneOf(PERMISSIONS, 'permission'), help: 'what the agents living here may do without asking: workspace-write or danger-full-access' },
}

const get = (object, where) => where.split('.').reduce((at, key) => (at && typeof at === 'object' ? at[key] : undefined), object)
function put (object, where, value) {
  const keys = where.split('.')
  let at = object
  for (const key of keys.slice(0, -1)) at = at[key] && typeof at[key] === 'object' ? at[key] : (at[key] = {})
  if (value === undefined) delete at[keys.at(-1)]
  else at[keys.at(-1)] = value
}

/** <DSH home>: $DSH_HOME (with ~ expanded), else ~/.dsh, as @deepseek-ai/dsh-home-paths has it. */
export function dshHome (env = process.env) {
  const set = String(env.DSH_HOME ?? '').trim()
  if (!set) return path.join(os.homedir(), '.dsh')
  return path.resolve(set === '~' ? os.homedir() : set.replace(/^~(?=[/\\])/, os.homedir()))
}

export const settingsFile = folder => path.join(folder, 'settings.json')

/** Checked settings: { role?, hub: {...}, node: {...} } with only the known fields. Throws a RangeError naming a bad one. */
export function clean (input = {}) {
  const result = { hub: {}, node: {} }
  if (input.role !== undefined && input.role !== null && input.role !== '') result.role = oneOf(ROLES, 'role')(input.role)
  for (const [where, field] of Object.entries(FIELDS)) {
    const value = get(input, where)
    if (value === undefined || value === null || value === '') continue
    const checked = field.check(value)
    if (Array.isArray(checked) && !checked.length) continue
    if (checked !== '') put(result, where, checked)
  }
  return result
}

export function readSettings (folder) {
  try { return clean(JSON.parse(fs.readFileSync(settingsFile(folder), 'utf8'))) } catch { return clean({}) }
}

export function writeSettings (folder, settings) {
  const checked = clean(settings)
  fs.mkdirSync(folder, { recursive: true })
  const file = settingsFile(folder)
  const temporary = `${file}.${process.pid}.tmp`
  fs.writeFileSync(temporary, JSON.stringify(checked, null, 2) + '\n')
  fs.renameSync(temporary, file)
  return checked
}

/** One setting changed (`value` undefined: back to its default), by its path in FIELDS or `role`. */
export function change (settings, where, value) {
  if (where !== 'role' && !FIELDS[where]) throw new RangeError(`there is no setting ${where}; dsh-hub config lists them`)
  const next = structuredClone(settings)
  put(next, where, value)
  return clean(next)
}

/**
 * What this computer runs: the profile's own config over the file over the defaults. A computer that hasn't chosen
 * runs nothing, unless it already has a hub (made before the role was a setting), which goes on being one.
 * Resolves { role, config (for the role), locked (paths the profile sets), settings }.
 */
export function effective (profile = {}, settings = clean({}), folder = null) {
  profile = profile ?? {}
  const locked = []
  for (const where of ['role', ...Object.keys(FIELDS)]) {
    const [role, ...rest] = where.split('.')
    const value = where === 'role' ? profile.role : get(profile, rest.join('.'))
    // a field of one role is locked only when the profile plays that role (a hub's `permission` isn't a node's)
    if (value !== undefined && (where === 'role' || (profile.role ?? settings.role ?? 'hub') === role)) locked.push(where)
  }
  const existing = folder && fs.existsSync(path.join(folder, 'hub', 'hub.db')) ? 'hub' : 'off'
  const role = profile.role ?? settings.role ?? existing
  const chosen = role === 'off' ? {} : settings[role] ?? {}
  const config = { ...chosen, ...profile, role }
  if (role === 'node') config.policy = { ...chosen.policy, ...profile.policy }
  return { role, config, locked, settings }
}
