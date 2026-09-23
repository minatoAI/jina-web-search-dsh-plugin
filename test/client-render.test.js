/**
 * Runtime contract test for the browser bundle's configuration form.
 *
 * `test/client-bundle.test.js` only greps the source, so it cannot see a
 * scoping bug — exactly the class of defect that shipped in 0.7.0: the form was
 * hoisted out of the `JinaCard` component into a factory-scope `body()`, which
 * still read the component's own state (`input`, `onInput`, `configured`,
 * `proxyBlock`, …). Every reference resolved to nothing, the slot entry threw
 * `ReferenceError: input is not defined`, and the Plugins page replaced the
 * whole configuration section with an error boundary — the API key and local
 * proxy fields silently vanished from the UI.
 *
 * This test materializes the bundle for real: it runs `ui/client.js` in a VM
 * with a minimal `window.__ModuleLoader__`, mounts the plugin against a fake
 * cordis context, and renders both entry views the way React does. A missing
 * local binding therefore fails here instead of in the browser console.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { Script, createContext } from 'node:vm'
import { KEY_REFS } from '../keys.js'

const SOURCE = await readFile(new URL('../ui/client.js', import.meta.url), 'utf8')

/** Minimal React surface the card touches, recording every element it builds. */
function reactStub(stateOverrides = []) {
  const elements = []
  let stateCall = 0
  return {
    elements,
    React: {
      createElement(type, props, ...children) {
        const node = { type, props: { ...(props ?? {}), children } }
        elements.push(node)
        return node
      },
      // The card's first useState is its collapsible `open` flag; an override
      // renders the legacy body without needing a real re-render.
      useState(initial) { return [stateOverrides[stateCall++] ?? initial, () => {}] },
      useRef(initial) { return { current: initial } },
      // The card's only effect wires the initial loads and the Remote event
      // subscriptions. Running it here is what makes `credentials.describe`
      // observable without a real renderer; the state setters above are no-ops,
      // so nothing re-renders.
      useEffect(effect) { const cleanup = effect(); if (typeof cleanup === 'function') cleanup() },
    },
  }
}

/** Execute the committed bundle and return its registration. */
function loadBundle() {
  let registration
  const sandbox = {
    window: { __ModuleLoader__: { load: (entry) => { registration = entry } } },
    // The card's key-health probe fetches its own host route; the effect that
    // starts it runs in this VM, so the global has to exist.
    fetch: () => Promise.resolve({ json: () => Promise.resolve({ ok: false, error: 'stub' }) }),
  }
  new Script(SOURCE, { filename: 'ui/client.js' }).runInContext(createContext(sandbox))
  assert.ok(registration !== undefined, 'the bundle must register through window.__ModuleLoader__.load')
  assert.equal(registration.id, 'dsh-jina')
  return registration
}

/**
 * Mount the plugin against a fake host whose Remote namespaces answer the way
 * the harness does, and return the registrations plus the recorded elements.
 * @param stateOverrides - overrides for the first useState calls.
 * @param options - `{ configured }`: the pool slots the fake credential store
 *   reports as configured (defaults to slot 1 only).
 */
function mount(stateOverrides = [], options = {}) {
  const registration = loadBundle()
  const { React, elements } = reactStub(stateOverrides)
  const exported = registration.factory((specifier) => {
    if (specifier === 'react') return React
    throw new Error(`unexpected require("${specifier}")`)
  })

  const configured = options.configured === undefined ? [KEY_REFS[0]] : options.configured
  const credentialCalls = []
  const credentials = {
    describe: async (refs) => {
      credentialCalls.push({ method: 'describe', refs })
      const value = {}
      // The real controller answers one view per requested reference; an
      // unknown reference comes back `{configured:false, writable:true}`.
      for (const ref of refs || []) {
        value[ref] = configured.includes(ref)
          ? { configured: true, source: 'file', writable: true }
          : { configured: false, writable: true }
      }
      return { ok: true, value }
    },
    set: async (ref, value) => { credentialCalls.push({ method: 'set', ref, value }); return { ok: true } },
    unset: async (ref) => { credentialCalls.push({ method: 'unset', ref }); return { ok: true } },
  }
  const settings = {
    describe: async () => ({
      ok: true,
      value: { writable: true, hasDocument: true, namespaces: [{ ns: 'jina-tools', value: {}, revision: 1 }] },
    }),
    mutate: async () => ({ ok: true, value: { ns: 'jina-tools', value: {}, revision: 2 } }),
  }
  const remote = { $on: () => () => {}, settings }
  const registrations = []
  // One slots service, reachable both as `ctx.slots` and through `ctx.get('slots')`,
  // exactly as the injected cordis service is.
  const slots = {
    register: (options, render) => { registrations.push({ options, render }); return () => {} },
    inject: (_name, callback) => { callback() },
  }
  const services = { slots, remote, 'remote.credentials': options.noCredentials === true ? undefined : credentials, 'remote.settings': settings }
  const ctx = { get: (name) => services[name], slots }

  exported.apply(ctx)
  return { registrations, elements, credentialCalls }
}

