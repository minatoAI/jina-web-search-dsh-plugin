/**
 * Instrumented test for the low-balance reminder (ui/client.js).
 *
 * `client-render.test.js` renders the notice with its hooks pre-seeded, which
 * proves the elements exist but never exercises the *decision*. This file drives
 * the real path instead: the committed bundle in a VM, a small stateful React
 * runtime that re-renders when a setter runs, a controllable
 * `window.setInterval`, a fake `localStorage` shared across "reloads", a
 * controllable clock, and a `fetch` whose answer the test swaps between reads.
 *
 * It is the difference between "the notice renders" and "the notice appears
 * exactly when the pool runs low, survives the next read, honours a dismissal
 * across a reload, and warns again after a top-up and a later drop". The first
 * version of this feature latched the notice when it *showed* rather than when
 * it was *dismissed*, so the very next poll hid a notice the user may never have
 * seen — a defect pre-seeded rendering cannot reach.
 *
 * Since the ledger rework the notice does not probe anything: it reads the
 * host's balance ledger, a local route that spends no credits and never reaches
 * the vendor. The tests below therefore assert not only *what* the notice does
 * but *where it gets its number* — a regression back to probing the vendor on a
 * page-owned clock is the failure this file is now positioned to catch.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { Script, createContext } from 'node:vm'

const SOURCE = await readFile(new URL('../ui/client.js', import.meta.url), 'utf8')

/** The threshold the bundle ships; the tests speak in terms of this number. */
const THRESHOLD = Number(/LOW_BALANCE_THRESHOLD\s*=\s*([0-9_]+)/.exec(SOURCE)[1].replace(/_/g, ''))

/** The ledger route the notice must read, and the one it must no longer touch. */
const LEDGER_ROUTE = '/api/dsh-jina/balance'
const PRIMER_ROUTE = '/api/dsh-jina/primer'

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

/** A clock the test moves by hand, so "17 分钟前更新" is a fact and not a race. */
function fakeClock(at = 1750000000000) {
  const clock = {
    at,
    advance(ms) { this.at += ms; return this.at },
  }
  // `now` closes over the clock rather than reading `this`: inside a static
  // method `this` is the class, not the instance the sandbox handed around.
  clock.date = class extends Date { static now() { return clock.at } }
  return clock
}

/**
 * Boot the committed bundle against a fake shell and mount the reminder.
 * @param initial - what the ledger route answers first: `{ total, updatedAt, pending }`.
 * @param storage - the persistent store, shared to model a reload.
 * @param doc - the document stub, shared to model two mounts in one page.
 * @param clock - the controllable clock, shared so a re-boot is the same moment.
 */
function bootReminder(initial, storage = new Map(), doc = fakeDocument(), clock = fakeClock()) {
  let registration
  let payload = initial
  let offline = false
  const intervals = []
  const requests = []
  const runtime = reactRuntime()
  const sandbox = {
    document: doc,
    Date: clock.date,
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
    fetch: (url) => {
      requests.push(url)
      if (offline) return Promise.reject(new Error('offline'))
      return Promise.resolve({ json: () => Promise.resolve(payload) })
    },
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

  /** Settle the read's promise chain, then apply the state it produced. */
  const settle = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); return runtime.flush() }
  return {
    runtime,
    storage,
    clock,
    intervals,
    document: doc,
    requests,
    settle,
    /** Answer the next read with this ledger payload. */
    answer: (next) => { payload = next; offline = false },
    /** Make the next read fail at the transport. */
    fail: () => { offline = true },
    /** Run one read exactly the way the registered interval would. */
    poll: async () => { for (const callback of intervals) callback(); return settle() },
    visible: () => runtime.tree !== null,
    paragraphs: () => paragraphs(runtime.tree),
    button: (label) => button(runtime.tree, label),
  }
}

/** A ledger payload the tests can pass around without repeating the shape. */
const ledger = (total, updatedAt, pending = false) => ({ total, updatedAt, pending })

