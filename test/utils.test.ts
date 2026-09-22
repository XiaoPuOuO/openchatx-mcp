import assert from "node:assert/strict"
import test from "node:test"

import {
  asRecord,
  booleanValue,
  finiteNumber,
  nonNegativeInteger,
  positiveInteger,
  utf8Chunk,
  utf8Prefix,
} from "../src/utils.js"

test("positiveInteger defaults only missing values", () => {
  assert.equal(positiveInteger(undefined, 4), 4)
  assert.equal(positiveInteger(2, 4), 2)

  for (const value of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => positiveInteger(value, 4), /Expected a positive integer/u)
  }
})

test("nonNegativeInteger defaults only missing values", () => {
  assert.equal(nonNegativeInteger(undefined, 4), 4)
  assert.equal(nonNegativeInteger(0, 4), 0)
  assert.equal(nonNegativeInteger(2, 4), 2)

  for (const value of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => nonNegativeInteger(value, 4), /Expected a non-negative integer/u)
  }
})

test("extracts common JSON value types", () => {
  const record = { value: 1 }
  assert.equal(asRecord(record), record)
  assert.equal(asRecord([]), undefined)
  assert.equal(asRecord(null), undefined)
  assert.equal(finiteNumber(1.5), 1.5)
  assert.equal(finiteNumber(Number.POSITIVE_INFINITY), undefined)
  assert.equal(booleanValue(false), false)
  assert.equal(booleanValue(0), undefined)
})

test("bounds UTF-8 chunks without splitting surrogate pairs", () => {
  const value = "a🙂b"
  assert.deepEqual(utf8Chunk(value, 0, 4), { value: "a", nextOffset: 1 })
  assert.deepEqual(utf8Chunk(value, 1, 4), { value: "🙂", nextOffset: 3 })
  assert.deepEqual(utf8Prefix(value, 5), { value: "a🙂", omittedBytes: 1 })
})
