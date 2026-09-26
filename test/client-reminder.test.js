/**
 * Instrumented test for the low-balance reminder (ui/client.js).
 *
 * `client-render.test.js` renders the notice with its hooks pre-seeded, which
 * proves the elements exist but never exercises the *decision*. This file drives
 * the real path instead: the committed bundle in a VM, a small stateful React
 * runtime that re-renders when a setter runs, a controllable
 * `window.setInterval`, a fake `localStorage` shared across "reloads", and a
 * `fetch` whose payload the test swaps between polls.
 *
 * It is the difference between "the notice renders" and "the notice appears
 * exactly when the pool runs low, survives the next poll, honours a dismissal
 * across a reload, and warns again after a top-up and a later drop". The first
 * version of this feature latched the notice when it *showed* rather than when
 * it was *dismissed*, so the very next poll hid a notice the user may never have
 * seen — a defect pre-seeded rendering cannot reach.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { Script, createContext } from 'node:vm'

const SOURCE = await readFile(new URL('../ui/client.js', import.meta.url), 'utf8')

/** The threshold the bundle ships; the tests speak in terms of this number. */
const THRESHOLD = Number(/LOW_BALANCE_THRESHOLD\s*=\s*([0-9_]+)/.exec(SOURCE)[1].replace(/_/g, ''))

/** Minimal stateful React: hooks persist across renders, a setter re-renders. */
function reactRuntime() {
  const slots = [] // hook values, by hook index
  const deps = [] // useEffect dependency arrays, by hook index
  const pending = [] // effects queued for the current render
  const cleanups = []
  let cursor = 0
  let scheduled = false
  let Component = null
  let tree = null

  const React = {
    createElement(type, props, ...children) { return { type, props: { ...(props ?? {}), children } } },
    useState(initial) {
      const index = cursor++
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial
      const set = (next) => {
        const value = typeof next === 'function' ? next(slots[index]) : next
        if (Object.is(value, slots[index])) return
        slots[index] = value
        scheduled = true
      }
      return [slots[index], set]
    },
    useEffect(effect, list) {
      const index = cursor++
      const previous = deps[index]
      const changed = previous === undefined || list === undefined
        || list.length !== previous.length || list.some((value, at) => !Object.is(value, previous[at]))
      if (!changed) return
      deps[index] = list
      pending.push(effect)
    },
  }

  const render = () => {
    cursor = 0
    tree = Component({})
    while (pending.length > 0) {
      const cleanup = pending.shift()()
      if (typeof cleanup === 'function') cleanups.push(cleanup)
    }
    return tree
  }

  return {
    React,
    get tree() { return tree },
    mount(component) { Component = component; return render() },
    /** Apply every state change queued since the last render. */
    flush() { if (!scheduled) return tree; scheduled = false; return render() },
    unmount() { while (cleanups.length > 0) cleanups.pop()() },
  }
}

/** Visit every element in a rendered tree (arrays, fragments and all). */
function walk(node, visit) {
  if (Array.isArray(node)) { for (const kid of node) walk(kid, visit); return }
  if (node === null || node === undefined || typeof node !== 'object') return
  visit(node)
  walk(node.props === undefined ? undefined : node.props.children, visit)
}

/** The text of every <p> in the tree. */
function paragraphs(tree) {
  const out = []
  walk(tree, (node) => {
    if (node.type !== 'p') return
    out.push((Array.isArray(node.props.children) ? node.props.children : [node.props.children]).join(''))
  })
  return out
}

/** The first <button> whose label matches. */
function button(tree, label) {
  let found
  walk(tree, (node) => {
    if (node.type === 'button' && (node.props.children ?? []).includes(label)) found = node
  })
  return found
}

/** A minimal `document`, so the one-time stylesheet injection is observable. */
function fakeDocument() {
  const styles = []
  return {
    styles,
    getElementById: (id) => styles.find((element) => element.id === id) ?? null,
    createElement: () => ({ id: '', textContent: '' }),
    head: { appendChild: (element) => { styles.push(element) } },
  }
}

/**
 * Boot the committed bundle against a fake shell and mount the reminder.
 * @param initialPayload - what `/api/dsh-jina/primer` answers first.
 * @param storage - the persistent store, shared to model a reload.
 * @param doc - the document stub, shared to model two mounts in one page.
 */