/** The entry the Plugins page dispatches for the `dsh-jina` bundle. */
function bundleEntry(registrations) {
  const entry = registrations.find(candidate => candidate.options.name === 'plugins.bundle.config'
    && candidate.options.key === 'dsh-jina')
  assert.ok(entry !== undefined, 'the bundle must register the plugins.bundle.config slot keyed by its package name')
  return entry
}

/** Render one view exactly as React would: build the element, then call its component. */
function renderView(entry, view) {
  const element = entry.render({ view })
  assert.equal(typeof element, 'object', `view "${view}" must return a React element`)
  return element.type(element.props)
}

test('client bundle: the page view renders the API key and local proxy fields', () => {
  const { registrations, elements } = mount()
  const entry = bundleEntry(registrations)
  assert.doesNotThrow(() => renderView(entry, 'page'),
    'the page view must render without a ReferenceError (component state must be in scope)')
  const inputs = elements.filter(node => node.type === 'input').map(node => node.props)
  const password = inputs.find(props => props.type === 'password')
  assert.ok(password !== undefined, 'the API key password field must render on the page view')
  assert.equal(password.placeholder, '粘贴 API key…')
  assert.ok(inputs.some(props => props.placeholder === 'http://127.0.0.1:7897'),
    'the manual local-proxy field must render on the page view')
})

test('client bundle: the page view renders the save controls bound to the component', () => {
  const { registrations, elements } = mount()
  const entry = bundleEntry(registrations)
  const tree = renderView(entry, 'page')
  assert.equal(tree.type, 'div')
  const buttons = elements.filter(node => node.type === 'button').map(node => node.props)
  assert.ok(buttons.some(props => (props.children ?? []).includes('保存')), 'the save control must render')
  assert.ok(buttons.every(props => typeof props.onClick === 'function'),
    'every rendered control must carry a real handler, not a missing binding')
})

test('client bundle: the summary view answers with the one-liner the page shows', () => {
  const { registrations } = mount()
  const entry = bundleEntry(registrations)
  const summary = renderView(entry, 'summary')
  assert.equal(typeof summary, 'string')
  assert.match(summary, /Jina AI/)
})

test('client bundle: the legacy settings card renders its collapsible body when opened', () => {
  const { registrations, elements } = mount([true])
  const entry = registrations.find(candidate => candidate.options.name === 'settings.plugin.item'
    && candidate.options.key === 'jina-tools')
  assert.ok(entry !== undefined, 'the legacy settings.plugin.item registration must remain')
  const element = entry.render()
  assert.equal(typeof element.type, 'function', 'the entry must hand the page a component element')
  const card = element.type(element.props)
  assert.equal(card.type, 'li')
  const inputs = elements.filter(node => node.type === 'input').map(node => node.props)
  assert.ok(inputs.some(props => props.type === 'password'),
    'the opened legacy card must render the API key field too')
  assert.ok(inputs.some(props => props.placeholder === 'http://127.0.0.1:7897'),
    'the opened legacy card must render the local-proxy field too')
})

test('client bundle: the page view renders the reader option controls', () => {
  const { registrations, elements } = mount()
  const entry = bundleEntry(registrations)
  renderView(entry, 'page')
  const inputs = elements.filter(node => node.type === 'input').map(node => node.props)
  const checkboxes = inputs.filter(props => props.type === 'checkbox')
  assert.equal(checkboxes.length, 3, 'the OCR, alt-text and selector toggles must render')
  assert.ok(checkboxes.every(props => typeof props.onChange === 'function'),
    'every toggle must carry a real handler, not a missing binding')
  assert.ok(inputs.some(props => props.placeholder === '正文选择器（留空使用内置列表）'),
    'the target-selector override must render')
  assert.ok(inputs.some(props => props.placeholder === '排除选择器（留空使用内置列表）'),
    'the remove-selector override must render')
  const selects = elements.filter(node => node.type === 'select').map(node => node.props)
  assert.equal(selects.length, 1, 'the image-policy select must render')
  assert.equal(selects[0].value, 'all', 'the select must default to the API image policy')
  assert.equal(selects[0].onChange !== undefined, true, 'the select must carry a handler')
})

test('client bundle: the page view renders ONE key input and describes exactly the pool refs', () => {
  const { registrations, elements, credentialCalls } = mount()
  const entry = bundleEntry(registrations)
  renderView(entry, 'page')
  const passwords = elements.filter(node => node.type === 'input' && node.props.type === 'password').map(node => node.props)
  assert.equal(passwords.length, 1, 'one input the user keeps filling, not one per slot')
  assert.equal(passwords[0].placeholder, '粘贴 API key…')
  assert.equal(typeof passwords[0].onChange, 'function')
  const add = elements.filter(node => node.type === 'button' && (node.props.children ?? []).includes('添加')).map(node => node.props)
  assert.equal(add.length, 1, 'one add control')
  assert.equal(typeof add[0].onClick, 'function')
  // The credentials namespace has no enumeration, so the card must name the
  // references it edits — and they must be the pool the host resolves.
  const describes = credentialCalls.filter(call => call.method === 'describe')
  assert.equal(describes.length, 1, 'one batched describe for the whole pool')
  // `Array.from`: the bundle's array literal lives in the VM realm, and a
  // cross-realm array fails deepStrictEqual on prototypes alone.
  assert.deepEqual(Array.from(describes[0].refs), KEY_REFS)
})

