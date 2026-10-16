import assert from "node:assert/strict"
import test from "node:test"

import { isTransientAppleServiceFailure } from "../scripts/apple-notary-retry.js"

test("Apple notarization retry only treats network/service failures as transient", () => {
  assert.equal(
    isTransientAppleServiceFailure('NSURLErrorDomain Code=-1001 "The request timed out."'),
    true
  )
  assert.equal(
    isTransientAppleServiceFailure(
      'NSURLErrorDomain Code=-1005 "The network connection was lost." CloudKit\'s response is inconsistent'
    ),
    true
  )
  assert.equal(isTransientAppleServiceFailure("HTTPError(statusCode: nil, error: timeout)"), true)
  assert.equal(isTransientAppleServiceFailure("The signature of the binary is invalid."), false)
})