test('reminder: it reads the host ledger, and never probes the vendor itself', async () => {
  // The whole point of the rework: the host owns when a probe is due (it is where
  // the calls that spend credits happen), and the page only reads the result. A
  // regression back to the page's own 15-minute vendor poll would show up here as
  // a request to the primer route.
  const boot = bootReminder(ledger(800000, 1750000000000))
  await boot.settle()
  assert.equal(boot.visible(), true)
  await boot.poll()
  assert.ok(boot.requests.length >= 2, 'the notice reads on mount and then on its interval')
  assert.deepEqual([...new Set(boot.requests)], [LEDGER_ROUTE], 'and every read is the free local ledger route')
  assert.equal(boot.requests.includes(PRIMER_ROUTE), false, 'it must never drive the vendor probe itself')
})

test('reminder: shows below the threshold, and an un-dismissed notice survives the next read', async () => {
  const boot = bootReminder(ledger(THRESHOLD - 12346, 0))
  await boot.settle()
  assert.equal(boot.visible(), true, 'a pool below the threshold must show the notice')
  assert.deepEqual(boot.paragraphs(),
    ['Jina Tools', '该插件可用点数少于 1,000,000，请注意补充。', '当前还有 987,654。'],
    'the plugin name, the threshold it crossed, and the balance it is at')

  // Only a dismissal may hide it. The first version latched on *show*, so this
  // very poll hid a notice the user might never have seen.
  await boot.poll()
  assert.equal(boot.visible(), true, 'an un-dismissed notice must survive the next read')
})

test('reminder: the balance line carries how long ago it was confirmed', async () => {
  // "When did we last look" and "when did the number last change" are different
  // questions, and a probe that finds the same figure still confirms it — so the
  // line counts from the last confirmation, not from the last change.
  const clock = fakeClock()
  const boot = bootReminder(ledger(800000, clock.at), new Map(), fakeDocument(), clock)
  await boot.settle()
  assert.equal(boot.paragraphs()[3], '刚刚更新', 'a fresh confirmation reads as "just now"')

  clock.advance(60 * 1000)
  await boot.poll()
  assert.equal(boot.paragraphs()[3], '1 分钟前更新')

  clock.advance(17 * 60 * 1000)
  await boot.poll()
  assert.equal(boot.paragraphs()[3], '18 分钟前更新')

  clock.advance(60 * 60 * 1000)
  await boot.poll()
  assert.equal(boot.paragraphs()[3], '1 小时前更新', 'past an hour the line switches bucket')

  clock.advance(5 * 60 * 60 * 1000)
  await boot.poll()
  assert.equal(boot.paragraphs()[3], '6 小时前更新')
})

test('reminder: a balance that was never confirmed shows no age line at all', async () => {
  // `updatedAt: 0` means no probe has confirmed anything yet. Showing "0 分钟前"
  // would be a lie about freshness; showing nothing says the same thing quietly.
  const boot = bootReminder(ledger(800000, 0))
  await boot.settle()
  assert.equal(boot.visible(), true, 'the breach itself still warns')
  assert.deepEqual(boot.paragraphs(),
    ['Jina Tools', '该插件可用点数少于 1,000,000，请注意补充。', '当前还有 800,000。'],
    'but there is nothing to date, so the age line is absent rather than invented')
})

test('reminder: the glow stylesheet is injected once per page, and never flashes a reduced-motion profile', async () => {
  // The border glow is the whole reason this bundle injects a <style>: keyframes
  // cannot be expressed in an inline style. The injection must be idempotent —
  // the entry can remount (a surface swap), and a second copy of the keyframes
  // would restart the pulse on every mount.
  const shared = fakeDocument()
  const first = bootReminder(ledger(800000, 1750000000000), new Map(), shared)
  await first.settle()
  assert.equal(shared.styles.length, 1, 'exactly one stylesheet is injected')
  assert.equal(shared.styles[0].id, 'dsh-jina-low-balance-style')
  assert.match(shared.styles[0].textContent, /@keyframes dsh-jina-low-balance-flash/)
  assert.match(shared.styles[0].textContent, /prefers-reduced-motion/, 'the pulse is skipped when motion is reduced')
  assert.match(shared.styles[0].textContent, /\.dsh-jina-low-balance/, 'and every rule is scoped by the box class')

  // A second mount in the same page (same document) must not inject again.
  const second = bootReminder(ledger(800000, 1750000000000), new Map(), shared)
  await second.settle()
  assert.equal(shared.styles.length, 1, 'a remount must not stack a second copy')
})