test('client bundle: nothing per key is rendered — no list, no remove control, no identity', () => {
  // The second `useState` is the describe view; seeding it is how this stub
  // renders the post-load state (its useEffect is a no-op).
  const views = {}
  for (const ref of KEY_REFS) views[ref] = { configured: false, writable: true }
  views[KEY_REFS[0]] = { configured: true, source: 'file', writable: true }
  views[KEY_REFS[2]] = { configured: true, source: 'file', writable: true }
  const { registrations, elements, credentialCalls } = mount([undefined, views])
  renderView(bundleEntry(registrations), 'page')
  const texts = elements.filter(node => node.type === 'p')
    .map(node => (Array.isArray(node.props.children) ? node.props.children.join('') : node.props.children))
    .filter(text => typeof text === 'string')
  assert.equal(texts.some(text => text.includes('移除')), false, 'no remove control copy')
  assert.equal(texts.some(text => text.includes('JINA_API_KEY')), false, 'no reference name is shown')
  assert.equal(texts.some(text => text.startsWith('#')), false, 'no per-key row')
  const labels = elements.filter(node => node.type === 'button').map(node => (node.props.children ?? []).join(''))
  assert.equal(labels.includes('移除'), false, 'no remove button')
  assert.equal(credentialCalls.filter(call => call.method === 'unset').length, 0, 'the card never unsets by hand')
  const password = elements.filter(node => node.type === 'input' && node.props.type === 'password').map(node => node.props)[0]
  assert.equal(password.disabled, false, 'a free slot keeps the input usable')
})

test('client bundle: the add control closes once every slot is filled', () => {
  const views = {}
  for (const ref of KEY_REFS) views[ref] = { configured: true, source: 'file', writable: true }
  const { registrations, elements } = mount([undefined, views])
  renderView(bundleEntry(registrations), 'page')
  const add = elements.filter(node => node.type === 'button' && (node.props.children ?? []).includes('添加')).map(node => node.props)[0]
  assert.equal(add.disabled, true, 'there is no free slot left')
})

test('client bundle: the health section shows counts and one total, nothing per key', () => {
  const views = {}
  for (const ref of KEY_REFS) views[ref] = { configured: false, writable: true }
  views[KEY_REFS[0]] = { configured: true, source: 'file', writable: true }
  // The fifth `useState` is the primer payload (open, keyViews, keyDraft,
  // keyStatus, primer).
  const primer = {
    phase: 'ok',
    data: {
      ok: true, keyCount: 2, discardedCount: 1,
      authenticatedAs: 'acct-2', balanceLeft: 900, balanceTotal: 1100,
      proxy: { url: null, source: 'none', rejected: [] },
    },
    error: undefined,
  }
  const { registrations, elements } = mount([undefined, views, undefined, undefined, primer])
  renderView(bundleEntry(registrations), 'page')
  const texts = elements.filter(node => node.type === 'p')
    .map(node => (Array.isArray(node.props.children) ? node.props.children.join('') : node.props.children))
    .filter(text => typeof text === 'string')
  assert.ok(texts.includes('Key 总数：2 个'), 'the page reports how many keys the pool holds')
  assert.ok(texts.includes('总余额：1,100 credits'), 'and the credits behind them')
  assert.equal(texts.some(text => text.includes('可用 Key')), false, 'no usable/total split')
  assert.equal(texts.some(text => text.includes('2 / 2') || text.includes('1 / 2')), false, 'no fraction')
  assert.equal(texts.some(text => text.includes('acct-2')), false, 'no identity line')
  assert.equal(texts.some(text => text.includes('900 credits')), false, 'no per-key/current balance line')
  assert.ok(texts.some(text => text.includes('自动丢弃了 1 个')), 'an automatic discard is reported')
})

test('client bundle: a profile without a credential plane degrades instead of loading forever', () => {
  const { registrations, elements } = mount([], { noCredentials: true })
  const entry = bundleEntry(registrations)
  assert.doesNotThrow(() => renderView(entry, 'page'))
  const texts = elements.filter(node => node.type === 'p')
    .map(node => (Array.isArray(node.props.children) ? node.props.children.join('') : node.props.children))
  assert.ok(texts.some(text => typeof text === 'string' && text.includes('未挂载凭据控制面')),
    'the card must say why the key cannot be saved, not spin forever')
  const passwords = elements.filter(node => node.type === 'input' && node.props.type === 'password').map(node => node.props)
  assert.equal(passwords.length, 1)
  assert.equal(passwords[0].disabled, true, 'the input cannot be used without a credential plane')
})