function bootReminder(initialPayload, storage = new Map(), doc = fakeDocument()) {
  let registration
  let payload = initialPayload
  let offline = false
  const intervals = []
  const runtime = reactRuntime()
  const sandbox = {
    document: doc,
    window: {
      __ModuleLoader__: { load: (entry) => { registration = entry } },
      localStorage: {
        getItem: (key) => (storage.has(key) ? storage.get(key) : null),
        setItem: (key, value) => { storage.set(key, String(value)) },
        removeItem: (key) => { storage.delete(key) },
      },
      setInterval: (callback) => { intervals.push(callback); return intervals.length },
      clearInterval: () => {},
    },
    fetch: () => (offline
      ? Promise.reject(new Error('offline'))
      : Promise.resolve({ json: () => Promise.resolve(payload) })),
  }
  new Script(SOURCE, { filename: 'ui/client.js' }).runInContext(createContext(sandbox))
  assert.ok(registration !== undefined, 'the bundle must register through window.__ModuleLoader__.load')

  const exported = registration.factory((specifier) => {
    if (specifier === 'react') return runtime.React
    throw new Error(`unexpected require("${specifier}")`)
  })
  const registrations = []
  const slots = {
    register: (options, render) => { registrations.push({ options, render }); return () => {} },
    inject: (_name, callback) => { callback() },
  }
  const remote = { $on: () => () => {}, settings: { describe: async () => ({ ok: true, value: { writable: false, namespaces: [] } }), mutate: async () => ({ ok: true, value: {} }) } }
  const services = { slots, remote, 'remote.credentials': { describe: async () => ({ ok: true, value: {} }) }, 'remote.settings': remote.settings }
  exported.apply({ get: (name) => services[name], slots })

  const entry = registrations.find((candidate) => candidate.options.name === 'shell.overlay')
  assert.ok(entry !== undefined, 'the reminder must register into the shell overlay')
  assert.equal(entry.options.id, 'jina.balance', 'under the id the shell renders')
  runtime.mount(entry.render({}).type)

  /** Settle the poll's promise chain, then apply the state it produced. */
  const settle = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); return runtime.flush() }
  return {
    runtime,
    storage,
    intervals,
    document: doc,
    settle,
    /** Answer the next poll with this payload. */
    answer: (next) => { payload = next; offline = false },
    /** Make the next poll fail at the transport. */
    fail: () => { offline = true },
    /** Run one poll exactly the way the registered interval would. */
    poll: async () => { for (const callback of intervals) callback(); return settle() },
    visible: () => runtime.tree !== null,
    paragraphs: () => paragraphs(runtime.tree),
    button: (label) => button(runtime.tree, label),
  }
}

test('reminder: shows below the threshold, and an un-dismissed notice survives the next poll', async () => {
  const boot = bootReminder({ balanceTotal: THRESHOLD - 12346, keyCount: 5 })
  await boot.settle()
  assert.equal(boot.visible(), true, 'a pool below the threshold must show the notice')
  assert.deepEqual(boot.paragraphs(),
    ['Jina Tools', '该插件可用点数少于 1,000,000，请注意补充。', '当前还有 987,654。'],
    'the plugin name, the threshold it crossed, and the balance it is at')

  // Only a dismissal may hide it. The first version latched on *show*, so this
  // very poll hid a notice the user might never have seen.
  await boot.poll()
  assert.equal(boot.visible(), true, 'an un-dismissed notice must survive the next poll')
})

test('reminder: the glow stylesheet is injected once per page, and never flashes a reduced-motion profile', async () => {
  // The border glow is the whole reason this bundle injects a <style>: keyframes
  // cannot be expressed in an inline style. The injection must be idempotent —
  // the entry can remount (a surface swap), and a second copy of the keyframes
  // would restart the pulse on every mount.
  const shared = fakeDocument()
  const first = bootReminder({ balanceTotal: 800000, keyCount: 5 }, new Map(), shared)
  await first.settle()
  assert.equal(shared.styles.length, 1, 'exactly one stylesheet is injected')
  assert.equal(shared.styles[0].id, 'dsh-jina-low-balance-style')
  assert.match(shared.styles[0].textContent, /@keyframes dsh-jina-low-balance-flash/)
  assert.match(shared.styles[0].textContent, /prefers-reduced-motion/, 'the pulse is skipped when motion is reduced')
  assert.match(shared.styles[0].textContent, /\.dsh-jina-low-balance/, 'and every rule is scoped by the box class')

  // A second mount in the same page (same document) must not inject again.
  const second = bootReminder({ balanceTotal: 800000, keyCount: 5 }, new Map(), shared)
  await second.settle()
  assert.equal(shared.styles.length, 1, 'a remount must not stack a second copy')
})

