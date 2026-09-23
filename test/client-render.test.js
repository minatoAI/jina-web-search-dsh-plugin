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
      useEffect() {},
    },
  }
}

/** Execute the committed bundle and return its registration. */
function loadBundle() {
  let registration
  const sandbox = { window: { __ModuleLoader__: { load: (entry) => { registration = entry } } } }
  new Script(SOURCE, { filename: 'ui/client.js' }).runInContext(createContext(sandbox))
  assert.ok(registration !== undefined, 'the bundle must register through window.__ModuleLoader__.load')
  assert.equal(registration.id, 'dsh-jina')
  return registration
}

/**
 * Mount the plugin against a fake host whose Remote namespaces answer the way
 * the harness does, and return the registrations plus the recorded elements.
 */
function mount(stateOverrides = []) {
  const registration = loadBundle()
  const { React, elements } = reactStub(stateOverrides)
  const exported = registration.factory((specifier) => {
    if (specifier === 'react') return React
    throw new Error(`unexpected require("${specifier}")`)
  })

  const credentials = {
    describe: async () => ({ ok: true, value: { JINA_API_KEY: { configured: false, writable: true } } }),
    set: async () => ({ ok: true }),
    unset: async () => ({ ok: true }),
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
  const services = { slots, remote, 'remote.credentials': credentials, 'remote.settings': settings }
  const ctx = { get: (name) => services[name], slots }

  exported.apply(ctx)
  return { registrations, elements }
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
