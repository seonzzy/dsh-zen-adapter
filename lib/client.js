/**
 * Client half: the "获取模型" panel on this plugin's page.
 *
 * Two seats, both official slots:
 *
 *   `plugins.bundle.config` (keyed by package name)
 *     the model list, rendered on the bundle's own page between its
 *     description and its rows.
 *
 * The button lives in the same component rather than in
 * `plugins.detail.actions`, because that slot renders at the head of a detail
 * page where a list below it would be out of the reader's view — a button and
 * the table it fills belong together, and this keeps both behind one
 * registration.
 *
 * The catalogue is fetched from the host bridge (`/api/dsh-zen-adapter/*`);
 * a browser half cannot reach `opencode.ai` with the CLI disguise itself, nor
 * read the host's cache.
 */

window.__ModuleLoader__.load({
  id: 'dsh-zen-adapter',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    let react = require('react')
    let jsx = require('react/jsx-runtime')

    const BRIDGE = '/api/dsh-zen-adapter'

    // Inline styles: a plugin page has no build step here, and a stylesheet
    // injected at runtime would need its own teardown on unload.
    const S = {
      wrap: { display: 'flex', flexDirection: 'column', gap: 10, marginTop: 4 },
      bar: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
      btn: {
        font: 'inherit', padding: '5px 12px', borderRadius: 6,
        border: '1px solid rgba(127,127,127,.45)', background: 'transparent',
        color: 'inherit', cursor: 'pointer',
      },
      btnBusy: { opacity: 0.55, cursor: 'default' },
      meta: { opacity: 0.65, fontSize: 12 },
      err: { color: '#d4380d', fontSize: 12, whiteSpace: 'pre-wrap' },
      table: { width: '100%', borderCollapse: 'collapse', fontSize: 12 },
      th: { textAlign: 'left', fontWeight: 600, opacity: 0.7, padding: '4px 8px', borderBottom: '1px solid rgba(127,127,127,.3)' },
      td: { padding: '4px 8px', borderBottom: '1px solid rgba(127,127,127,.14)', verticalAlign: 'top' },
      mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' },
      ctx: { fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' },
      good: { color: '#389e0d', whiteSpace: 'nowrap' },
      bad: { color: '#d4380d', whiteSpace: 'nowrap' },
      unknown: { opacity: 0.5, whiteSpace: 'nowrap' },
    }

    async function call(path, body) {
      const res = await fetch(`${BRIDGE}/${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      })
      const json = await res.json().catch(() => null)
      if (json === null) throw new Error(`bridge ${path} returned a non-JSON reply (HTTP ${res.status})`)
      if (json.ok === false) throw new Error(json.message ?? json.code ?? `bridge ${path} failed`)
      return json.value
    }

    /** 1048576 -> "1M", 262144 -> "256K". */
    function formatContext(n) {
      if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return '—'
      if (n >= 1000000) {
        const m = n / 1048576
        return `${m >= 10 ? Math.round(m) : m.toFixed(m % 1 === 0 ? 0 : 1)}M`
      }
      if (n >= 1000) return `${Math.round(n / 1024)}K`
      return String(n)
    }

    function reachCell(row) {
      if (row.reachable === true) return jsx.jsx('span', { style: S.good, children: '✓ 可用' })
      if (row.reachable === false) {
        const why = row.probeStatus ? `${row.probeStatus}${row.probeDetail ? ` ${row.probeDetail}` : ''}` : '不可用'
        return jsx.jsx('span', { style: S.bad, title: why, children: `✕ ${row.probeStatus ?? '—'}` })
      }
      return jsx.jsx('span', { style: S.unknown, children: '未检测' })
    }

    function ZenCatalogPanel() {
      const [state, setState] = react.useState({ phase: 'idle', value: null, error: null })
      const busy = state.phase === 'loading' || state.phase === 'probing'

      const run = react.useCallback(async (what) => {
        setState({ phase: what === 'probe' ? 'probing' : 'loading', value: state.value, error: null })
        try {
          const value = await call(what === 'probe' ? 'probe' : 'refresh')
          setState({ phase: 'idle', value, error: null })
        } catch (error) {
          setState({ phase: 'idle', value: state.value, error: String(error?.message ?? error) })
        }
      }, [state.value])

      // Show whatever the host already has, without spending an upstream call.
      react.useEffect(() => {
        let alive = true
        call('list')
          .then((value) => { if (alive) setState((s) => (s.value === null ? { phase: 'idle', value, error: null } : s)) })
          .catch(() => {})
        return () => { alive = false }
      }, [])

      const value = state.value
      const rows = value?.models ?? []

      const header = jsx.jsxs('div', {
        style: S.bar,
        children: [
          jsx.jsx('button', {
            type: 'button',
            style: busy ? { ...S.btn, ...S.btnBusy } : S.btn,
            disabled: busy,
            onClick: () => run('refresh'),
            children: state.phase === 'loading' ? '获取中…' : '获取模型',
          }),
          jsx.jsx('button', {
            type: 'button',
            style: busy || rows.length === 0 ? { ...S.btn, ...S.btnBusy } : S.btn,
            disabled: busy || rows.length === 0,
            onClick: () => run('probe'),
            children: state.phase === 'probing' ? '检测中…' : '检测可用性',
          }),
          value
            ? jsx.jsx('span', {
                style: S.meta,
                children: `免费 ${value.free} / 在售 ${value.total}${value.fetchedAt ? ` · ${new Date(value.fetchedAt).toLocaleTimeString()}` : ''}${value.stale ? ' · 缓存' : ''}`,
              })
            : null,
        ],
      })

      if (state.error !== null) {
        return jsx.jsxs('div', { style: S.wrap, children: [header, jsx.jsx('div', { style: S.err, children: state.error })] })
      }

      if (rows.length === 0) {
        return jsx.jsxs('div', {
          style: S.wrap,
          children: [header, jsx.jsx('div', { style: S.meta, children: state.phase === 'idle' ? '还没有数据，点「获取模型」从 opencode.ai 拉取。' : '正在加载…' })],
        })
      }

      const body = jsx.jsxs('table', {
        style: S.table,
        children: [
          jsx.jsx('thead', {
            children: jsx.jsxs('tr', {
              children: [
                jsx.jsx('th', { style: S.th, children: '模型' }),
                jsx.jsx('th', { style: S.th, children: '上下文' }),
                jsx.jsx('th', { style: S.th, children: '输出上限' }),
                jsx.jsx('th', { style: S.th, children: '状态' }),
                jsx.jsx('th', { style: S.th, children: '判定依据' }),
              ],
            }),
          }),
          jsx.jsx('tbody', {
            children: rows.map((row) =>
              jsx.jsxs('tr', {
                children: [
                  jsx.jsx('td', { style: { ...S.td, ...S.mono }, children: row.id }),
                  jsx.jsx('td', { style: { ...S.td, ...S.ctx }, title: row.context ? `${row.context} tokens` : '未知', children: formatContext(row.context) }),
                  jsx.jsx('td', { style: { ...S.td, ...S.ctx }, children: formatContext(row.maxOutput) }),
                  jsx.jsx('td', { style: S.td, children: reachCell(row) }),
                  jsx.jsx('td', { style: { ...S.td, opacity: 0.65 }, children: row.reason }),
                ],
              }, row.id),
            ),
          }),
        ],
      })

      return jsx.jsxs('div', { style: S.wrap, children: [header, body] })
    }

    const inject = ['slots']

    function apply(ctx) {
      // The bundle's own page, keyed by the package name the profile installs.
      ctx.slots.inject('plugins.bundle.config', () =>
        ctx.slots.register({ name: 'plugins.bundle.config', key: 'dsh-zen-adapter' }, () => jsx.jsx(ZenCatalogPanel, {})),
      )
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