test('reminder: a dismissal hides it, survives a reload, and re-arms after a top-up', async () => {
  const storage = new Map()
  const first = bootReminder({ balanceTotal: 987654, keyCount: 5 }, storage)
  await first.settle()
  assert.equal(first.visible(), true)

  const dismiss = first.button('知道了')
  assert.ok(dismiss !== undefined, 'the notice must offer a dismissal')
  dismiss.props.onClick()
  first.runtime.flush()
  assert.equal(first.visible(), false, 'dismissing hides the notice')
  assert.equal(storage.size, 1, 'and latches the dismissal')

  await first.poll()
  assert.equal(first.visible(), false, 'a later poll must not resurrect a dismissed notice')

  // A reload is a fresh component over the same storage.
  const second = bootReminder({ balanceTotal: 900000, keyCount: 5 }, storage)
  await second.settle()
  assert.equal(second.visible(), false, 'the dismissal must survive a reload')

  // A top-up above the threshold re-arms it...
  second.answer({ balanceTotal: 5000000, keyCount: 5 })
  await second.poll()
  assert.equal(second.visible(), false)
  assert.equal(storage.size, 0, 'recovering above the threshold clears the latch')
  // ...so a later drop warns again.
  second.answer({ balanceTotal: 800000, keyCount: 5 })
  await second.poll()
  assert.equal(second.visible(), true, 'a later drop must warn again')
})

test('reminder: "no balance fact" is never treated as a breach, and a failed poll changes nothing', async () => {
  // No key pool at all: the host reports no total, so there is nothing to run
  // out of and nothing to warn about.
  const empty = bootReminder({ ok: true, keyCount: 0, balanceTotal: null })
  await empty.settle()
  assert.equal(empty.visible(), false, 'a pool with no total must not warn')

  // A transport failure must leave the last known state alone rather than flip
  // it: an offline moment is not evidence that the credits came back.
  const low = bootReminder({ balanceTotal: 800000, keyCount: 5 })
  await low.settle()
  assert.equal(low.visible(), true)
  low.fail()
  await low.poll()
  assert.equal(low.visible(), true, 'a failed poll must keep the notice it already had')

  // ...and a later good poll still shows it, so the failure did not latch.
  low.answer({ balanceTotal: 700000, keyCount: 5 })
  await low.poll()
  assert.equal(low.visible(), true)

  // The poll is registered once, on the interval, and torn down with the entry.
  assert.equal(low.intervals.length, 1, 'exactly one poll loop')
  low.runtime.unmount()
})

test('reminder: a stored override lets the notice be triggered live, and removing it restores the constant', async () => {
  // This is the README's manual trigger: put a number above the current pool
  // total in the profile, reload, and the notice appears — no bundle edit, so
  // the shipped default and the test that pins it both stay intact.
  const storage = new Map([['dsh-jina:low-balance-threshold', '20000000']])
  const boot = bootReminder({ balanceTotal: 18168993, keyCount: 5 }, storage)
  await boot.settle()
  assert.equal(boot.visible(), true, 'the override must raise the threshold for this profile')
  assert.deepEqual(boot.paragraphs(),
    ['Jina Tools', '该插件可用点数少于 20,000,000，请注意补充。', '当前还有 18,168,993。'],
    'and the copy must name the override actually in force')

  storage.delete('dsh-jina:low-balance-threshold')
  const restored = bootReminder({ balanceTotal: 18168993, keyCount: 5 }, storage)
  await restored.settle()
  assert.equal(restored.visible(), false, 'without the override the shipped threshold applies again')
})

test('reminder: a malformed override is ignored, never silently disabling the reminder', async () => {
  // A typo in the console must not turn the reminder off: a bad value falls
  // back to the shipped constant, which still warns at 800k.
  for (const bad of ['', 'abc', '0', '-5', 'NaN', 'Infinity']) {
    const storage = new Map([['dsh-jina:low-balance-threshold', bad]])
    const boot = bootReminder({ balanceTotal: 800000, keyCount: 5 }, storage)
    await boot.settle()
    assert.equal(boot.visible(), true, `a stored threshold of "${bad}" must not disable the reminder`)
  }
})
