import {EditorView, Decoration, DecorationSet, ViewPlugin, ViewUpdate,
        WidgetType, GutterMarker, gutter} from "@codemirror/view"
import {EditorState, RangeSetBuilder, Text, StateField, StateEffect, RangeSet, Facet, Prec} from "@codemirror/state"
import {Chunk, ChunkField} from "./chunk"

type Config = {
  sibling?: () => EditorView,
  highlightChanges: boolean,
  markGutter: boolean,
  syntaxHighlightDeletions?: boolean,
  mergeControls?: boolean,
  side: "a" | "b"
}

export const mergeConfig = Facet.define<Config, Config>({
  combine: values => values[0]
})

export const decorateChunks = ViewPlugin.fromClass(class {
  deco: DecorationSet
  gutter: RangeSet<GutterMarker> | null

  constructor(view: EditorView) {
    ({deco: this.deco, gutter: this.gutter} = getChunkDeco(view))
  }

  update(update: ViewUpdate) {
    if (update.docChanged || update.viewportChanged || chunksChanged(update.startState, update.state) ||
        configChanged(update.startState, update.state))
      ({deco: this.deco, gutter: this.gutter} = getChunkDeco(update.view))
  }
}, {
  decorations: d => d.deco
})

export const changeGutter = Prec.low(gutter({
  class: "cm-changeGutter",
  markers: view => view.plugin(decorateChunks)?.gutter || RangeSet.empty
}))

function chunksChanged(s1: EditorState, s2: EditorState) {
  return s1.field(ChunkField, false) != s2.field(ChunkField, false)
}

function configChanged(s1: EditorState, s2: EditorState) {
  return s1.facet(mergeConfig) != s2.facet(mergeConfig)
}

const changedLine = Decoration.line({class: "cm-changedLine"})
const changedText = Decoration.mark({class: "cm-changedText"})
const inserted = Decoration.mark({tagName: "ins"}), deleted = Decoration.mark({tagName: "del"})

const changedLineGutterMarker = new class extends GutterMarker {
  elementClass = "cm-changedLineGutter"
}

function buildChunkDeco(chunk: Chunk, doc: Text, isA: boolean, highlight: boolean,
                        builder: RangeSetBuilder<Decoration>,
                        gutterBuilder: RangeSetBuilder<GutterMarker> | null) {
  let from = chunk.fromB
  let to = chunk.toB
  let changeI = 0
  if (from != to) {
    builder.add(from, from, changedLine)
    builder.add(from, to, isA ? deleted : inserted)
    if (gutterBuilder) gutterBuilder.add(from, from, changedLineGutterMarker)
    for (let iter = doc.iterRange(from, to - 1), pos = from; !iter.next().done;) {
      if (iter.lineBreak) {
        pos++
        builder.add(pos, pos, changedLine)
        if (gutterBuilder) gutterBuilder.add(pos, pos, changedLineGutterMarker)
        continue
      }
      let lineEnd = pos + iter.value.length
      if (highlight) while (changeI < chunk.changes.length) {
        let nextChange = chunk.changes[changeI]
        let nextFrom = from + (isA ? nextChange.fromA : nextChange.fromB)
        let nextTo = from + (isA ? nextChange.toA : nextChange.toB)
        let chFrom = Math.max(pos, nextFrom), chTo = Math.min(lineEnd, nextTo)
        if (chFrom < chTo) builder.add(chFrom, chTo, changedText)
        if (nextTo < lineEnd) changeI++
        else break
      }
      pos = lineEnd
    }
  }
}

function getChunkDeco(view: EditorView) {
  let chunks = view.state.field(ChunkField)
  let {side, highlightChanges, markGutter} = view.state.facet(mergeConfig), isA = side == "a"
  let builder = new RangeSetBuilder<Decoration>()
  let gutterBuilder = markGutter ? new RangeSetBuilder<GutterMarker>() : null
  let {from, to} = view.viewport
  for (let chunk of chunks) {
    if ((isA ? chunk.fromA : chunk.fromB) >= to) break
    if ((isA ? chunk.toA : chunk.toB) > from)
      buildChunkDeco(chunk, view.state.doc, isA, highlightChanges, builder, gutterBuilder)
  }
  return {deco: builder.finish(), gutter: gutterBuilder && gutterBuilder.finish()}
}

class Spacer extends WidgetType {
  constructor(readonly height: number) { super() }

  eq(other: Spacer) { return this.height == other.height }

  toDOM() {
    let elt = document.createElement("div")
    elt.className = "cm-mergeSpacer"
    elt.style.height = this.height + "px"
    return elt
  }

  updateDOM(dom: HTMLElement) {
    dom.style.height = this.height + "px"
    return true
  }

  get estimatedHeight() { return this.height }

  ignoreEvent() { return false }
}

export const adjustSpacers = StateEffect.define<DecorationSet>({
  map: (value, mapping) => value.map(mapping)
})

export const Spacers = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update: (spacers, tr) => {
    for (let e of tr.effects) if (e.is(adjustSpacers)) return e.value
    return spacers.map(tr.changes)
  },
  provide: f => EditorView.decorations.from(f)
})

const epsilon = .0001

