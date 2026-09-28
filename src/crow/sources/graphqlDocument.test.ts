import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { parseDocument, printDocument, sortDocument, withTypename } from './graphqlDocument';

// A document of every construct the module reads; the hash and the print are graphql-js 14's for the same steps
const SOURCE =
  'query gameSearch($size: Int = 24, $term: String!, $filters: [FilterInput!]) @cached(ttl: 60) {\n' +
  '  search(term: $term, first: $size, filters: $filters, sort: {by: RELEASE, order: "desc\\n"}) {\n' +
  '    total: count\n' +
  '    items @include(if: true) {\n' +
  '      ... on Game { id title platforms(kind: [PS5, PS4]) }\n' +
  '      ...priceFields @defer(label: "p")\n' +
  '    }\n' +
  '  }\n' +
  '}\n' +
  'fragment priceFields on Product @b @a(z: 1, y: -2.5e3) { price { base discounted } name }';

const PRINTED = `fragment priceFields on Product @a(y: -2.5e3, z: 1) @b {
  __typename
  name
  price {
    __typename
    base
    discounted
  }
}

query gameSearch($filters: [FilterInput!], $size: Int = 24, $term: String!) @cached(ttl: 60) {
  search(filters: $filters, first: $size, sort: {by: RELEASE, order: "desc\\n"}, term: $term) {
    __typename
    total: count
    items @include(if: true) {
      __typename
      ...priceFields @defer(label: "p")
      ... on Game {
        __typename
        id
        platforms(kind: [PS5, PS4])
        title
      }
    }
  }
}
`;

describe('graphqlDocument', () => {
  it('prints a document typed and sorted exactly as graphql-js 14 does, to its hash', () => {
    const printed = printDocument(sortDocument(withTypename(parseDocument(SOURCE))));
    assert.equal(printed, PRINTED);
    assert.equal(createHash('sha256').update(printed).digest('hex'), '4c285c91692bb7408b130cc56fbdfbd8e0a09969dc6879d531f898d563d1a789');
  });

  it('prints an anonymous query in its short form, and adds no __typename where a meta field is asked', () => {
    assert.equal(printDocument(parseDocument('{ a { __typename b } }')), '{\n  a {\n    __typename\n    b\n  }\n}\n');
    assert.equal(printDocument(withTypename(parseDocument('{ a { __schema b } }'))), '{\n  a {\n    __schema\n    b\n  }\n}\n');
  });

  it('refuses what it does not read: the type system and block strings', () => {
    assert.throws(() => parseDocument('type Game { id: ID }'), /no executable definition/);
    assert.throws(() => parseDocument('{ a(b: """x""") }'), /block strings/);
    assert.throws(() => parseDocument('{ a('), /end of the document|expected/);
  });
});