test('reminder: a dismissal hides it, survives a reload, and re-arms after a top-up', async () => {
  const storage = new Map()
  const first = bootReminder(ledger(987654, 0), storage)
  await first.settle()
  assert.equal(first.visible(), true)

  const dismiss = first.button('知道了')
  assert.ok(dismiss !== undefined, 'the notice must offer a dismissal')
  dismiss.props.onClick()
  first.runtime.flush()
  assert.equal(first.visible(), false, 'dismissing hides the notice')
  assert.equal(storage.size, 1, 'and latches the dismissal')

  await first.poll()
  assert.equal(first.visible(), false, 'a later read must not resurrect a dismissed notice')

  // A reload is a fresh component over the same storage.
  const second = bootReminder(ledger(900000, 0), storage)
  await second.settle()
  assert.equal(second.visible(), false, 'the dismissal must survive a reload')

  // A top-up above the threshold re-arms it...
  second.answer(ledger(5000000, 0))
  await second.poll()
  assert.equal(second.visible(), false)
  assert.equal(storage.size, 0, 'recovering above the threshold clears the latch')
  // ...so a later drop warns again.
  second.answer(ledger(800000, 0))
  await second.poll()
  assert.equal(second.visible(), true, 'a later drop must warn again')
})

test('reminder: "no balance fact" is never treated as a breach, and a failed read changes nothing', async () => {
  // No key pool at all: the host reports no total, so there is nothing to run
  // out of and nothing to warn about.
  const empty = bootReminder(ledger(null, 0))
  await empty.settle()
  assert.equal(empty.visible(), false, 'a pool with no total must not warn')

  // A transport failure must leave the last known state alone rather than flip
  // it: an offline moment is not evidence that the credits came back.
  const low = bootReminder(ledger(800000, 0))
  await low.settle()
  assert.equal(low.visible(), true)
  low.fail()
  await low.poll()
  assert.equal(low.visible(), true, 'a failed read must keep the notice it already had')

  // ...and a later good read still shows it, so the failure did not latch.
  low.answer(ledger(700000, 0))
  await low.poll()
  assert.equal(low.visible(), true)

  // The read is registered once, on the interval, and torn down with the entry.
  assert.equal(low.intervals.length, 1, 'exactly one read loop')
  low.runtime.unmount()
})

test('reminder: a stored override lets the notice be triggered live, and removing it restores the constant', async () => {
  // This is the README's manual trigger: put a number above the current pool
  // total in the profile, reload, and the notice appears — no bundle edit, so
  // the shipped default and the test that pins it both stay intact.
  const storage = new Map([['dsh-jina:low-balance-threshold', '20000000']])
  const boot = bootReminder(ledger(18168993, 0), storage)
  await boot.settle()
  assert.equal(boot.visible(), true, 'the override must raise the threshold for this profile')
  assert.deepEqual(boot.paragraphs(),
    ['Jina Tools', '该插件可用点数少于 20,000,000，请注意补充。', '当前还有 18,168,993。'],
    'and the copy must name the override actually in force')

  storage.delete('dsh-jina:low-balance-threshold')
  const restored = bootReminder(ledger(18168993, 0), storage)
  await restored.settle()
  assert.equal(restored.visible(), false, 'without the override the shipped threshold applies again')
})

test('reminder: a malformed override is ignored, never silently disabling the reminder', async () => {
  // A typo in the console must not turn the reminder off: a bad value falls
  // back to the shipped constant, which still warns at 800k.
  for (const bad of ['', 'abc', '0', '-5', 'NaN', 'Infinity']) {
    const storage = new Map([['dsh-jina:low-balance-threshold', bad]])
    const boot = bootReminder(ledger(800000, 0), storage)
    await boot.settle()
    assert.equal(boot.visible(), true, `a stored threshold of "${bad}" must not disable the reminder`)
  }
})