export function updateSpacers(a: EditorView, b: EditorView, chunks: readonly Chunk[]) {
  let buildA = new RangeSetBuilder<Decoration>(), buildB = new RangeSetBuilder<Decoration>()
  let linesA = a.viewportLineBlocks, linesB = b.viewportLineBlocks, iA = 0, iB = 0
  let spacersA = a.state.field(Spacers).iter(), spacersB = b.state.field(Spacers).iter()
  let posA = 0, posB = 0, offA = 0, offB = 0
  chunks: for (let chunkI = 0;; chunkI++) {
    let chunk = chunkI < chunks.length ? chunks[chunkI] : null
    let [endA, endB] = chunk ? [chunk.fromA, chunk.fromB] : [a.state.doc.length, b.state.doc.length]
    // Find lines whose start lies in the unchanged pos-end ranges and
    // who have a matching line in the other editor.
    if (posA < endA && posB < endB) for (;;) {
      if (iA == linesA.length || iB == linesB.length) break chunks
      let lineA = linesA[iA], lineB = linesB[iB]
      while (spacersA.value && spacersA.from < lineA.from) {
        offA -= (spacersA.value.spec.widget as any).height
        spacersA.next()
      }
      while (spacersB.value && spacersB.from < lineB.from) {
        offB -= (spacersB.value.spec.widget as any).height
        spacersB.next()
      }
      if (lineA.from >= endA || lineB.from >= endB) break
      let relA = lineA.from - posA, relB = lineB.from - posB
      if (relA < 0 || relA < relB) {
        iA++
      } else if (relB < 0 || relB < relA) {
        iB++
      } else { // Align these two lines
        let diff = (lineA.top + offA) - (lineB.top + offB)
        if (diff < -epsilon) {
          offA -= diff
          buildA.add(lineA.from, lineA.from, Decoration.widget({
            widget: new Spacer(-diff),
            block: true,
            side: -1
          }))
        } else if (diff > epsilon) {
          offB += diff
          buildB.add(lineB.from, lineB.from, Decoration.widget({
            widget: new Spacer(diff),
            block: true,
            side: -1
          }))
        }
        iA++; iB++
      }
    }
    if (!chunk) break
    posA = chunk.toA; posB = chunk.toB
  }
  while (spacersA.value) {
    offA -= (spacersA.value.spec.widget as any).height
    spacersA.next()
  }
  while (spacersB.value) {
    offB -= (spacersB.value.spec.widget as any).height
    spacersB.next()
  }
  let docDiff = (a.contentHeight + offA) - (b.contentHeight + offB)
  if (docDiff < epsilon) buildA.add(a.state.doc.length, a.state.doc.length, Decoration.widget({
    widget: new Spacer(-docDiff),
    block: true,
    side: 1
  }))
  else if (docDiff > epsilon) buildB.add(b.state.doc.length, b.state.doc.length, Decoration.widget({
    widget: new Spacer(docDiff),
    block: true,
    side: 1
  }))

  let decoA = buildA.finish(), decoB = buildB.finish()
  if (!RangeSet.eq([decoA], [a.state.field(Spacers)]))
    a.dispatch({effects: adjustSpacers.of(decoA)})
  if (!RangeSet.eq([decoB], [b.state.field(Spacers)]))
    b.dispatch({effects: adjustSpacers.of(decoB)})
}

const uncollapse = StateEffect.define<number>({
  map: (value, change) => change.mapPos(value)
})

class CollapseWidget extends WidgetType {
  constructor(readonly lines: number) { super() }

  eq(other: CollapseWidget) { return this.lines == other.lines }

  toDOM(view: EditorView) {
    let outer = document.createElement("div")
    outer.className = "cm-collapsedLines"
    outer.textContent = "⦚ " + view.state.phrase("$ unchanged lines", this.lines) + " ⦚"
    outer.addEventListener("click", e => {
      let pos = view.posAtDOM(e.target as HTMLElement)
      view.dispatch({effects: uncollapse.of(pos)})
      let {side, sibling} = view.state.facet(mergeConfig)
      if (sibling) sibling().dispatch({effects: uncollapse.of(mapPos(pos, view.state.field(ChunkField), side == "a"))})
    })
    return outer
  }

  ignoreEvent(e: Event) { return e instanceof MouseEvent }

  get estimatedHeight() { return 27 }
}

function mapPos(pos: number, chunks: readonly Chunk[], isA: boolean) {
  let startOur = 0, startOther = 0
  for (let i = 0;; i++) {
    let next = i < chunks.length ? chunks[i] : null
    if (!next || (isA ? next.fromA : next.fromB) >= pos) return startOther + (pos - startOur)
    ;[startOur, startOther] = isA ? [next.toA, next.toB] : [next.toB, next.toA]
  }
}

const CollapsedRanges = StateField.define<DecorationSet>({
  create(state) { return Decoration.none },
  update(deco, tr) {
    deco = deco.map(tr.changes)
    for (let e of tr.effects) if (e.is(uncollapse))
      deco = deco.update({filter: from => from != e.value})
    return deco
  },
  provide: f => EditorView.decorations.from(f)
})

export function collapseUnchanged({margin = 3, minSize = 4}: {margin?: number, minSize?: number}) {
  return CollapsedRanges.init(state => buildCollapsedRanges(state, margin, minSize))
}

function buildCollapsedRanges(state: EditorState, margin: number, minLines: number) {
  let builder = new RangeSetBuilder<Decoration>()
  let isA = state.facet(mergeConfig).side == "a"
  let chunks = state.field(ChunkField)
  let prevLine = 1
  for (let i = 0;; i++) {
    let chunk = i < chunks.length ? chunks[i] : null
    let collapseFrom = i ? prevLine + margin : 1
    let collapseTo = chunk ? state.doc.lineAt(isA ? chunk.fromA : chunk.fromB).number - 1 - margin : state.doc.lines
    let lines = collapseTo - collapseFrom + 1
    if (lines >= minLines) {
      builder.add(state.doc.line(collapseFrom).from, state.doc.line(collapseTo).to, Decoration.replace({
        widget: new CollapseWidget(lines),
        block: true
      }))
    }
    if (!chunk) break
    prevLine = state.doc.lineAt(Math.min(state.doc.length, isA ? chunk.toA : chunk.toB)).number
  }
  return builder.finish()
}
