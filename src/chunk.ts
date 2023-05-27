import {Text, ChangeDesc, StateField, StateEffect} from "@codemirror/state"
import {Change, presentableDiff} from "./diff"

const limit = {scanLimit: 500}

/// A chunk describes a range of lines which have changed content in
/// them. Either side (a/b) may either be empty (when its `to` is
/// equal to its `from`), or points at a range starting at the start
/// of the first changed line, to 1 past the end of the last changed
/// line. Note that `to` positions may point past the end of the
/// document. Use `endA`/`endB` if you need an end position that is
/// certain to be a valid document position.
export class Chunk {
  constructor(
    /// The individual changes inside this chunk. These are stored
    /// relative to the start of the chunk, so you have to add
    /// `chunk.fromA`/`fromB` to get document positions.
    readonly changes: readonly Change[],
    /// The start of the chunk in document A.
    readonly fromA: number,
    /// The end of the chunk in document A. This is equal to `fromA`
    /// when the chunk covers no lines in document A, or is one unit
    /// past the end of the last line in the chunk if it does.
    readonly toA: number,
    /// The start of the chunk in document B.
    readonly fromB: number,
    /// The end of the chunk in document A.
    readonly toB: number,
  ) {}

  /// @internal
  offset(offA: number, offB: number) {
    return offA || offB
      ? new Chunk(this.changes, this.fromA + offA, this.toA + offA, this.fromB + offB, this.toB + offB)
      : this
  }

  /// Returns `fromA` if the chunk is empty in A, or the end of the
  /// last line in the chunk otherwise.
  get endA() { return Math.max(this.fromA, this.toA - 1) }
  /// Returns `fromB` if the chunk is empty in B, or the end of the
  /// last line in the chunk otherwise.
  get endB() { return Math.max(this.fromB, this.toB - 1) }

  /// Build a set of changed chunks for the given documents.
  static build(a: Text, b: Text): readonly Chunk[] {
    return toChunks(presentableDiff(a.toString(), b.toString(), limit), a, b, 0, 0)
  }

  /// Update a set of chunks for changes in document A. `a` should
  /// hold the updated document A.
  static updateA(chunks: readonly Chunk[], a: Text, b: Text, changes: ChangeDesc) {
    return updateChunks(findRangesForChange(chunks, changes, true, b.length), chunks, a, b)
  }

  /// Update a set of chunks for changes in document B.
  static updateB(chunks: readonly Chunk[], a: Text, b: Text, changes: ChangeDesc) {
    return updateChunks(findRangesForChange(chunks, changes, false, a.length), chunks, a, b)
  }
}

function fromLine(fromA: number, fromB: number, a: Text, b: Text) {
  let lineA = a.lineAt(fromA), lineB = b.lineAt(fromB)
  return lineA.to == fromA && lineB.to == fromB && fromA < a.length && fromB < b.length
    ? [fromA + 1, fromB + 1] : [lineA.from, lineB.from]
}

function toLine(toA: number, toB: number, a: Text, b: Text) {
  let lineA = a.lineAt(toA), lineB = b.lineAt(toB)
  return lineA.from == toA && lineB.from == toB ? [toA, toB] : [lineA.to + 1, lineB.to + 1]
}

function toChunks(changes: readonly Change[], a: Text, b: Text, offA: number, offB: number) {
  let chunks = []
  for (let i = 0; i < changes.length; i++) {
    let change = changes[i]
    let [fromA, fromB] = fromLine(change.fromA + offA, change.fromB + offB, a, b)
    let [toA, toB] = toLine(change.toA + offA, change.toB + offB, a, b)
    let chunk = [change.offset(-fromA + offA, -fromB + offB)]
    chunks.push(new Chunk(chunk, fromA, Math.max(fromA, toA), fromB, Math.max(fromB, toB)))
  }
  return chunks
}

const updateMargin = 1000

type UpdateRange = {fromA: number, toA: number, fromB: number, toB: number, diffA: number, diffB: number}

// Finds the given position in the chunks. Returns the extent of the
// chunk it overlaps with if it overlaps, or a position corresponding
// to that position on both sides otherwise.
function findPos(
  chunks: readonly Chunk[], pos: number, isA: boolean, start: boolean
): [number, number] {
  let lo = 0, hi = chunks.length
  for (;;) {
    if (lo == hi) {
      let refA = 0, refB = 0
      if (lo) ({toA: refA, toB: refB} = chunks[lo - 1])
      let off = pos - (isA ? refA : refB)
      return [refA + off, refB + off]
    }
    let mid = (lo + hi) >> 1, chunk = chunks[mid]
    let [from, to] = isA ? [chunk.fromA, chunk.toA] : [chunk.fromB, chunk.toB]
    if (from > pos) hi = mid
    else if (to <= pos) lo = mid + 1
    else return start ? [chunk.fromA, chunk.fromB] : [chunk.toA, chunk.toB]
  }
}

function findRangesForChange(chunks: readonly Chunk[], changes: ChangeDesc, isA: boolean, otherLen: number) {
  let ranges: UpdateRange[] = []
  changes.iterChangedRanges((cFromA, cToA, cFromB, cToB) => {
    let fromA = 0, toA = isA ? changes.length : otherLen
    let fromB = 0, toB = isA ? otherLen : changes.length
    if (cFromA > updateMargin)
      [fromA, fromB] = findPos(chunks, cFromA - updateMargin, isA, true)
    if (cToA < changes.length - updateMargin)
      [toA, toB] = findPos(chunks, cToA + updateMargin, isA, false)
    let lenDiff = (cToB - cFromB) - (cToA - cFromA), last
    let [diffA, diffB] = isA ? [lenDiff, 0] : [0, lenDiff]
    if (ranges.length && (last = ranges[ranges.length - 1]).toA >= fromA)
      ranges[ranges.length - 1] = {fromA: last.fromA, fromB: last.fromB, toA, toB,
                                   diffA: last.diffA + diffA, diffB: last.diffB + diffB}
    else
      ranges.push({fromA, toA, fromB, toB, diffA, diffB})
  })
  return ranges
}

function updateChunks(ranges: readonly UpdateRange[], chunks: readonly Chunk[], a: Text, b: Text): readonly Chunk[] {
  if (!ranges.length) return chunks
  let chunkI = 0, offA = 0, offB = 0
  let result = []
  for (let range of ranges) {
    let fromA = range.fromA + offA, toA = range.toA + offA + range.diffA
    let fromB = range.fromB + offB, toB = range.toB + offB + range.diffB

    while (chunkI < chunks.length) {
      let next = chunks[chunkI]
      if (next.toA + offA <= fromA && next.toB + offB <= fromB) result.push(next.offset(offA, offB))
      else if (next.fromA + offA > toA) break
      chunkI++
    }
    for (let chunk of toChunks(presentableDiff(a.sliceString(fromA, toA), b.sliceString(fromB, toB), limit),
                               a, b, fromA, fromB))
      result.push(chunk)
    offA += range.diffA
    offB += range.diffB
  }
  while (chunkI < chunks.length)
    result.push(chunks[chunkI++].offset(offA, offB))
  return result
}

export const setChunks = StateEffect.define<readonly Chunk[]>()

export const ChunkField = StateField.define<readonly Chunk[]>({
  create(state) {
    return null as any
  },
  update(current, tr) {
    for (let e of tr.effects) if (e.is(setChunks)) current = e.value
    return current
  }
})
